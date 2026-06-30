import { Injectable, Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { MongoService } from '../mongo.service';
import { BotService } from '../bot/bot.service';
import { GeminiLiveAuthService } from './gemini-live-auth.service';
import {
  GeminiLiveConfig,
  GeminiLiveSessionWrapper,
} from './gemini-live-session.wrapper';
import { ResponseSpeed, getResponseSpeedPreset } from './response-speed';
import {
  calculateDbfs,
  decodeUlawToPcm16,
  resamplePcm16,
  transcodePcm24kToUlaw8k,
} from './audio-codec';

// Milliseconds of sustained above-gate audio required before caller audio is
// treated as real speech. Lower = snappier turn-taking and barge-in; higher =
// more robust against brief noise blips on a noisy phone line. Kept above the
// ~100ms noise floor so short transients (clicks, coughs) don't trigger a turn.
const SPEECH_ONSET_VALIDATION_MS = 150;
// While the agent is speaking, require this much sustained speech before we
// treat it as a real interruption. Short sounds ("mm-hmm", "right", a cough)
// stay below it and are ignored as backchannels instead of cutting the agent off.
const BACKCHANNEL_INTERRUPT_MS = 400;
// Automatic-mode fallback: reset local speech tracking after this much silence.
const AUTOMATIC_SILENCE_RESET_MS = 1500;
// Adaptive noise gate: the effective gate sits this many dB above the measured
// background noise floor, clamped to a band around the configured preset gate so
// a noisy line rejects more without a quiet line becoming trigger-happy.
const NOISE_GATE_MARGIN_DB = 10;
const NOISE_GATE_MAX_RAISE_DB = 12;
const NOISE_FLOOR_EMA_ALPHA = 0.05;
// Extra gate raise while the agent is speaking, so its own voice echoing back
// through the contact's handset is less likely to be heard as an interruption.
const ECHO_SUPPRESSION_DB = 6;
// Hard ceiling on call length and how long of a silence triggers a re-prompt.
const MAX_CALL_DURATION_MS = 10 * 60 * 1000;
const INACTIVITY_TIMEOUT_MS = 15000;
const MAX_INACTIVITY_STRIKES = 2;
// fetch_context must not stall the call: fall back to empty context after this.
const FETCH_CONTEXT_TIMEOUT_MS = 4000;
// Safety net so a stuck call cannot burn tokens forever (native audio is
// token-heavy, so this is a high ceiling, not a normal-case limiter).
const MAX_CALL_TOKENS = Number(process.env.GEMINI_MAX_CALL_TOKENS || 600000);
// At most one automatic reconnect if the Gemini socket drops mid-call.
const MAX_RECONNECT_ATTEMPTS = 1;

type TwilioFrame = {
  event?: string;
  streamSid?: string;
  start?: {
    streamSid?: string;
    callSid?: string;
    customParameters?: Record<string, string>;
  };
  media?: { payload?: string };
  stop?: Record<string, unknown>;
};

type ActiveCallSession = {
  callId: string;
  streamSid?: string;
  providerCallSid?: string;
  call?: any;
  campaign?: any;
  contact?: any;
  gemini?: GeminiLiveSessionWrapper;
  userTurns: number;
  assistantTurns: number;
  pendingHangup: boolean;
  endCallReason?: string;
  completed: boolean;
  preventInterruption: boolean;
  assistantAudioActive: boolean;
  outboundAudioLogged: boolean;
  responseSpeed: ResponseSpeed;
  noiseGateDbfs: number;
  noiseSuppressedFrames: number;
  manualActivityActive: boolean;
  manualAudioMs: number;
  manualLastSpeechAudioMs?: number;
  setupStartedAt?: number;
  setupCompletedAt?: number;
  lastUserTranscriptAt?: number;
  awaitingModelAudioAfterUser: boolean;
  scriptWriteTail: Promise<void>;
  speechActive: boolean;
  speechDetectionMs: number;
  speechBuffer: Buffer[];
  noiseFloorDbfs: number;
  ws?: WebSocket;
  geminiConfig?: GeminiLiveConfig;
  preparePromise?: Promise<void>;
  reconnectAttempts: number;
  callActive: boolean;
  cleanedUp: boolean;
  lastActivityAt: number;
  inactivityStrikes: number;
  inactivityTimer?: NodeJS.Timeout;
  maxCallTimer?: NodeJS.Timeout;
};

@Injectable()
export class RealtimeCallingGateway {
  private readonly logger = new Logger(RealtimeCallingGateway.name);
  private readonly sessions = new Map<string, ActiveCallSession>();

  constructor(
    private readonly db: MongoService,
    private readonly botService: BotService,
    private readonly geminiAuthService: GeminiLiveAuthService,
  ) {}

  registerTwilioSocket(ws: WebSocket, req: IncomingMessage) {
    const initialCallId = this.getQueryParam(req.url || '', 'callId');
    this.logger.log(
      `Twilio stream socket connected url=${req.url || ''} initialCallId=${initialCallId || 'none'}`,
    );
    const state: ActiveCallSession = {
      callId: initialCallId || '',
      userTurns: 0,
      assistantTurns: 0,
      pendingHangup: false,
      completed: false,
      preventInterruption: false,
      assistantAudioActive: false,
      outboundAudioLogged: false,
      responseSpeed: 'fast',
      noiseGateDbfs: -60,
      noiseSuppressedFrames: 0,
      manualActivityActive: false,
      manualAudioMs: 0,
      awaitingModelAudioAfterUser: false,
      scriptWriteTail: Promise.resolve(),
      speechActive: false,
      speechDetectionMs: 0,
      speechBuffer: [],
      noiseFloorDbfs: -70,
      ws,
      reconnectAttempts: 0,
      callActive: false,
      cleanedUp: false,
      lastActivityAt: Date.now(),
      inactivityStrikes: 0,
    };

    // Begin connecting to Gemini as soon as the socket opens (the callId arrives
    // as a query param), so model setup overlaps the Twilio start handshake
    // instead of adding latency before the first words.
    if (initialCallId) {
      const prepare = this.prepareGemini(state, ws, initialCallId);
      state.preparePromise = prepare;
      prepare.catch((error: any) => {
        this.logger.warn(
          `Gemini early connect failed callId=${initialCallId}: ${error?.message || error}`,
        );
      });
    }

    ws.on('message', (raw) => {
      void this.handleTwilioMessage(ws, state, raw.toString()).catch(
        (error) => {
          this.logger.error(error?.message || error);
          this.appendError(state.callId, error).catch(() => undefined);
          if (ws.readyState === WebSocket.OPEN) ws.close();
        },
      );
    });

    ws.on('close', () => {
      void this.cleanupSession(state, 'twilio_socket_closed');
    });

    ws.on('error', (error) => {
      this.logger.warn(`Twilio stream socket error: ${error.message}`);
      void this.appendError(state.callId, error);
    });
  }

  prewarm(ws: WebSocket) {
    ws.send(JSON.stringify({ event: 'prewarm_complete', success: true }));
    ws.close();
  }

  private async handleTwilioMessage(
    ws: WebSocket,
    state: ActiveCallSession,
    raw: string,
  ) {
    const frame = this.parseFrame(raw);
    if (!frame?.event) return;

    if (frame.event === 'start') {
      await this.startStream(ws, state, frame);
      return;
    }

    if (!state.gemini) return;

    if (frame.event === 'media' && frame.media?.payload) {
      this.forwardAudio(state, frame.media.payload);
      return;
    }

    if (frame.event === 'stop') {
      await this.completeCall(state, 'twilio_stream_stopped');
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
  }

  private async startStream(
    ws: WebSocket,
    state: ActiveCallSession,
    frame: TwilioFrame,
  ) {
    const callId =
      frame.start?.customParameters?.callId ||
      state.callId ||
      frame.start?.customParameters?.CallId ||
      '';
    if (!callId) {
      this.logger.warn('Twilio stream start missing callId.');
      ws.close(1008, 'Missing callId');
      return;
    }

    state.callId = callId;
    state.streamSid = frame.start?.streamSid || frame.streamSid;
    state.providerCallSid = frame.start?.callSid;

    // The Gemini session may already be connecting from socket-open (early
    // connect). Reuse that; if it never started or failed, prepare it now.
    let ready = false;
    if (state.preparePromise) {
      try {
        await state.preparePromise;
        ready = true;
      } catch (error: any) {
        this.logger.warn(
          `Gemini early connect failed; retrying at stream start callId=${callId}: ${error?.message || error}`,
        );
      }
    }
    if (!ready) {
      try {
        state.preparePromise = this.prepareGemini(state, ws, callId);
        await state.preparePromise;
      } catch (error: any) {
        this.logger.warn(
          `Twilio stream start could not prepare Gemini callId=${callId}: ${error?.message || error}`,
        );
        await this.appendError(callId, error).catch(() => undefined);
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Setup failed');
        return;
      }
    }

    const call = state.call;
    await this.db.callHistory.update({
      where: { id: callId },
      data: {
        provider: 'twilio',
        providerCallSid: state.providerCallSid || call.providerCallSid,
        providerStatus: 'in-progress',
        status: 'IN_PROGRESS',
        outcome: 'IN_PROGRESS',
        sessionStatus: 'in_progress',
        startedAt: call.startedAt || new Date(),
        connectedAt: call.connectedAt || new Date(),
      },
    });

    state.callActive = true;
    this.armCallTimers(state);

    if (state.campaign.aiSpeaksFirst !== false) {
      state.gemini?.sendText('[SIGNAL_START]');
      this.logger.log(`Gemini Live start signal sent callId=${callId}`);
    } else {
      this.logger.log(
        `Gemini Live waiting for contact to speak first callId=${callId}`,
      );
    }
  }

  // Load the call/campaign/contact and connect the Gemini session. Safe to call
  // from socket-open (early connect), from stream start, and on reconnect — the
  // data load is idempotent and connect always builds a fresh session.
  private async prepareGemini(
    state: ActiveCallSession,
    ws: WebSocket,
    callId: string,
  ) {
    await this.loadCallData(state, callId);
    await this.connectGemini(state, ws);
  }

  private async loadCallData(state: ActiveCallSession, callId: string) {
    if (state.call) return;
    const call = await this.db.callHistory.findUnique({
      where: { id: callId },
      include: { contact: true, campaign: true },
    });
    if (!call?.campaign) {
      throw new Error(`Call not found or missing campaign: ${callId}`);
    }
    state.callId = callId;
    state.call = call;
    state.campaign = call.campaign;
    state.contact = call.contact;
    state.preventInterruption = call.campaign.preventInterruption === true;
    const preset = getResponseSpeedPreset(call.campaign.responseSpeed);
    state.responseSpeed = preset.responseSpeed;
    state.noiseGateDbfs = preset.noiseGateDbfs;
    this.sessions.set(callId, state);
  }

  private buildGeminiConfig(state: ActiveCallSession): GeminiLiveConfig {
    const call = state.call;
    const { tools, handlers } = this.buildTools(state);
    const model =
      state.campaign.realtimeModel ||
      process.env.GEMINI_LIVE_MODEL ||
      'gemini-2.5-flash-native-audio-preview-12-2025';
    const languageCode = this.resolveSelectedLanguage(state);
    const selectedVoice = this.resolveSelectedVoice(state);
    const voiceName = this.extractVoiceName(selectedVoice);
    const languageProfile = this.getLanguageProfile(languageCode);
    const preset = getResponseSpeedPreset(state.responseSpeed);
    this.logger.log(
      `Starting Gemini Live call callId=${state.callId} campaignId=${state.campaign.id || call?.campaignId} streamSid=${state.streamSid || 'none'} providerCallSid=${state.providerCallSid || 'none'} model=${model} voice=${voiceName} selectedVoice=${selectedVoice} requestedLanguage=${languageCode} campaignLanguage=${state.campaign.selectedLanguage || state.campaign.language || 'none'} callLanguage=${call?.selectedLanguage || 'none'} campaignVoice=${state.campaign.selectedVoice || state.campaign.voice || 'none'} callVoice=${call?.selectedVoice || 'none'} spokenLanguage=${languageProfile.spokenLanguage} responseSpeed=${preset.responseSpeed} activityDetection=${preset.activityDetection} vadSilenceMs=${preset.silenceDurationMs} noiseGateDbfs=${preset.noiseGateDbfs} aiSpeaksFirst=${state.campaign.aiSpeaksFirst !== false} preventInterruption=${state.preventInterruption} tools=${tools.map((tool: any) => tool.name).join(',') || 'none'}`,
    );
    return {
      model,
      voiceName,
      languageCode,
      responseSpeed: preset.responseSpeed,
      systemInstruction: this.buildSystemInstruction(state),
      tools,
      toolHandlers: handlers,
      maxOutputTokens: this.parseNumber(state.campaign.maxTokens, 4000),
      inputSampleRate: 16000,
      preventInterruption: state.preventInterruption,
    };
  }

  private async connectGemini(state: ActiveCallSession, ws: WebSocket) {
    if (!state.geminiConfig) {
      state.geminiConfig = this.buildGeminiConfig(state);
    }
    const gemini = new GeminiLiveSessionWrapper(
      this.geminiAuthService,
      state.geminiConfig,
    );
    state.gemini = gemini;
    this.attachGeminiEvents(ws, state, gemini);
    state.setupStartedAt = Date.now();
    await gemini.connect();
    await gemini.waitForSetupComplete();
    state.setupCompletedAt = Date.now();
    this.logger.log(
      `Gemini Live setup ready callId=${state.callId} setupMs=${
        state.setupCompletedAt - state.setupStartedAt
      }`,
    );
  }

  private forwardAudio(state: ActiveCallSession, payload: string) {
    if (!state.gemini || state.gemini.isClosed()) return;
    const pcm = decodeUlawToPcm16(payload);
    const dbfs = calculateDbfs(pcm);
    if (state.preventInterruption && state.assistantAudioActive) {
      state.speechDetectionMs = 0;
      state.speechBuffer = [];
      state.speechActive = false;
      return;
    }
    const frameMs = Math.max(1, Math.round((pcm.length / 2 / 8000) * 1000));
    const preset = getResponseSpeedPreset(state.responseSpeed);
    const noiseGateDbfs = this.effectiveNoiseGate(state, preset);
    // Learn the background noise floor from sub-gate frames so the gate adapts
    // to how noisy this particular line is.
    if (dbfs < noiseGateDbfs) {
      const prevFloor = Number.isFinite(state.noiseFloorDbfs)
        ? state.noiseFloorDbfs
        : dbfs;
      state.noiseFloorDbfs = Math.max(
        -90,
        Math.min(
          -20,
          prevFloor * (1 - NOISE_FLOOR_EMA_ALPHA) +
            dbfs * NOISE_FLOOR_EMA_ALPHA,
        ),
      );
    }
    const isSpeech = dbfs >= noiseGateDbfs;
    // A short sound while the agent is talking is a backchannel ("mm-hmm"), not a
    // real interruption, so it must be sustained longer before we cut the agent off.
    const onsetMs =
      state.assistantAudioActive && !state.preventInterruption
        ? BACKCHANNEL_INTERRUPT_MS
        : SPEECH_ONSET_VALIDATION_MS;
    const resampledReal = resamplePcm16(pcm, 8000, 16000);
    const isManualMode =
      preset.activityDetection === 'manual' || state.preventInterruption;

    if (!state.speechActive) {
      if (isSpeech) {
        state.speechDetectionMs = (state.speechDetectionMs || 0) + frameMs;
        state.speechBuffer = state.speechBuffer || [];
        state.speechBuffer.push(resampledReal);

        if (state.speechDetectionMs >= onsetMs) {
          state.speechActive = true;
          state.lastActivityAt = Date.now();
          this.logger.log(
            `Speech validated onset duration=${state.speechDetectionMs}ms callId=${state.callId} dbfs=${dbfs.toFixed(1)} gate=${noiseGateDbfs.toFixed(1)} onsetMs=${onsetMs}`,
          );
          if (isManualMode) {
            state.manualActivityActive = true;
            state.manualAudioMs =
              (state.manualAudioMs || 0) + state.speechDetectionMs;
            state.manualLastSpeechAudioMs = state.manualAudioMs;
            state.gemini.sendActivityStart();
            this.logger.debug(
              `Gemini Live local activity start callId=${state.callId} (manual mode)`,
            );
          }
          // Forward all buffered audio packets to Gemini
          for (const chunk of state.speechBuffer) {
            state.gemini.sendAudio(chunk);
          }
          state.speechBuffer = [];
          state.speechDetectionMs = 0;
        } else {
          // Not validated yet. Send silence to keep the stream alive
          const silence = resamplePcm16(Buffer.alloc(pcm.length), 8000, 16000);
          state.gemini.sendAudio(silence);
        }
      } else {
        // Reset detection since energy dropped below threshold
        state.speechDetectionMs = 0;
        state.speechBuffer = [];
        // Send silence
        const silence = resamplePcm16(Buffer.alloc(pcm.length), 8000, 16000);
        state.gemini.sendAudio(silence);
      }
    } else {
      // Speech is active.
      if (isSpeech) {
        state.gemini.sendAudio(resampledReal);
        if (isManualMode) {
          state.manualAudioMs = (state.manualAudioMs || 0) + frameMs;
          state.manualLastSpeechAudioMs = state.manualAudioMs;
        } else {
          // Track speech time in automatic mode for silence timeout fallback
          state.manualAudioMs = (state.manualAudioMs || 0) + frameMs;
          state.manualLastSpeechAudioMs = state.manualAudioMs;
        }
      } else {
        // Mid-turn dip below the gate: forward the REAL (quiet) audio, not zeroed
        // silence. This is usually a brief pause, a soft consonant, or a trailing
        // syllable — zeroing it punches holes into the speech and makes Gemini drop
        // words from the transcript. The gate below still detects the pause for
        // end-of-turn timing; it just no longer corrupts what Gemini hears.
        state.noiseSuppressedFrames++;
        if (
          state.noiseSuppressedFrames === 1 ||
          state.noiseSuppressedFrames % 100 === 0
        ) {
          this.logger.debug(
            `Forwarding low-level caller audio as-is callId=${state.callId} frames=${state.noiseSuppressedFrames} dbfs=${dbfs.toFixed(1)} gate=${noiseGateDbfs.toFixed(1)}`,
          );
        }
        state.gemini.sendAudio(resampledReal);

        state.manualAudioMs = (state.manualAudioMs || 0) + frameMs;
        const localSilenceMs =
          state.manualAudioMs - (state.manualLastSpeechAudioMs || 0);

        if (isManualMode) {
          if (localSilenceMs >= preset.silenceDurationMs) {
            state.speechActive = false;
            state.manualActivityActive = false;
            state.gemini.sendActivityEnd();
            this.logger.log(
              `Gemini Live local activity end callId=${state.callId} localSilenceMs=${localSilenceMs} dbfs=${dbfs.toFixed(1)} gate=${noiseGateDbfs.toFixed(1)}`,
            );
          }
        } else {
          // In automatic mode, reset speechActive after long silence as a fallback
          if (localSilenceMs >= AUTOMATIC_SILENCE_RESET_MS) {
            state.speechActive = false;
            state.speechDetectionMs = 0;
            state.speechBuffer = [];
          }
        }
      }
    }
  }

  // Noise gate that adapts to the line: it sits a margin above the measured
  // noise floor but is only allowed to rise above the configured preset (reject
  // more on a noisy line), never drop below it (so a quiet line stays safe). It
  // rises further while the agent speaks to reject its own echo.
  private effectiveNoiseGate(
    state: ActiveCallSession,
    preset: ReturnType<typeof getResponseSpeedPreset>,
  ) {
    const presetGate = Number.isFinite(state.noiseGateDbfs)
      ? state.noiseGateDbfs
      : preset.noiseGateDbfs;
    const floor = Number.isFinite(state.noiseFloorDbfs)
      ? state.noiseFloorDbfs
      : presetGate - NOISE_GATE_MARGIN_DB;
    const adaptive = floor + NOISE_GATE_MARGIN_DB;
    let gate = Math.min(
      Math.max(adaptive, presetGate),
      presetGate + NOISE_GATE_MAX_RAISE_DB,
    );
    if (state.assistantAudioActive && !state.preventInterruption) {
      gate += ECHO_SUPPRESSION_DB;
    }
    return gate;
  }

  private attachGeminiEvents(
    ws: WebSocket,
    state: ActiveCallSession,
    gemini: GeminiLiveSessionWrapper,
  ) {
    gemini.on('audio_chunk', (chunk: Buffer) => {
      if (!state.streamSid || ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      state.assistantAudioActive = true;
      state.speechActive = false;
      state.speechDetectionMs = 0;
      state.speechBuffer = [];
      if (!state.outboundAudioLogged) {
        state.outboundAudioLogged = true;
        const sinceSetupMs = state.setupStartedAt
          ? now - state.setupStartedAt
          : undefined;
        this.logger.debug(
          `Gemini Live first outbound audio callId=${state.callId} bytes=${chunk.length} sinceSetupMs=${sinceSetupMs ?? 'n/a'}`,
        );
      }
      if (state.awaitingModelAudioAfterUser && state.lastUserTranscriptAt) {
        this.logger.log(
          `Gemini Live response latency callId=${state.callId} responseSpeed=${state.responseSpeed} firstAudioAfterUserMs=${
            now - state.lastUserTranscriptAt
          }`,
        );
        state.awaitingModelAudioAfterUser = false;
      }
      const payload = transcodePcm24kToUlaw8k(chunk).toString('base64');
      ws.send(
        JSON.stringify({
          event: 'media',
          streamSid: state.streamSid,
          media: { payload },
        }),
      );
    });

    gemini.on('interrupted', () => {
      state.assistantAudioActive = false;
      if (
        state.preventInterruption ||
        !state.streamSid ||
        ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      ws.send(JSON.stringify({ event: 'clear', streamSid: state.streamSid }));
    });

    gemini.on('user_transcript_final', (text: string) => {
      state.userTurns++;
      state.lastUserTranscriptAt = Date.now();
      state.awaitingModelAudioAfterUser = true;
      state.speechActive = false;
      state.speechDetectionMs = 0;
      state.speechBuffer = [];
      this.resetInactivity(state);
      this.logger.debug(
        `Gemini Live user transcript callId=${state.callId} turn=${state.userTurns} length=${text.length} noiseSuppressedFrames=${state.noiseSuppressedFrames}`,
      );
      this.queueScriptAppend(state, 'user', text);
    });

    gemini.on('model_text_final', (text: string) => {
      state.assistantTurns++;
      const sinceUserFinalMs = state.lastUserTranscriptAt
        ? Date.now() - state.lastUserTranscriptAt
        : undefined;
      this.logger.debug(
        `Gemini Live model transcript callId=${state.callId} turn=${state.assistantTurns} length=${text.length} textAfterUserMs=${sinceUserFinalMs ?? 'n/a'}`,
      );
      this.queueScriptAppend(state, 'assistant', text);
    });

    gemini.on('audio_done', () => {
      state.assistantAudioActive = false;
      state.speechActive = false;
      state.speechDetectionMs = 0;
      state.speechBuffer = [];
      this.logger.debug(
        `Gemini Live audio done callId=${state.callId} pendingHangup=${state.pendingHangup}`,
      );
      if (state.pendingHangup) {
        void this.completeCall(state, state.endCallReason || 'end_call');
        if (ws.readyState === WebSocket.OPEN) ws.close();
        return;
      }
      // Safety net: stop a runaway call from burning tokens indefinitely.
      const totalTokens = state.gemini?.getUsage()?.totalTokenCount || 0;
      if (totalTokens > MAX_CALL_TOKENS) {
        this.logger.warn(
          `Token budget exceeded callId=${state.callId} tokens=${totalTokens} budget=${MAX_CALL_TOKENS}`,
        );
        void this.endCall(state, 'token_budget_exceeded');
        return;
      }
      // The agent finished speaking; the ball is now in the contact's court.
      this.resetInactivity(state);
      if (state.streamSid && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            event: 'mark',
            streamSid: state.streamSid,
            mark: { name: `agent-turn-${Date.now()}` },
          }),
        );
      }
    });

    gemini.on('error', (error: Error) => {
      this.logger.error(`Gemini Live session error: ${error.message}`);
      void this.appendError(state.callId, error);
    });

    gemini.on('close', () => {
      void this.handleGeminiClose(ws, state);
    });
  }

  // The Gemini socket closed. If it dropped while a call was live, try one
  // reconnect so the contact gets a brief recovery instead of dead air;
  // otherwise (intentional close, or still setting up) clean up as before.
  private async handleGeminiClose(ws: WebSocket, state: ActiveCallSession) {
    if (!state.callActive) return;
    if (
      state.completed ||
      state.pendingHangup ||
      ws.readyState !== WebSocket.OPEN ||
      state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS
    ) {
      await this.cleanupSession(state, 'gemini_live_session_closed');
      return;
    }
    state.reconnectAttempts++;
    this.logger.warn(
      `Gemini socket dropped mid-call; reconnecting callId=${state.callId} attempt=${state.reconnectAttempts}`,
    );
    try {
      await this.connectGemini(state, ws);
      // New session has no memory; prompt a brief, natural recovery.
      state.gemini?.sendText('[RESUME]');
      this.resetInactivity(state);
    } catch (error: any) {
      this.logger.error(
        `Gemini reconnect failed callId=${state.callId}: ${error?.message || error}`,
      );
      await this.appendError(state.callId, error);
      await this.cleanupSession(state, 'gemini_reconnect_failed');
    }
  }

  // ---- Call safety timers -------------------------------------------------

  private armCallTimers(state: ActiveCallSession) {
    this.clearCallTimers(state);
    const maxTimer = setTimeout(() => {
      this.logger.warn(`Max call duration reached callId=${state.callId}`);
      void this.endCall(state, 'max_call_duration');
    }, MAX_CALL_DURATION_MS);
    maxTimer.unref?.();
    state.maxCallTimer = maxTimer;
    this.resetInactivity(state);
  }

  private resetInactivity(state: ActiveCallSession) {
    state.lastActivityAt = Date.now();
    state.inactivityStrikes = 0;
    if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
    const timer = setTimeout(
      () => this.onInactivity(state),
      INACTIVITY_TIMEOUT_MS,
    );
    timer.unref?.();
    state.inactivityTimer = timer;
  }

  private onInactivity(state: ActiveCallSession) {
    if (state.completed || state.pendingHangup) return;
    // Not real silence if someone is mid-utterance (e.g. a long agent turn that
    // hasn't hit audio_done yet) — defer the check instead of talking over them.
    if (state.assistantAudioActive || state.speechActive) {
      const timer = setTimeout(
        () => this.onInactivity(state),
        INACTIVITY_TIMEOUT_MS,
      );
      timer.unref?.();
      state.inactivityTimer = timer;
      return;
    }
    state.inactivityStrikes++;
    if (
      state.inactivityStrikes >= MAX_INACTIVITY_STRIKES ||
      !state.gemini ||
      state.gemini.isClosed()
    ) {
      this.logger.warn(
        `Inactivity timeout, ending call callId=${state.callId} strikes=${state.inactivityStrikes}`,
      );
      void this.endCall(state, 'inactivity_timeout');
      return;
    }
    this.logger.log(
      `Inactivity re-prompt callId=${state.callId} strike=${state.inactivityStrikes}`,
    );
    state.gemini.sendText('[SILENCE_CHECK]');
    const timer = setTimeout(
      () => this.onInactivity(state),
      INACTIVITY_TIMEOUT_MS,
    );
    timer.unref?.();
    state.inactivityTimer = timer;
  }

  private clearCallTimers(state: ActiveCallSession) {
    if (state.inactivityTimer) {
      clearTimeout(state.inactivityTimer);
      state.inactivityTimer = undefined;
    }
    if (state.maxCallTimer) {
      clearTimeout(state.maxCallTimer);
      state.maxCallTimer = undefined;
    }
  }

  // Complete the call from an internal trigger (timer/budget) and close the
  // Twilio socket so the contact is released cleanly.
  private async endCall(state: ActiveCallSession, reason: string) {
    const ws = state.ws;
    await this.completeCall(state, reason);
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  }

  private buildTools(state: ActiveCallSession) {
    const enabledTools = new Set<string>(
      Array.isArray(state.campaign?.tools)
        ? state.campaign.tools
        : ['end_call', 'fetch_context'],
    );
    const tools: Array<Record<string, unknown>> = [];
    const handlers = new Map<
      string,
      (args: Record<string, unknown>) => Promise<unknown>
    >();

    if (enabledTools.has('end_call')) {
      tools.push({
        name: 'end_call',
        description:
          'Ends the call. Invoke only after the conversation objectives are complete and after delivering a closing statement.',
        parameters: {
          type: 'OBJECT',
          properties: {
            reason: {
              type: 'STRING',
              description: 'Short reason for ending the call.',
            },
          },
          required: ['reason'],
        },
      });
      handlers.set('end_call', async (args) => {
        if (state.userTurns < 1) {
          return {
            status:
              'Call cannot be ended yet. Speak with the contact first, then continue toward the objective.',
          };
        }
        state.pendingHangup = true;
        state.endCallReason = String(args.reason || 'conversation_complete');
        await this.db.callHistory.update({
          where: { id: state.callId },
          data: { endCallReason: state.endCallReason },
        });
        return {
          status:
            'Call ending is scheduled after the final spoken audio finishes.',
        };
      });
    }

    if (enabledTools.has('fetch_context')) {
      tools.push({
        name: 'fetch_context',
        description:
          'Fetch relevant knowledge-base context for a specific user question.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'Standalone search query from the user question.',
            },
            bot_id: {
              type: 'STRING',
              description: 'Optional bot id. Use the configured bot id.',
            },
          },
          required: ['query'],
        },
      });
      handlers.set('fetch_context', async (args) => {
        const startedAt = Date.now();
        const query = String(args.query || '').trim();
        const botId =
          String(args.bot_id || '').trim() ||
          String(state.campaign.aiCallingBotId || '').trim();
        if (!query || !botId) {
          this.logger.debug(
            `Gemini Live fetch_context skipped callId=${state.callId} queryLength=${query.length} botId=${botId || 'none'} durationMs=${
              Date.now() - startedAt
            }`,
          );
          return { context: [], scores: [], sources: [], references: [] };
        }
        const results = await this.withTimeout(
          this.botService
            .searchBotKnowledge(botId, query, 4)
            .catch((error: any) => {
              this.logger.warn(
                `Gemini Live fetch_context search failed callId=${state.callId}: ${error?.message || error}`,
              );
              return [] as Awaited<
                ReturnType<typeof this.botService.searchBotKnowledge>
              >;
            }),
          FETCH_CONTEXT_TIMEOUT_MS,
          [],
        );
        this.logger.debug(
          `Gemini Live fetch_context callId=${state.callId} botId=${botId} queryLength=${query.length} results=${results.length} durationMs=${
            Date.now() - startedAt
          }`,
        );
        return {
          context: results.map((item) => item.content),
          scores: results.map((item) => item.score),
          sources: results.map((item) => ({
            sourceName: item.metadata?.sourceName || 'knowledge-base',
            sourceType: item.metadata?.sourceType || 'document',
            score: item.score,
          })),
          references: results
            .map((item) => item.metadata?.ref || item.id)
            .filter(Boolean),
        };
      });
    }

    return { tools, handlers };
  }

  private buildSystemInstruction(state: ActiveCallSession) {
    const campaign = state.campaign || {};
    const contact = state.contact || {};
    const botId = campaign.aiCallingBotId || '';
    const languageProfile = this.getLanguageProfile(
      this.resolveSelectedLanguage(state),
    );
    const liveVoiceName = this.extractVoiceName(
      this.resolveSelectedVoice(state),
    );
    const pieces = [
      'You are the live voice agent for an outbound AgentReach call.',
      `Default spoken language: ${languageProfile.spokenLanguage} (${languageProfile.code}) using ${languageProfile.accent}. Open the call in this language.`,
      `Agent name: ${campaign.botName || 'Agent'}.`,
      `Role: ${campaign.botRole || 'AI calling specialist'}.`,
      `Goal: ${campaign.botGoal || campaign.objective || 'Understand the contact need and capture a clear next step.'}.`,
      `Selected Gemini Live voice: ${liveVoiceName}.`,
      campaign.prompt ? `Campaign prompt: ${campaign.prompt}` : '',
      campaign.botPersonality
        ? `Personality: ${campaign.botPersonality}`
        : 'Personality: warm, concise, calm, and naturally conversational.',
      campaign.botKnowledge ? `Known facts: ${campaign.botKnowledge}` : '',
      campaign.botRules ? `Rules: ${campaign.botRules}` : '',
      campaign.botObjectionHandling
        ? `Objection handling: ${campaign.botObjectionHandling}`
        : '',
      campaign.botGreeting ? `Opening greeting: ${campaign.botGreeting}` : '',
      `Contact: ${
        [contact.firstName, contact.lastName, contact.company, contact.jobTitle]
          .filter(Boolean)
          .join(' ') || 'Unknown contact'
      }.`,
      contact.notes ? `Contact notes: ${contact.notes}` : '',
      `Begin in ${languageProfile.spokenLanguage} (${languageProfile.code}) with ${languageProfile.accent}. ${languageProfile.instruction}`,
      'Language is not fixed: if the contact speaks or asks for another language, switch to it right away and keep speaking their language naturally for the rest of the call, the way a fluent bilingual person would. Mirror whatever language they use, and switch back if they switch.',
      'This is a live phone conversation. Talk like a real person — relaxed, warm, and natural, never scripted or robotic.',
      'Keep every turn short: usually one sentence, two at most. Say one thing, then let the contact respond.',
      'Use natural spoken language — contractions, simple everyday words, and short acknowledgements like "sure", "got it", "right", or "mm-hmm".',
      'Reply immediately and get to the point. Do not repeat yourself, over-explain, or list things the contact did not ask for.',
      "Match the contact's pace and energy. If they are quick, be quick; if they are unsure, slow down.",
      'Ignore background noise, typing, distant voices, and static. If the audio is genuinely unclear, briefly ask them to repeat instead of guessing.',
      'If the contact is busy, ask for a better callback time.',
      'Never claim the call is human. Never invent pricing, policies, or facts.',
      botId
        ? `When specific knowledge-base facts are needed, say a short natural filler first (like "let me check that for you") and then call fetch_context with bot_id "${botId}" before answering, so the line is never silent while you look it up.`
        : '',
      'If you receive [SILENCE_CHECK], the line has gone quiet — briefly and warmly check whether the contact is still there.',
      'If you receive [RESUME], the connection briefly dropped — apologize very briefly for any cut-off and naturally pick the conversation back up.',
      'After a natural closing statement and once the objective is complete, call end_call.',
      campaign.aiSpeaksFirst !== false
        ? 'When you receive [SIGNAL_START], begin with the opening greeting. Do not call tools at the start.'
        : 'Wait for the contact to speak first before greeting.',
    ];

    return pieces.filter(Boolean).join('\n');
  }

  private async appendScript(callId: string, role: string, content: string) {
    if (!callId || !content.trim()) return;
    const call = await this.db.callHistory.findUnique({
      where: { id: callId },
    });
    const scripts = Array.isArray(call?.scripts) ? call.scripts : [];
    const timestamp = new Date().toISOString();
    const nextScripts = [
      ...scripts,
      { role, content: content.trim(), timestamp },
    ];
    // Format transcript with speaker labels and timestamps for readability
    const transcript = nextScripts
      .map((item: any) => {
        const speaker = item.role === 'assistant' ? 'AI' : 'User';
        const time = new Date(item.timestamp).toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        return `[${time}] ${speaker}: ${item.content}`;
      })
      .join('\n');
    await this.db.callHistory.update({
      where: { id: callId },
      data: {
        scripts: nextScripts,
        transcript,
      },
    });
  }

  private queueScriptAppend(
    state: ActiveCallSession,
    role: 'user' | 'assistant',
    content: string,
  ) {
    const callId = state.callId;
    // Chain each append onto the previous one so two transcript events landing
    // close together cannot both read-modify-write the same document and clobber
    // each other (which previously dropped turns from the transcript).
    state.scriptWriteTail = state.scriptWriteTail
      .then(() => this.appendScript(callId, role, content))
      .catch((error: any) => {
        this.logger.warn(
          `Could not append transcript callId=${callId} role=${role}: ${error?.message || error}`,
        );
      });
  }

  private async waitForScriptWrites(state: ActiveCallSession) {
    await state.scriptWriteTail;
  }

  private async appendError(callId: string, error: unknown) {
    if (!callId) return;
    const call = await this.db.callHistory.findUnique({
      where: { id: callId },
    });
    const sessionErrors = Array.isArray(call?.sessionErrors)
      ? call.sessionErrors
      : [];
    await this.db.callHistory.update({
      where: { id: callId },
      data: {
        sessionErrors: [
          ...sessionErrors,
          {
            message: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });
  }

  private async completeCall(state: ActiveCallSession, reason: string) {
    if (!state.callId || state.completed) return;
    this.logger.log(
      `Completing Gemini Live call callId=${state.callId} reason=${reason}`,
    );
    state.completed = true;
    this.clearCallTimers(state);
    state.gemini?.flushTranscriptionBuffers('completeCall');
    await this.waitForScriptWrites(state);
    const endedAt = new Date();
    const call = await this.db.callHistory.findUnique({
      where: { id: state.callId },
    });
    const startedAt = call?.startedAt ? new Date(call.startedAt) : endedAt;
    const duration = Math.max(
      0,
      Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    );
    await this.db.callHistory.update({
      where: { id: state.callId },
      data: {
        status: 'COMPLETED',
        outcome: 'ANSWERED',
        sessionStatus: 'completed',
        providerStatus: 'completed',
        duration,
        endedAt,
        endCallReason: state.endCallReason || reason,
        conversationTokenUsage: state.gemini?.getUsage(),
      },
    });
    state.gemini?.close();
    this.sessions.delete(state.callId);
    await this.checkAndCompleteCampaign(state.campaign?.id || call?.campaignId);
  }

  private async cleanupSession(state: ActiveCallSession, reason: string) {
    if (state.cleanedUp) return;
    state.cleanedUp = true;
    this.clearCallTimers(state);
    if (state.callId) {
      this.logger.log(
        `Cleaning Gemini Live call session callId=${state.callId} reason=${reason}`,
      );
    }
    state.gemini?.flushTranscriptionBuffers('cleanupSession');
    await this.waitForScriptWrites(state);
    state.gemini?.close();
    if (state.callId && !state.completed) {
      const call = await this.db.callHistory.findUnique({
        where: { id: state.callId },
      });
      if (
        call &&
        !['completed', 'failed', 'cancelled'].includes(
          String(call.sessionStatus || '').toLowerCase(),
        )
      ) {
        await this.db.callHistory.update({
          where: { id: state.callId },
          data: {
            sessionStatus: reason,
            providerStatus: reason,
            endedAt: call.endedAt || new Date(),
            conversationTokenUsage: state.gemini?.getUsage(),
          },
        });
      }
    }
    if (state.callId) this.sessions.delete(state.callId);
  }

  private async checkAndCompleteCampaign(campaignId?: string) {
    if (!campaignId) return;
    const calls = await this.db.callHistory.findMany({ where: { campaignId } });
    if (calls.length === 0) return;
    const active = calls.some((call: any) =>
      [
        'PENDING',
        'QUEUED',
        'QUEUING',
        'DIALING',
        'RINGING',
        'IN_PROGRESS',
      ].includes(String(call.outcome || '').toUpperCase()),
    );
    if (!active) {
      await this.db.callingCampaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED' },
      });
    }
  }

  private extractVoiceName(voice?: string) {
    const raw = String(voice || 'google:en-IN-Chirp3-HD-Puck').replace(
      /^google:/i,
      '',
    );
    const name = raw.split('-').at(-1) || 'Puck';
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  private resolveSelectedLanguage(state: ActiveCallSession) {
    const campaign = state.campaign || {};
    const call = state.call || {};
    return (
      call.selectedLanguage ||
      campaign.selectedLanguage ||
      campaign.language ||
      'en-IN'
    );
  }

  private resolveSelectedVoice(state: ActiveCallSession) {
    const campaign = state.campaign || {};
    const call = state.call || {};
    const language = this.resolveSelectedLanguage(state);
    const raw =
      call.selectedVoice ||
      campaign.selectedVoice ||
      campaign.voice ||
      `google:${language}-Chirp3-HD-Puck`;
    return this.normalizeGoogleVoiceForLanguage(raw, language);
  }

  private normalizeGoogleVoiceForLanguage(voice: string, language: string) {
    const raw = String(voice || '').trim();
    const withoutProvider = raw.replace(/^google:/i, '');
    const match = withoutProvider.match(
      /^[a-z]{2,3}-[A-Z]{2}-Chirp3-HD-([A-Za-z]+)$/,
    );
    const voiceName = match?.[1] || withoutProvider.split('-').at(-1) || 'Puck';
    return `google:${language}-Chirp3-HD-${voiceName}`;
  }

  private getLanguageProfile(languageCode?: string) {
    const code = String(languageCode || 'en-IN').trim() || 'en-IN';
    const profiles: Record<
      string,
      { spokenLanguage: string; accent: string; instruction: string }
    > = {
      'en-IN': {
        spokenLanguage: 'English',
        accent: 'Indian English',
        instruction:
          'Speak casual, natural Indian English — the way everyday people in India speak English on the phone. Use Indian phrasing, rhythm, and intonation (rising tone at end of statements, natural code-switching with Hindi/local words). Sound friendly and conversational, not formal. Examples: "What is it, sir/madam?", "One moment only", "No problem, I will check.", "What all you need?" Use casual fillers like "actually", "basically", "simply". Match the contact\'s energy.',
      },
      'en-US': {
        spokenLanguage: 'English',
        accent: 'American English',
        instruction: 'Use natural American English phrasing and pronunciation.',
      },
      'en-GB': {
        spokenLanguage: 'English',
        accent: 'British English',
        instruction: 'Use natural British English phrasing and pronunciation.',
      },
      'hi-IN': {
        spokenLanguage: 'Hindi',
        accent: 'Casual Hindi (Youth/Teenage)',
        instruction:
          'Speak casual, modern Hindi like teenagers use — relaxed and conversational, not formal. Use Hinglish (Hindi mixed with English words naturally). Common patterns: "Haan, bilkul", "Ek minute", "Basically yeh ek simple cheez hai", "Kya baat hai", "Chill, sab theek hai", "Mujhe bataao what all you need". Use teenage slang and casual fillers: "basically", "arre bhai", "yaar", "literally", "bro". Sound friendly, young, and relatable — like talking to a friend.',
      },
      'bn-IN': {
        spokenLanguage: 'Bengali',
        accent: 'Indian Bengali',
        instruction: 'Speak Bengali naturally.',
      },
      'gu-IN': {
        spokenLanguage: 'Gujarati',
        accent: 'Indian Gujarati',
        instruction: 'Speak Gujarati naturally.',
      },
      'kn-IN': {
        spokenLanguage: 'Kannada',
        accent: 'Indian Kannada',
        instruction: 'Speak Kannada naturally.',
      },
      'ml-IN': {
        spokenLanguage: 'Malayalam',
        accent: 'Indian Malayalam',
        instruction: 'Speak Malayalam naturally.',
      },
      'mr-IN': {
        spokenLanguage: 'Marathi',
        accent: 'Indian Marathi',
        instruction: 'Speak Marathi naturally.',
      },
      'ta-IN': {
        spokenLanguage: 'Tamil',
        accent: 'Indian Tamil',
        instruction: 'Speak Tamil naturally.',
      },
      'te-IN': {
        spokenLanguage: 'Telugu',
        accent: 'Indian Telugu',
        instruction: 'Speak Telugu naturally.',
      },
      'es-ES': {
        spokenLanguage: 'Spanish',
        accent: 'Spain Spanish',
        instruction: 'Speak Spanish naturally for Spain.',
      },
      'es-MX': {
        spokenLanguage: 'Spanish',
        accent: 'Mexican Spanish',
        instruction: 'Speak Spanish naturally for Mexico.',
      },
      'fr-FR': {
        spokenLanguage: 'French',
        accent: 'France French',
        instruction: 'Speak French naturally for France.',
      },
      'fr-CA': {
        spokenLanguage: 'French',
        accent: 'Canadian French',
        instruction: 'Speak French naturally for Canada.',
      },
      'de-DE': {
        spokenLanguage: 'German',
        accent: 'German',
        instruction: 'Speak German naturally.',
      },
      'it-IT': {
        spokenLanguage: 'Italian',
        accent: 'Italian',
        instruction: 'Speak Italian naturally.',
      },
      'pt-BR': {
        spokenLanguage: 'Portuguese',
        accent: 'Brazilian Portuguese',
        instruction: 'Speak Portuguese naturally for Brazil.',
      },
      'sv-SE': {
        spokenLanguage: 'Swedish',
        accent: 'Swedish',
        instruction: 'Speak Swedish naturally.',
      },
      'zh-CN': {
        spokenLanguage: 'Mandarin Chinese',
        accent: 'Mainland Chinese',
        instruction: 'Speak Mandarin Chinese naturally, using simplified characters.',
      },
      'nl-NL': {
        spokenLanguage: 'Dutch',
        accent: 'Netherlands Dutch',
        instruction: 'Speak Dutch naturally and directly, as spoken in the Netherlands.',
      },
      'pl-PL': {
        spokenLanguage: 'Polish',
        accent: 'Polish',
        instruction: 'Speak Polish naturally and conversationally.',
      },
      'ru-RU': {
        spokenLanguage: 'Russian',
        accent: 'Russian',
        instruction: 'Speak Russian naturally and clearly.',
      },
      'tr-TR': {
        spokenLanguage: 'Turkish',
        accent: 'Turkish',
        instruction: 'Speak Turkish naturally and conversationally.',
      },
      'el-GR': {
        spokenLanguage: 'Greek',
        accent: 'Greek',
        instruction: 'Speak Greek naturally and conversationally.',
      },
      'cs-CZ': {
        spokenLanguage: 'Czech',
        accent: 'Czech',
        instruction: 'Speak Czech naturally and clearly.',
      },
      'hu-HU': {
        spokenLanguage: 'Hungarian',
        accent: 'Hungarian',
        instruction: 'Speak Hungarian naturally and conversationally.',
      },
      'ro-RO': {
        spokenLanguage: 'Romanian',
        accent: 'Romanian',
        instruction: 'Speak Romanian naturally and conversationally.',
      },
    };
    return {
      code,
      ...(profiles[code] || {
        spokenLanguage: code,
        accent: code,
        instruction:
          'Follow the selected locale consistently for every spoken turn.',
      }),
    };
  }

  private parseNumber(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  // Resolve to `fallback` if `promise` does not settle within `ms`, so a slow
  // dependency (e.g. a knowledge-base query) can never stall the live call.
  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    fallback: T,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private parseFrame(raw: string): TwilioFrame | null {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private getQueryParam(rawUrl: string, key: string) {
    try {
      const url = new URL(rawUrl, 'http://localhost');
      return url.searchParams.get(key) || '';
    } catch {
      return '';
    }
  }
}

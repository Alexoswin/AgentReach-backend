import { Injectable, Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { MongoService } from '../mongo.service';
import { verifyCallToken } from '../auth/secrets';
import { BotService } from '../bot/bot.service';
import { GeminiLiveAuthService } from './gemini-live-auth.service';
import {
  GeminiLiveConfig,
  GeminiLiveSessionWrapper,
} from './gemini-live-session.wrapper';
import { getResponseSpeedPreset } from './response-speed';
import { DEFAULT_GEMINI_LIVE_MODEL } from '../config/gemini-live';
import {
  calculateDbfs,
  decodeUlawToPcm16,
  resamplePcm16,
  transcodePcm24kToUlaw8k,
} from './audio-codec';
import {
  ActiveCallSession,
  CallProvider,
  TwilioFrame,
} from './call-session.types';
import { buildCallTools } from './call-tools';
import { buildCallSystemInstruction } from './call-prompt';
import { getLanguageProfile } from './language-profiles';
import {
  extractHdVoiceName,
  normalizeGoogleVoiceForLanguage,
} from '../config/voice-format';

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
// Safety net so a stuck call cannot burn tokens forever (native audio is
// token-heavy, so this is a high ceiling, not a normal-case limiter).
const MAX_CALL_TOKENS = Number(process.env.GEMINI_MAX_CALL_TOKENS || 600000);
// At most one automatic reconnect if the Gemini socket drops mid-call.
const MAX_RECONNECT_ATTEMPTS = 1;
// Cap on greeting audio held while waiting for the Twilio start frame
// (base64 chars of 8kHz μ-law ≈ 20s of speech).
const MAX_PENDING_OUTBOUND_CHARS = 8000 * 20 * 1.4;

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
    this.registerSocket(ws, req, 'twilio');
  }

  registerPlivoSocket(ws: WebSocket, req: IncomingMessage) {
    this.registerSocket(ws, req, 'plivo');
  }

  // Twilio Media Streams and Plivo Audio Streams speak the same JSON envelope
  // (event/start/media/stop), so one handler drives both — only the outbound
  // frame shape differs, which sendAudioFrame/sendClearFrame/sendMarkFrame
  // branch on via state.provider.
  private registerSocket(
    ws: WebSocket,
    req: IncomingMessage,
    provider: CallProvider,
  ) {
    const queryCallId = this.getQueryParam(req.url || '', 'callId');
    const queryToken = this.getQueryParam(req.url || '', 'token');
    // Only trust the query callId for early connect when its token checks
    // out; otherwise wait for the start frame and verify there.
    const initialCallId =
      queryCallId && verifyCallToken(queryCallId, queryToken)
        ? queryCallId
        : '';
    this.logger.log(
      `${provider} stream socket connected path=${(req.url || '').split('?')[0]} initialCallId=${initialCallId || 'none'}`,
    );
    const state: ActiveCallSession = {
      callId: initialCallId || '',
      streamToken: queryToken || '',
      provider,
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
      startSignalSent: false,
      pendingOutboundAudio: [],
      pendingOutboundBytes: 0,
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

    const token =
      frame.start?.customParameters?.token || state.streamToken || '';
    if (!verifyCallToken(callId, token)) {
      this.logger.warn(`Stream start rejected: invalid token callId=${callId}`);
      ws.close(1008, 'Invalid token');
      return;
    }

    state.callId = callId;
    state.streamSid =
      frame.start?.streamSid || frame.start?.streamId || frame.streamSid;
    state.providerCallSid = frame.start?.callSid || frame.start?.callId;

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

    // Get sound flowing before any bookkeeping: release greeting audio the
    // model already produced, and only then touch the database.
    this.flushPendingAssistantAudio(state, ws);
    this.maybeSendStartSignal(state);
    state.callActive = true;
    this.armCallTimers(state);

    const call = state.call;
    await this.db.callHistory.update({
      where: { id: callId },
      data: {
        provider: state.provider,
        providerCallSid: state.providerCallSid || call.providerCallSid,
        providerStatus: 'in-progress',
        status: 'IN_PROGRESS',
        outcome: 'IN_PROGRESS',
        sessionStatus: 'in_progress',
        startedAt: call.startedAt || new Date(),
        connectedAt: call.connectedAt || new Date(),
      },
    });
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
    // Ask for the greeting immediately: generation overlaps the rest of the
    // Twilio start handshake, and any audio produced before streamSid is known
    // is buffered by the audio_chunk handler and flushed at stream start.
    this.maybeSendStartSignal(state);
  }

  private maybeSendStartSignal(state: ActiveCallSession) {
    if (state.startSignalSent || state.completed) return;
    if (!state.gemini || state.gemini.isClosed()) return;
    if (state.campaign?.aiSpeaksFirst === false) {
      this.logger.log(
        `Gemini Live waiting for contact to speak first callId=${state.callId}`,
      );
      return;
    }
    state.startSignalSent = true;
    state.gemini.sendText('[SIGNAL_START]');
    this.logger.log(`Gemini Live start signal sent callId=${state.callId}`);
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
      DEFAULT_GEMINI_LIVE_MODEL;
    const languageCode = this.resolveSelectedLanguage(state);
    const selectedVoice = this.resolveSelectedVoice(state);
    const voiceName = extractHdVoiceName(selectedVoice);
    const languageProfile = getLanguageProfile(languageCode);
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
    // Carry the latest resumption handle so a reconnect restores the session
    // (conversation context, pending turn) instead of starting blank.
    state.geminiConfig.resumeHandle = state.resumeHandle;
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
    const resampledReal = resamplePcm16(pcm, 8000, 16000);
    const isManualMode =
      preset.activityDetection === 'manual' || state.preventInterruption;

    // An open manual turn is tracked by manualActivityActive — the protocol
    // state shared with Gemini — never by the local speech flags: events such
    // as assistant audio chunks or transcript finals reset those flags mid-turn,
    // and keying off them used to strand Gemini waiting for an activityEnd that
    // never came (dead air until the silence check). While the turn is open,
    // always forward the real audio and close the turn from frame timing alone.
    if (isManualMode && state.manualActivityActive) {
      state.speechActive = true;
      state.gemini.sendAudio(resampledReal);
      state.manualAudioMs = (state.manualAudioMs || 0) + frameMs;
      if (isSpeech) {
        state.manualLastSpeechAudioMs = state.manualAudioMs;
        return;
      }
      // Mid-turn dip below the gate: the REAL (quiet) audio was forwarded, not
      // zeroed silence — zeroing punches holes into soft consonants and makes
      // Gemini drop words. The gate only drives end-of-turn timing here.
      state.noiseSuppressedFrames++;
      if (
        state.noiseSuppressedFrames === 1 ||
        state.noiseSuppressedFrames % 100 === 0
      ) {
        this.logger.debug(
          `Forwarding low-level caller audio as-is callId=${state.callId} frames=${state.noiseSuppressedFrames} dbfs=${dbfs.toFixed(1)} gate=${noiseGateDbfs.toFixed(1)}`,
        );
      }
      const localSilenceMs =
        state.manualAudioMs - (state.manualLastSpeechAudioMs || 0);
      if (localSilenceMs >= preset.silenceDurationMs) {
        state.speechActive = false;
        state.manualActivityActive = false;
        state.gemini.sendActivityEnd();
        this.logger.log(
          `Gemini Live local activity end callId=${state.callId} localSilenceMs=${localSilenceMs} dbfs=${dbfs.toFixed(1)} gate=${noiseGateDbfs.toFixed(1)}`,
        );
      }
      return;
    }

    if (!state.speechActive) {
      // A short sound while the agent is talking is a backchannel ("mm-hmm"),
      // not a real interruption, so it must be sustained longer before we cut
      // the agent off.
      const onsetMs =
        state.assistantAudioActive && !state.preventInterruption
          ? BACKCHANNEL_INTERRUPT_MS
          : SPEECH_ONSET_VALIDATION_MS;
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
      return;
    }

    // Automatic mode with speech active: Gemini's server-side VAD owns the
    // turn; we forward the real audio and only keep a local silence fallback.
    state.gemini.sendAudio(resampledReal);
    state.manualAudioMs = (state.manualAudioMs || 0) + frameMs;
    if (isSpeech) {
      state.manualLastSpeechAudioMs = state.manualAudioMs;
      return;
    }
    state.noiseSuppressedFrames++;
    const localSilenceMs =
      state.manualAudioMs - (state.manualLastSpeechAudioMs || 0);
    if (localSilenceMs >= AUTOMATIC_SILENCE_RESET_MS) {
      state.speechActive = false;
      state.speechDetectionMs = 0;
      state.speechBuffer = [];
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

  // Reset onset validation without touching an open manual turn — closing that
  // is forwardAudio's job (see the manualActivityActive branch).
  private resetSpeechDetection(state: ActiveCallSession) {
    state.speechDetectionMs = 0;
    state.speechBuffer = [];
    if (!state.manualActivityActive) state.speechActive = false;
  }

  private bufferPendingAssistantAudio(
    state: ActiveCallSession,
    payload: string,
  ) {
    const pending = (state.pendingOutboundAudio ||= []);
    pending.push(payload);
    state.pendingOutboundBytes =
      (state.pendingOutboundBytes || 0) + payload.length;
    while (
      pending.length > 1 &&
      state.pendingOutboundBytes > MAX_PENDING_OUTBOUND_CHARS
    ) {
      const dropped = pending.shift();
      state.pendingOutboundBytes -= dropped?.length || 0;
    }
  }

  private flushPendingAssistantAudio(state: ActiveCallSession, ws: WebSocket) {
    const pending = state.pendingOutboundAudio;
    state.pendingOutboundAudio = [];
    state.pendingOutboundBytes = 0;
    if (!pending?.length) return;
    if (!state.streamSid || ws.readyState !== WebSocket.OPEN) return;
    for (const payload of pending) {
      this.sendAudioFrame(state, ws, payload);
    }
    this.logger.log(
      `Flushed buffered assistant audio callId=${state.callId} frames=${pending.length}`,
    );
  }

  // Twilio expects {event:'media', streamSid, media:{payload}}. Plivo's
  // bidirectional Stream expects {event:'playAudio', streamId, media:{
  // contentType, sampleRate, payload}} — per Plivo's own Java Stream SDK
  // (PlivoStreamingHandler.playAudio), every outgoing message must carry the
  // streamId from the start event or Plivo has no stream to route the audio
  // into and silently drops it (confirmed: this was why the agent stayed
  // silent on Plivo calls even though inbound transcription worked fine).
  private sendAudioFrame(
    state: ActiveCallSession,
    ws: WebSocket,
    payload: string,
  ) {
    if (state.provider === 'plivo') {
      ws.send(
        JSON.stringify({
          event: 'playAudio',
          streamId: state.streamSid,
          media: {
            contentType: 'audio/x-mulaw',
            sampleRate: 8000,
            payload,
          },
        }),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        event: 'media',
        streamSid: state.streamSid,
        media: { payload },
      }),
    );
  }

  // Twilio's barge-in interrupt clears queued audio with {event:'clear'};
  // Plivo's equivalent is {event:'clearAudio', streamId}.
  private sendClearFrame(state: ActiveCallSession, ws: WebSocket) {
    if (state.provider === 'plivo') {
      ws.send(
        JSON.stringify({ event: 'clearAudio', streamId: state.streamSid }),
      );
      return;
    }
    ws.send(JSON.stringify({ event: 'clear', streamSid: state.streamSid }));
  }

  // Twilio echoes back {event:'mark', mark:{name}} once playback reaches that
  // point; Plivo's equivalent is {event:'checkpoint', streamId, name}.
  private sendMarkFrame(state: ActiveCallSession, ws: WebSocket, name: string) {
    if (state.provider === 'plivo') {
      ws.send(
        JSON.stringify({
          event: 'checkpoint',
          streamId: state.streamSid,
          name,
        }),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        event: 'mark',
        streamSid: state.streamSid,
        mark: { name },
      }),
    );
  }

  private attachGeminiEvents(
    ws: WebSocket,
    state: ActiveCallSession,
    gemini: GeminiLiveSessionWrapper,
  ) {
    gemini.on('audio_chunk', (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      state.assistantAudioActive = true;
      this.resetSpeechDetection(state);
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
      // Greeting audio can be generated before the Twilio start frame arrives;
      // hold it until streamSid is known instead of dropping it.
      if (!state.streamSid) {
        this.bufferPendingAssistantAudio(state, payload);
        return;
      }
      this.sendAudioFrame(state, ws, payload);
    });

    gemini.on('interrupted', () => {
      state.assistantAudioActive = false;
      state.pendingOutboundAudio = [];
      state.pendingOutboundBytes = 0;
      if (
        state.preventInterruption ||
        !state.streamSid ||
        ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      this.sendClearFrame(state, ws);
    });

    gemini.on('user_transcript_final', (text: string) => {
      state.userTurns++;
      state.lastUserTranscriptAt = Date.now();
      state.awaitingModelAudioAfterUser = true;
      this.resetSpeechDetection(state);
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
      this.resetSpeechDetection(state);
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
        this.sendMarkFrame(state, ws, `agent-turn-${Date.now()}`);
      }
    });

    gemini.on('session_handle', (handle: string) => {
      state.resumeHandle = handle;
    });

    gemini.on('go_away', (timeLeft: unknown) => {
      // The server will close this connection shortly; the close handler
      // reconnects with the resumption handle, so just leave a trace here.
      this.logger.warn(
        `Gemini Live goAway received callId=${state.callId} timeLeft=${String(timeLeft ?? 'unknown')}`,
      );
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
    const resuming = Boolean(state.resumeHandle);
    this.logger.warn(
      `Gemini socket dropped mid-call; reconnecting callId=${state.callId} attempt=${state.reconnectAttempts} resuming=${resuming}`,
    );
    try {
      await this.connectGemini(state, ws);
      state.manualActivityActive = false;
      state.speechActive = false;
      // With a resumption handle the session continues where it left off; only
      // a blank session needs the model prompted into a natural recovery.
      if (!resuming) state.gemini?.sendText('[RESUME]');
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
    return buildCallTools(state, {
      logger: this.logger,
      db: this.db,
      botService: this.botService,
    });
  }

  private buildSystemInstruction(state: ActiveCallSession) {
    return buildCallSystemInstruction({
      campaign: state.campaign || {},
      contact: state.contact || {},
      languageProfile: getLanguageProfile(this.resolveSelectedLanguage(state)),
      liveVoiceName: extractHdVoiceName(this.resolveSelectedVoice(state)),
    });
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
    return normalizeGoogleVoiceForLanguage(raw, language);
  }

  private parseNumber(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
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

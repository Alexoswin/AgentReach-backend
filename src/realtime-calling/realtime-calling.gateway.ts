import { Injectable, Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { MongoService } from '../mongo.service';
import { BotService } from '../bot/bot.service';
import { GeminiLiveAuthService } from './gemini-live-auth.service';
import { GeminiLiveSessionWrapper } from './gemini-live-session.wrapper';
import { ResponseSpeed, getResponseSpeedPreset } from './response-speed';
import {
  calculateDbfs,
  decodeUlawToPcm16,
  resamplePcm16,
  transcodePcm24kToUlaw8k,
} from './audio-codec';

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
  pendingScriptWrites: Promise<void>[];
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
      pendingScriptWrites: [],
    };

    ws.on('message', (raw) => {
      void this.handleTwilioMessage(ws, state, raw.toString()).catch((error) => {
        this.logger.error(error?.message || error);
        this.appendError(state.callId, error).catch(() => undefined);
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
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

    const call = await this.db.callHistory.findUnique({
      where: { id: callId },
      include: { contact: true, campaign: true },
    });
    if (!call?.campaign) {
      this.logger.warn(`Twilio stream start call not found callId=${callId}`);
      ws.close(1008, 'Call not found');
      return;
    }

    state.call = call;
    state.campaign = call.campaign;
    state.contact = call.contact;
    state.preventInterruption = call.campaign.preventInterruption === true;
    const responseSpeedPreset = getResponseSpeedPreset(
      call.campaign.responseSpeed,
    );
    state.responseSpeed = responseSpeedPreset.responseSpeed;
    state.noiseGateDbfs = responseSpeedPreset.noiseGateDbfs;
    this.sessions.set(callId, state);

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

    const { tools, handlers } = this.buildTools(state);
    const model =
      state.campaign.realtimeModel ||
      process.env.GEMINI_LIVE_MODEL ||
      'gemini-2.5-flash-native-audio-preview-12-2025';
    const languageCode = this.resolveSelectedLanguage(state);
    const selectedVoice = this.resolveSelectedVoice(state);
    const voiceName = this.extractVoiceName(selectedVoice);
    const languageProfile = this.getLanguageProfile(languageCode);
    this.logger.log(
      `Starting Gemini Live call callId=${callId} campaignId=${state.campaign.id || call.campaignId} streamSid=${state.streamSid || 'none'} providerCallSid=${state.providerCallSid || 'none'} model=${model} voice=${voiceName} selectedVoice=${selectedVoice} requestedLanguage=${languageCode} campaignLanguage=${state.campaign.selectedLanguage || state.campaign.language || 'none'} callLanguage=${call.selectedLanguage || 'none'} campaignVoice=${state.campaign.selectedVoice || state.campaign.voice || 'none'} callVoice=${call.selectedVoice || 'none'} spokenLanguage=${languageProfile.spokenLanguage} responseSpeed=${responseSpeedPreset.responseSpeed} activityDetection=${responseSpeedPreset.activityDetection} vadSilenceMs=${responseSpeedPreset.silenceDurationMs} noiseGateDbfs=${responseSpeedPreset.noiseGateDbfs} aiSpeaksFirst=${state.campaign.aiSpeaksFirst !== false} preventInterruption=${state.preventInterruption} tools=${tools.map((tool: any) => tool.name).join(',') || 'none'}`,
    );
    const gemini = new GeminiLiveSessionWrapper(this.geminiAuthService, {
      model,
      voiceName,
      languageCode,
      responseSpeed: responseSpeedPreset.responseSpeed,
      systemInstruction: this.buildSystemInstruction(state),
      tools,
      toolHandlers: handlers,
      maxOutputTokens: this.parseNumber(state.campaign.maxTokens, 4000),
      inputSampleRate: 16000,
    });
    state.gemini = gemini;
    this.attachGeminiEvents(ws, state, gemini);

    state.setupStartedAt = Date.now();
    await gemini.connect();
    await gemini.waitForSetupComplete();
    state.setupCompletedAt = Date.now();
    this.logger.log(
      `Gemini Live setup ready callId=${callId} setupMs=${
        state.setupCompletedAt - state.setupStartedAt
      }`,
    );
    if (state.campaign.aiSpeaksFirst !== false) {
      gemini.sendText('[SIGNAL_START]');
      this.logger.log(`Gemini Live start signal sent callId=${callId}`);
    } else {
      this.logger.log(`Gemini Live waiting for contact to speak first callId=${callId}`);
    }
  }

  private forwardAudio(state: ActiveCallSession, payload: string) {
    if (!state.gemini || state.gemini.isClosed()) return;
    const pcm = decodeUlawToPcm16(payload);
    const dbfs = calculateDbfs(pcm);
    if (state.preventInterruption && state.assistantAudioActive) {
      return;
    }
    const preset = getResponseSpeedPreset(state.responseSpeed);
    const noiseGateDbfs = Number.isFinite(state.noiseGateDbfs)
      ? state.noiseGateDbfs
      : preset.noiseGateDbfs;
    const isSpeech = dbfs >= noiseGateDbfs;
    if (preset.activityDetection === 'manual') {
      const frameMs = Math.max(1, Math.round((pcm.length / 2 / 8000) * 1000));
      this.updateManualActivityDetection(
        state,
        dbfs,
        isSpeech,
        noiseGateDbfs,
        frameMs,
        preset,
      );
    }
    if (dbfs < noiseGateDbfs) {
      state.noiseSuppressedFrames++;
      if (
        state.noiseSuppressedFrames === 1 ||
        state.noiseSuppressedFrames % 100 === 0
      ) {
        this.logger.debug(
          `Forwarding low-level caller audio as silence callId=${state.callId} frames=${state.noiseSuppressedFrames} dbfs=${dbfs.toFixed(1)} gate=${noiseGateDbfs}`,
        );
      }
      pcm.fill(0);
    }
    state.gemini.sendAudio(resamplePcm16(pcm, 8000, 16000));
  }

  private updateManualActivityDetection(
    state: ActiveCallSession,
    dbfs: number,
    isSpeech: boolean,
    noiseGateDbfs: number,
    frameMs: number,
    preset: ReturnType<typeof getResponseSpeedPreset>,
  ) {
    if (!state.gemini || state.gemini.isClosed()) return;
    state.manualAudioMs = (state.manualAudioMs || 0) + frameMs;

    if (isSpeech) {
      state.manualLastSpeechAudioMs = state.manualAudioMs;
      if (!state.manualActivityActive) {
        state.manualActivityActive = true;
        state.gemini.sendActivityStart();
        this.logger.debug(
          `Gemini Live local activity start callId=${state.callId} dbfs=${dbfs.toFixed(1)} gate=${noiseGateDbfs}`,
        );
      }
      return;
    }

    if (!state.manualActivityActive || !state.manualLastSpeechAudioMs) return;
    const localSilenceMs = state.manualAudioMs - state.manualLastSpeechAudioMs;
    if (localSilenceMs < preset.silenceDurationMs) return;

    state.manualActivityActive = false;
    state.gemini.sendActivityEnd();
    this.logger.log(
      `Gemini Live local activity end callId=${state.callId} localSilenceMs=${localSilenceMs} dbfs=${dbfs.toFixed(1)} gate=${noiseGateDbfs}`,
    );
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
      this.logger.debug(
        `Gemini Live audio done callId=${state.callId} pendingHangup=${state.pendingHangup}`,
      );
      if (state.pendingHangup) {
        void this.completeCall(state, state.endCallReason || 'end_call');
        if (ws.readyState === WebSocket.OPEN) ws.close();
        return;
      }
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
      void this.cleanupSession(state, 'gemini_live_session_closed');
    });
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
        const results = await this.botService.searchBotKnowledge(botId, query, 4);
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
    const liveVoiceName = this.extractVoiceName(this.resolveSelectedVoice(state));
    const pieces = [
      'You are the live voice agent for an outbound AgentReach call.',
      `Critical voice locale rule: every spoken response must be in ${languageProfile.spokenLanguage} (${languageProfile.code}) using ${languageProfile.accent}.`,
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
      `Contact: ${[
        contact.firstName,
        contact.lastName,
        contact.company,
        contact.jobTitle,
      ]
        .filter(Boolean)
        .join(' ') || 'Unknown contact'}.`,
      contact.notes ? `Contact notes: ${contact.notes}` : '',
      `Language code: ${languageProfile.code}.`,
      `Spoken language: ${languageProfile.spokenLanguage}.`,
      `Accent and locale: ${languageProfile.accent}.`,
      `You must speak only in ${languageProfile.spokenLanguage}. ${languageProfile.instruction}`,
      'Ignore background noise, typing, distant voices, static, and unclear audio. Do not answer or react unless the contact speaks clearly to you.',
      'If the audio is unclear, briefly ask the contact to repeat instead of guessing.',
      'Keep each spoken turn brief and natural. Ask one clear question at a time.',
      'If the contact is busy, ask for a better callback time.',
      'Never claim the call is human. Never invent pricing, policies, or facts.',
      botId
        ? `When specific knowledge-base facts are needed, call fetch_context with bot_id "${botId}" before answering.`
        : '',
      'After a natural closing statement and once the objective is complete, call end_call.',
      campaign.aiSpeaksFirst !== false
        ? 'When you receive [SIGNAL_START], begin with the opening greeting. Do not call tools at the start.'
        : 'Wait for the contact to speak first before greeting.',
    ];

    return pieces.filter(Boolean).join('\n');
  }

  private async appendScript(callId: string, role: string, content: string) {
    if (!callId || !content.trim()) return;
    const call = await this.db.callHistory.findUnique({ where: { id: callId } });
    const scripts = Array.isArray(call?.scripts) ? call.scripts : [];
    const nextScripts = [
      ...scripts,
      { role, content: content.trim(), timestamp: new Date().toISOString() },
    ];
    await this.db.callHistory.update({
      where: { id: callId },
      data: {
        scripts: nextScripts,
        transcript: nextScripts
          .map((item: any) => `${item.role === 'assistant' ? 'AI' : 'User'}: ${item.content}`)
          .join('\n'),
      },
    });
  }

  private queueScriptAppend(
    state: ActiveCallSession,
    role: 'user' | 'assistant',
    content: string,
  ) {
    state.pendingScriptWrites ||= [];
    const write = this.appendScript(state.callId, role, content).catch(
      (error) => {
        this.logger.warn(
          `Could not append transcript callId=${state.callId} role=${role}: ${error?.message || error}`,
        );
      },
    );
    state.pendingScriptWrites.push(write);
  }

  private async waitForScriptWrites(state: ActiveCallSession) {
    const writes = state.pendingScriptWrites || [];
    if (writes.length === 0) return;
    state.pendingScriptWrites = [];
    await Promise.allSettled(writes);
  }

  private async appendError(callId: string, error: unknown) {
    if (!callId) return;
    const call = await this.db.callHistory.findUnique({ where: { id: callId } });
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
    this.logger.log(`Completing Gemini Live call callId=${state.callId} reason=${reason}`);
    state.completed = true;
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
    if (state.callId) {
      this.logger.log(`Cleaning Gemini Live call session callId=${state.callId} reason=${reason}`);
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
      ['PENDING', 'QUEUED', 'QUEUING', 'DIALING', 'RINGING', 'IN_PROGRESS'].includes(
        String(call.outcome || '').toUpperCase(),
      ),
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
          'Use natural Indian English phrasing and pronunciation. Do not switch to American or British English unless the contact asks.',
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
        accent: 'Indian Hindi',
        instruction: 'Speak Hindi naturally. Use English words only if common in Indian conversation.',
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

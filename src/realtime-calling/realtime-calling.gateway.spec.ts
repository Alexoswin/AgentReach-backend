import { RealtimeCallingGateway } from './realtime-calling.gateway';
import { GeminiLiveSessionWrapper } from './gemini-live-session.wrapper';
import {
  calculateDbfs,
  decodeUlawToPcm16,
  transcodePcm24kToUlaw8k,
} from './audio-codec';
import { extractHdVoiceName } from '../config/voice-format';
import { signCallToken } from '../auth/secrets';

describe('RealtimeCallingGateway', () => {
  function createGateway() {
    const db = {
      callHistory: {
        update: jest.fn(async () => ({})),
        findUnique: jest.fn<Promise<any>, any[]>(async () => ({
          id: 'call-1',
          scripts: [],
          sessionErrors: [],
        })),
        findMany: jest.fn(async () => [{ id: 'call-1', outcome: 'ANSWERED' }]),
      },
      callingCampaign: {
        update: jest.fn(async () => ({})),
      },
    };
    const botService = {
      searchBotKnowledge: jest.fn(async () => [
        {
          id: 'chunk-1',
          content: 'Pricing context from the bot knowledge base.',
          score: 0.94,
          metadata: { sourceName: 'pricing.pdf', sourceType: 'pdf' },
        },
      ]),
    };
    const gateway = new RealtimeCallingGateway(
      db as any,
      botService as any,
      {} as any,
    );
    return { gateway, db, botService };
  }

  it('dispatches fetch_context to bot RAG search', async () => {
    const { gateway, botService } = createGateway();
    const state = {
      callId: 'call-1',
      campaign: {
        tools: ['fetch_context'],
        aiCallingBotId: 'bot-1',
      },
      userTurns: 0,
      assistantTurns: 0,
      pendingHangup: false,
      completed: false,
      preventInterruption: false,
    };

    const { handlers } = (gateway as any).buildTools(state);
    const result = await handlers.get('fetch_context')({
      query: 'What is pricing?',
    });

    expect(botService.searchBotKnowledge).toHaveBeenCalledWith(
      'bot-1',
      'What is pricing?',
      4,
    );
    expect(result.context).toEqual([
      'Pricing context from the bot knowledge base.',
    ]);
    expect(result.sources[0].sourceName).toBe('pricing.pdf');
  });

  it('schedules end_call only after a real user turn', async () => {
    const { gateway, db } = createGateway();
    const state: any = {
      callId: 'call-1',
      campaign: { tools: ['end_call'] },
      userTurns: 0,
      assistantTurns: 0,
      pendingHangup: false,
      completed: false,
      preventInterruption: false,
    };
    const { handlers } = (gateway as any).buildTools(state);

    const blocked = await handlers.get('end_call')({ reason: 'done' });
    expect(blocked.status).toContain('cannot be ended yet');
    expect(state.pendingHangup).toBe(false);

    state.userTurns = 1;
    const accepted = await handlers.get('end_call')({ reason: 'qualified' });

    expect(accepted.status).toContain('scheduled');
    expect(state.pendingHangup).toBe(true);
    expect(state.endCallReason).toBe('qualified');
    expect(db.callHistory.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: { endCallReason: 'qualified' },
    });
  });

  it('passes campaign responseSpeed to the Gemini Live wrapper', async () => {
    const { gateway, db } = createGateway();
    let capturedConfig: any;
    const connectSpy = jest
      .spyOn(GeminiLiveSessionWrapper.prototype, 'connect')
      .mockImplementation(function (this: any) {
        capturedConfig = this.config;
        return Promise.resolve();
      });
    const setupSpy = jest
      .spyOn(GeminiLiveSessionWrapper.prototype, 'waitForSetupComplete')
      .mockResolvedValue(undefined);
    const sendTextSpy = jest
      .spyOn(GeminiLiveSessionWrapper.prototype, 'sendText')
      .mockImplementation(() => undefined);

    db.callHistory.findUnique.mockResolvedValueOnce({
      id: 'call-1',
      campaignId: 'campaign-1',
      providerCallSid: undefined,
      startedAt: undefined,
      connectedAt: undefined,
      campaign: {
        id: 'campaign-1',
        aiSpeaksFirst: false,
        responseSpeed: 'balanced',
        selectedLanguage: 'en-IN',
        selectedVoice: 'google:en-IN-Chirp3-HD-Puck',
        tools: [],
      },
      contact: { firstName: 'Ada' },
    });

    try {
      await (gateway as any).startStream(
        { readyState: 1, send: jest.fn(), close: jest.fn() },
        {
          callId: '',
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
          awaitingModelAudioAfterUser: false,
        },
        {
          start: {
            streamSid: 'MZ123',
            callSid: 'CA123',
            customParameters: {
              callId: 'call-1',
              token: signCallToken('call-1'),
            },
          },
        },
      );

      expect(capturedConfig.responseSpeed).toBe('balanced');
      expect(setupSpy).toHaveBeenCalled();
      expect(sendTextSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
      setupSpy.mockRestore();
      sendTextSpy.mockRestore();
    }
  });

  it('forwards true silence as silence so Gemini VAD can close turns', () => {
    const { gateway } = createGateway();
    const gemini = {
      isClosed: jest.fn(() => false),
      sendAudio: jest.fn(),
      sendActivityStart: jest.fn(),
      sendActivityEnd: jest.fn(),
    };
    const state = {
      callId: 'call-1',
      gemini,
      userTurns: 0,
      assistantTurns: 0,
      preventInterruption: false,
      assistantAudioActive: false,
      responseSpeed: 'fast',
      noiseGateDbfs: -50,
      noiseSuppressedFrames: 0,
      manualActivityActive: false,
      manualAudioMs: 0,
    };

    (gateway as any).forwardAudio(
      state,
      Buffer.alloc(160, 0xff).toString('base64'),
    );
    expect(gemini.sendAudio).toHaveBeenCalledTimes(1);
    expect(calculateDbfs(gemini.sendAudio.mock.calls[0][0])).toBe(-100);

    const quietPayload = findPayloadInDbfsRange(-55, -52);
    (gateway as any).forwardAudio(state, quietPayload);

    expect(gemini.sendAudio).toHaveBeenCalledTimes(2);
  });

  it('only blocks caller audio during active assistant playback', () => {
    const { gateway } = createGateway();
    const gemini = {
      isClosed: jest.fn(() => false),
      sendAudio: jest.fn(),
      sendActivityStart: jest.fn(),
      sendActivityEnd: jest.fn(),
    };
    const state = {
      callId: 'call-1',
      gemini,
      userTurns: 0,
      assistantTurns: 1,
      preventInterruption: true,
      assistantAudioActive: false,
      responseSpeed: 'fast',
      noiseGateDbfs: -50,
      noiseSuppressedFrames: 0,
      manualActivityActive: false,
      manualAudioMs: 0,
    };
    const speechPayload = findPayloadInDbfsRange(-50, -45);

    (gateway as any).forwardAudio(state, speechPayload);
    expect(gemini.sendAudio).toHaveBeenCalledTimes(1);

    state.assistantAudioActive = true;
    (gateway as any).forwardAudio(state, speechPayload);
    expect(gemini.sendAudio).toHaveBeenCalledTimes(1);
  });

  it('sends manual activity start and end for fast response speed', () => {
    const { gateway } = createGateway();
    const gemini = {
      isClosed: jest.fn(() => false),
      sendAudio: jest.fn(),
      sendActivityStart: jest.fn(),
      sendActivityEnd: jest.fn(),
    };
    const state = {
      callId: 'call-1',
      gemini,
      preventInterruption: false,
      assistantAudioActive: false,
      responseSpeed: 'fast',
      noiseGateDbfs: -50,
      noiseSuppressedFrames: 0,
      manualActivityActive: false,
      manualAudioMs: 0,
    };
    const speechPayload = findPayloadInDbfsRange(-50, -45);
    const silencePayload = Buffer.alloc(160, 0xff).toString('base64');

    for (let i = 0; i < 10; i++) {
      (gateway as any).forwardAudio(state, speechPayload);
    }
    expect(gemini.sendActivityStart).toHaveBeenCalledTimes(1);
    expect(gemini.sendActivityEnd).not.toHaveBeenCalled();

    for (let i = 0; i < 9; i++) {
      (gateway as any).forwardAudio(state, silencePayload);
    }

    expect(gemini.sendActivityEnd).toHaveBeenCalledTimes(1);
  });

  it('closes a manual turn even when local speech flags were reset externally', () => {
    const { gateway } = createGateway();
    const gemini = {
      isClosed: jest.fn(() => false),
      sendAudio: jest.fn(),
      sendActivityStart: jest.fn(),
      sendActivityEnd: jest.fn(),
    };
    const state: any = {
      callId: 'call-1',
      gemini,
      preventInterruption: false,
      assistantAudioActive: false,
      responseSpeed: 'fast',
      noiseGateDbfs: -50,
      noiseSuppressedFrames: 0,
      manualActivityActive: false,
      manualAudioMs: 0,
    };
    const speechPayload = findPayloadInDbfsRange(-50, -45);
    const silencePayload = Buffer.alloc(160, 0xff).toString('base64');

    for (let i = 0; i < 10; i++) {
      (gateway as any).forwardAudio(state, speechPayload);
    }
    expect(gemini.sendActivityStart).toHaveBeenCalledTimes(1);

    // Simulate the resets that assistant audio chunks / transcript finals used
    // to apply mid-turn. The open activity must still be closed afterwards,
    // otherwise Gemini waits forever for activityEnd and the line goes dead.
    state.speechActive = false;
    state.speechDetectionMs = 0;
    state.speechBuffer = [];

    for (let i = 0; i < 10; i++) {
      (gateway as any).forwardAudio(state, silencePayload);
    }

    expect(gemini.sendActivityStart).toHaveBeenCalledTimes(1);
    expect(gemini.sendActivityEnd).toHaveBeenCalledTimes(1);
  });

  it('buffers assistant audio arriving before streamSid and flushes it at start', () => {
    const { gateway } = createGateway();
    const { EventEmitter } = require('node:events');
    const gemini = new EventEmitter();
    gemini.getUsage = () => ({ totalTokenCount: 0 });
    const ws = { readyState: 1, send: jest.fn(), close: jest.fn() };
    const state: any = {
      callId: 'call-1',
      assistantAudioActive: false,
      outboundAudioLogged: false,
      responseSpeed: 'fast',
      awaitingModelAudioAfterUser: false,
      manualActivityActive: false,
      pendingOutboundAudio: [],
      pendingOutboundBytes: 0,
      gemini,
    };

    (gateway as any).attachGeminiEvents(ws, state, gemini);
    gemini.emit('audio_chunk', Buffer.alloc(480 * 2));

    expect(ws.send).not.toHaveBeenCalled();
    expect(state.pendingOutboundAudio.length).toBe(1);

    state.streamSid = 'MZ123';
    (gateway as any).flushPendingAssistantAudio(state, ws);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.event).toBe('media');
    expect(sent.streamSid).toBe('MZ123');
    expect(state.pendingOutboundAudio.length).toBe(0);
  });

  it('does not repeatedly start activity for low-level noise', () => {
    const { gateway } = createGateway();
    const gemini = {
      isClosed: jest.fn(() => false),
      sendAudio: jest.fn(),
      sendActivityStart: jest.fn(),
      sendActivityEnd: jest.fn(),
    };
    const state = {
      callId: 'call-1',
      gemini,
      preventInterruption: false,
      assistantAudioActive: false,
      responseSpeed: 'fast',
      noiseGateDbfs: -50,
      noiseSuppressedFrames: 0,
      manualActivityActive: false,
      manualAudioMs: 0,
    };
    const noisePayload = findPayloadInDbfsRange(-55, -52);

    (gateway as any).forwardAudio(state, noisePayload);
    (gateway as any).forwardAudio(state, noisePayload);

    expect(gemini.sendActivityStart).not.toHaveBeenCalled();
    expect(gemini.sendActivityEnd).not.toHaveBeenCalled();
  });

  it('keeps balanced response speed on automatic Gemini activity detection', () => {
    const { gateway } = createGateway();
    const gemini = {
      isClosed: jest.fn(() => false),
      sendAudio: jest.fn(),
      sendActivityStart: jest.fn(),
      sendActivityEnd: jest.fn(),
    };
    const state = {
      callId: 'call-1',
      gemini,
      preventInterruption: false,
      assistantAudioActive: false,
      responseSpeed: 'balanced',
      noiseGateDbfs: -48,
      noiseSuppressedFrames: 0,
      manualActivityActive: false,
      manualAudioMs: 0,
    };
    const speechPayload = findPayloadInDbfsRange(-48, -44);

    (gateway as any).forwardAudio(state, speechPayload);

    expect(gemini.sendActivityStart).not.toHaveBeenCalled();
    expect(gemini.sendActivityEnd).not.toHaveBeenCalled();
  });

  it('builds explicit spoken language and accent instructions', () => {
    const { gateway } = createGateway();
    const instruction = (gateway as any).buildSystemInstruction({
      campaign: {
        selectedLanguage: 'en-IN',
        selectedVoice: 'google:en-IN-Chirp3-HD-Fenrir',
        aiSpeaksFirst: true,
      },
      contact: { firstName: 'Ada' },
    });

    expect(instruction).toContain('Selected Gemini Live voice: Fenrir.');
    expect(instruction).toContain(
      'Begin in English (en-IN) with Indian English.',
    );
    expect(instruction).toContain(
      'if the contact speaks or asks for another language, switch to it',
    );
    expect(instruction).toContain('casual, natural Indian English');
    expect(instruction).toContain('Ignore background noise');
  });

  it('extracts Gemini Live voice names from stored Google voice ids', () => {
    expect(extractHdVoiceName('google:en-IN-Chirp3-HD-Puck')).toBe('Puck');
    expect(extractHdVoiceName('google:en-IN-Chirp3-HD-fenrir')).toBe('Fenrir');
  });

  it('resolves selected voice using the active selected language', () => {
    const { gateway } = createGateway();
    const state = {
      campaign: {
        selectedLanguage: 'hi-IN',
        selectedVoice: 'google:en-IN-Chirp3-HD-Fenrir',
      },
      call: {},
    };

    expect((gateway as any).resolveSelectedLanguage(state)).toBe('hi-IN');
    expect((gateway as any).resolveSelectedVoice(state)).toBe(
      'google:hi-IN-Chirp3-HD-Fenrir',
    );
  });

  it('prefers per-call selected voice and language over stale campaign values', () => {
    const { gateway } = createGateway();
    const state = {
      campaign: {
        selectedLanguage: 'en-IN',
        selectedVoice: 'google:en-IN-Chirp3-HD-Puck',
      },
      call: {
        selectedLanguage: 'hi-IN',
        selectedVoice: 'google:hi-IN-Chirp3-HD-Fenrir',
      },
    };

    expect((gateway as any).resolveSelectedLanguage(state)).toBe('hi-IN');
    expect((gateway as any).resolveSelectedVoice(state)).toBe(
      'google:hi-IN-Chirp3-HD-Fenrir',
    );
  });

  it('does not trigger activity start for short noises (< 200ms)', () => {
    const { gateway } = createGateway();
    const gemini = {
      isClosed: jest.fn(() => false),
      sendAudio: jest.fn(),
      sendActivityStart: jest.fn(),
      sendActivityEnd: jest.fn(),
    };
    const state = {
      callId: 'call-1',
      gemini,
      preventInterruption: false,
      assistantAudioActive: false,
      responseSpeed: 'fast',
      noiseGateDbfs: -50,
      noiseSuppressedFrames: 0,
      manualActivityActive: false,
      manualAudioMs: 0,
    };
    const speechPayload = findPayloadInDbfsRange(-50, -45);

    // Send 5 frames of speech (100ms)
    for (let i = 0; i < 5; i++) {
      (gateway as any).forwardAudio(state, speechPayload);
    }
    expect(gemini.sendActivityStart).not.toHaveBeenCalled();

    // Send silence payload to reset
    const silencePayload = Buffer.alloc(160, 0xff).toString('base64');
    (gateway as any).forwardAudio(state, silencePayload);

    expect(gemini.sendActivityStart).not.toHaveBeenCalled();
  });

  function findPayloadInDbfsRange(min: number, max: number) {
    for (let amplitude = 1; amplitude < 400; amplitude++) {
      const pcm = Buffer.alloc(480 * 2);
      for (let index = 0; index < 480; index++) {
        pcm.writeInt16LE(amplitude, index * 2);
      }
      const payload = transcodePcm24kToUlaw8k(pcm).toString('base64');
      const dbfs = calculateDbfs(decodeUlawToPcm16(payload));
      if (dbfs > min && dbfs < max) return payload;
    }
    throw new Error(`No payload found between ${min} and ${max} dBFS.`);
  }
});

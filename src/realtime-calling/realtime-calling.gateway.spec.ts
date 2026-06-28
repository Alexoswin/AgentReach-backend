import { RealtimeCallingGateway } from './realtime-calling.gateway';
import { GeminiLiveSessionWrapper } from './gemini-live-session.wrapper';
import {
  calculateDbfs,
  decodeUlawToPcm16,
  transcodePcm24kToUlaw8k,
} from './audio-codec';

describe('RealtimeCallingGateway', () => {
  function createGateway() {
    const db = {
      callHistory: {
        update: jest.fn(async () => ({})),
        findUnique: jest.fn(async () => ({
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
    const state = {
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
            customParameters: { callId: 'call-1' },
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
    };
    const state = {
      callId: 'call-1',
      gemini,
      userTurns: 0,
      assistantTurns: 0,
      preventInterruption: false,
      assistantAudioActive: false,
      responseSpeed: 'fast',
      noiseGateDbfs: -60,
      noiseSuppressedFrames: 0,
    };

    (gateway as any).forwardAudio(state, Buffer.alloc(160, 0xff).toString('base64'));
    expect(gemini.sendAudio).toHaveBeenCalledTimes(1);
    expect(calculateDbfs(gemini.sendAudio.mock.calls[0][0])).toBe(-100);

    const quietPayload = findPayloadInDbfsRange(-60, -55);
    (gateway as any).forwardAudio(state, quietPayload);

    expect(gemini.sendAudio).toHaveBeenCalledTimes(2);
  });

  it('only blocks caller audio during active assistant playback', () => {
    const { gateway } = createGateway();
    const gemini = {
      isClosed: jest.fn(() => false),
      sendAudio: jest.fn(),
    };
    const state = {
      callId: 'call-1',
      gemini,
      userTurns: 0,
      assistantTurns: 1,
      preventInterruption: true,
      assistantAudioActive: false,
      responseSpeed: 'fast',
      noiseGateDbfs: -60,
      noiseSuppressedFrames: 0,
    };
    const speechPayload = findPayloadInDbfsRange(-60, -55);

    (gateway as any).forwardAudio(state, speechPayload);
    expect(gemini.sendAudio).toHaveBeenCalledTimes(1);

    state.assistantAudioActive = true;
    (gateway as any).forwardAudio(state, speechPayload);
    expect(gemini.sendAudio).toHaveBeenCalledTimes(1);
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

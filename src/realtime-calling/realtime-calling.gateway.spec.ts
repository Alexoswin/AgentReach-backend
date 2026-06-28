import { RealtimeCallingGateway } from './realtime-calling.gateway';

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
});

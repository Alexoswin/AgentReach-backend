import { BotService } from './bot.service';
import { embedLocally } from './bot.utils';

function createBotDb() {
  const bots = new Map<string, any>();
  const embeddings: any[] = [];

  return {
    aiCallingBot: {
      create: jest.fn(async ({ data }) => {
        const bot = {
          id: 'bot-1',
          ragEnabled: true,
          contextOutsideKnowledgeBase: false,
          ...data,
        };
        bots.set(bot.id, bot);
        return bot;
      }),
      findUnique: jest.fn(async ({ where }) => bots.get(where.id) || null),
      update: jest.fn(async ({ where, data }) => {
        const bot = { ...(bots.get(where.id) || {}), ...data };
        bots.set(where.id, bot);
        return bot;
      }),
      delete: jest.fn(),
      findMany: jest.fn(async () => Array.from(bots.values())),
    },
    aiCallingBotEmbedding: {
      create: jest.fn(async ({ data }) => {
        const item = { id: `emb-${embeddings.length + 1}`, ...data };
        embeddings.push(item);
        return item;
      }),
      findMany: jest.fn(async () => embeddings),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    embeddings,
  };
}

describe('BotService', () => {
  it('creates a bot, trains knowledge chunks, and searches them', async () => {
    const db = createBotDb();
    const service = new BotService(db as any);

    const bot = await service.create({
      name: 'Sales Assistant',
      knowledgeBaseText:
        'ReachConvert pricing includes automated calls, bot RAG, and campaign analytics.',
    });

    expect(bot.id).toBe('bot-1');
    expect(db.aiCallingBotEmbedding.create).toHaveBeenCalled();

    const results = await service.searchBotKnowledge(
      'bot-1',
      'campaign analytics pricing',
      3,
    );
    expect(results[0]?.content).toContain('ReachConvert pricing');
  });

  it('reads legacy Mple-style embeddings field during search', async () => {
    const db = createBotDb();
    db.embeddings.push({
      id: 'legacy-1',
      botId: 'bot-1',
      content: 'Legacy vector field content about onboarding calls.',
      embeddings: embedLocally('onboarding calls'),
      metadata: { sourceName: 'legacy' },
    });
    const service = new BotService(db as any);

    const results = await service.searchBotKnowledge(
      'bot-1',
      'onboarding calls',
      2,
    );

    expect(results).toHaveLength(1);
    expect(results[0].metadata.sourceName).toBe('legacy');
  });

  it('keeps strict chat grounded when no knowledge is available', async () => {
    const db = createBotDb();
    db.aiCallingBot.findUnique.mockResolvedValue({
      id: 'bot-1',
      name: 'Support Bot',
      ragEnabled: true,
      contextOutsideKnowledgeBase: false,
    });
    db.aiCallingBotEmbedding.findMany.mockResolvedValue([]);
    const service = new BotService(db as any);

    const response = await service.chat('bot-1', {
      message: 'What is the refund policy?',
    });

    expect(response.reply).toContain("don't have enough information");
    expect(response.sources).toEqual([]);
  });
});

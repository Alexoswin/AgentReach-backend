import { BadRequestException } from '@nestjs/common';
import { AiCallingBotsService } from './ai-calling-bots.service';

const mockGetText = jest.fn();
const mockDestroy = jest.fn();

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText: mockGetText,
    destroy: mockDestroy,
  })),
}));

describe('AiCallingBotsService.trainFromPdf', () => {
  let service: AiCallingBotsService;

  const pdfFile = (overrides: Partial<Express.Multer.File> = {}) =>
    ({
      originalname: 'training.pdf',
      mimetype: 'application/pdf',
      size: 1024,
      buffer: Buffer.from('%PDF sample'),
      ...overrides,
    }) as Express.Multer.File;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AiCallingBotsService({} as any);
  });

  it('rejects a missing PDF file', async () => {
    await expect(
      service.trainFromPdf('bot-1', undefined as any, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-PDF file', async () => {
    await expect(
      service.trainFromPdf(
        'bot-1',
        pdfFile({ originalname: 'training.txt', mimetype: 'text/plain' }),
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a PDF over 8 MB', async () => {
    await expect(
      service.trainFromPdf('bot-1', pdfFile({ size: 8 * 1024 * 1024 + 1 }), {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a PDF without enough readable text', async () => {
    mockGetText.mockResolvedValueOnce({ text: 'too short', total: 1 });

    await expect(service.trainFromPdf('bot-1', pdfFile(), {})).rejects.toThrow(
      'We could not read enough text from this PDF',
    );
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('trains with extracted text and replace-by-default behavior', async () => {
    const extractedText = 'ReachConvert AI calling bot knowledge. '
      .repeat(8)
      .trim();
    mockGetText.mockResolvedValueOnce({ text: extractedText, total: 3 });
    const trainSpy = jest.spyOn(service, 'train').mockResolvedValueOnce({
      botId: 'bot-1',
      chunksAdded: 2,
      totalChunks: 2,
      status: 'TRAINED',
    });

    const result = await service.trainFromPdf('bot-1', pdfFile(), {});

    expect(trainSpy).toHaveBeenCalledWith(
      'bot-1',
      expect.objectContaining({
        content: extractedText,
        sourceName: 'training.pdf',
        replace: undefined,
        metadata: expect.objectContaining({
          sourceType: 'pdf',
          sourceName: 'training.pdf',
          originalFileName: 'training.pdf',
          pages: 3,
          characters: extractedText.length,
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        botId: 'bot-1',
        chunksAdded: 2,
        totalChunks: 2,
        status: 'TRAINED',
        fileName: 'training.pdf',
        pages: 3,
        characters: extractedText.length,
      }),
    );
  });

  it('preserves append behavior when replace=false is sent', async () => {
    const extractedText = 'Append this PDF training knowledge. '
      .repeat(8)
      .trim();
    mockGetText.mockResolvedValueOnce({ text: extractedText, total: 2 });
    const trainSpy = jest.spyOn(service, 'train').mockResolvedValueOnce({
      botId: 'bot-1',
      chunksAdded: 1,
      totalChunks: 4,
      status: 'TRAINED',
    });

    await service.trainFromPdf('bot-1', pdfFile(), {
      replace: 'false',
      sourceName: 'append-source',
      chunkSize: '700',
      chunkOverlap: '80',
    });

    expect(trainSpy).toHaveBeenCalledWith(
      'bot-1',
      expect.objectContaining({
        replace: false,
        sourceName: 'append-source',
        chunkSize: 700,
        chunkOverlap: 80,
      }),
    );
  });

  it('does not delete existing embeddings until replacement training succeeds', async () => {
    const service = new AiCallingBotsService({
      aiCallingBot: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'bot-1',
          embeddingModel: 'local-hash-embedding-v1',
        }),
      },
      aiCallingBotEmbedding: {
        create: jest
          .fn()
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error('embedding write failed')),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn(),
      },
    } as any);

    const content = 'Replacement safety test content. '.repeat(30);

    await expect(
      service.train('bot-1', {
        content,
        replace: true,
      }),
    ).rejects.toThrow('embedding write failed');

    expect(
      (service as any).db.aiCallingBotEmbedding.deleteMany,
    ).not.toHaveBeenCalled();
  });
});

describe('AiCallingBotsService.createWithKnowledgeBase', () => {
  it('creates and trains from knowledge base text', async () => {
    const service = new AiCallingBotsService({
      aiCallingBot: {
        create: jest.fn().mockResolvedValue({ id: 'bot-1', name: 'Bot One' }),
      },
    } as any);
    const trainSpy = jest
      .spyOn(service, 'train')
      .mockResolvedValue({} as any);
    const trainFromPdfSpy = jest
      .spyOn(service, 'trainFromPdf')
      .mockResolvedValue({} as any);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'bot-1' } as any);

    await service.createWithKnowledgeBase({
      name: 'Bot One',
      knowledgeBaseText: 'Knowledge base content',
    } as any);

    expect(trainSpy).toHaveBeenCalledWith(
      'bot-1',
      expect.objectContaining({
        sourceName: 'knowledge-base-text',
        replace: true,
      }),
    );
    expect(trainFromPdfSpy).not.toHaveBeenCalled();
  });

  it('creates and trains from PDF when provided', async () => {
    const service = new AiCallingBotsService({
      aiCallingBot: {
        create: jest.fn().mockResolvedValue({ id: 'bot-2', name: 'Bot Two' }),
      },
    } as any);
    const trainSpy = jest
      .spyOn(service, 'train')
      .mockResolvedValue({} as any);
    const trainFromPdfSpy = jest
      .spyOn(service, 'trainFromPdf')
      .mockResolvedValue({} as any);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'bot-2' } as any);

    await service.createWithKnowledgeBase(
      { name: 'Bot Two' } as any,
      {
        originalname: 'kb.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        buffer: Buffer.from('pdf'),
      },
    );

    expect(trainSpy).not.toHaveBeenCalled();
    expect(trainFromPdfSpy).toHaveBeenCalledWith(
      'bot-2',
      expect.any(Object),
      expect.objectContaining({ replace: 'true', sourceName: 'kb.pdf' }),
    );
  });

  it('appends PDF training after KB text training', async () => {
    const service = new AiCallingBotsService({
      aiCallingBot: {
        create: jest.fn().mockResolvedValue({ id: 'bot-3', name: 'Bot Three' }),
      },
    } as any);
    const trainSpy = jest
      .spyOn(service, 'train')
      .mockResolvedValue({} as any);
    const trainFromPdfSpy = jest
      .spyOn(service, 'trainFromPdf')
      .mockResolvedValue({} as any);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'bot-3' } as any);

    await service.createWithKnowledgeBase(
      {
        name: 'Bot Three',
        knowledgeBaseText: 'Primary KB content',
      } as any,
      {
        originalname: 'kb.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        buffer: Buffer.from('pdf'),
      },
    );

    expect(trainSpy).toHaveBeenCalledTimes(1);
    expect(trainFromPdfSpy).toHaveBeenCalledWith(
      'bot-3',
      expect.any(Object),
      expect.objectContaining({ replace: 'false' }),
    );
  });
});

describe('AiCallingBotsService.chat knowledge boundary', () => {
  it('returns strict fallback when contextOutsideKnowledgeBase is false and no retrieval results', async () => {
    const service = new AiCallingBotsService({} as any);
    jest.spyOn(service, 'findOne').mockResolvedValue({
      id: 'bot-1',
      name: 'Bot',
      role: 'specialist',
      personality: 'calm',
      ragEnabled: true,
      contextOutsideKnowledgeBase: false,
    } as any);
    jest.spyOn(service, 'searchBotKnowledge').mockResolvedValue([]);

    const result = await service.chat('bot-1', { message: 'What is pricing?' });
    expect(String((result as any).reply || '')).toMatch(
      /don't have enough information in the knowledge base/i,
    );
  });

  it('continues when contextOutsideKnowledgeBase is true and no retrieval results', async () => {
    const service = new AiCallingBotsService({} as any);
    jest.spyOn(service, 'findOne').mockResolvedValue({
      id: 'bot-2',
      name: 'Bot',
      role: 'specialist',
      personality: 'calm',
      ragEnabled: true,
      contextOutsideKnowledgeBase: true,
    } as any);
    jest.spyOn(service, 'searchBotKnowledge').mockResolvedValue([]);
    jest
      .spyOn(service as any, 'generateChatReplyWithGemini')
      .mockResolvedValue('');

    const result = await service.chat('bot-2', { message: 'Hello' });
    expect(String((result as any).reply || '').length).toBeGreaterThan(0);
  });
});

describe('AiCallingBotsService embeddings', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses the current Gemini embedding model by default', async () => {
    const service = new AiCallingBotsService(
      {
        systemSettings: {
          findUnique: jest.fn().mockResolvedValue({}),
        },
      } as any,
      {
        get: jest.fn((key: string) => {
          if (key === 'GEMINI_API_KEY') return 'gemini-key';
          return undefined;
        }),
      } as any,
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        embeddings: [{ values: [0.1, 0.2, 0.3] }],
      }),
    });

    const result = await (service as any).embedManyChunks(
      ['ReachConvert knowledge'],
      'document',
    );

    expect(result.model).toBe('gemini-embedding-001');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        '/models/gemini-embedding-001:batchEmbedContents?key=gemini-key',
      ),
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.requests[0]).toEqual(
      expect.objectContaining({
        model: 'models/gemini-embedding-001',
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: 384,
      }),
    );
  });
});

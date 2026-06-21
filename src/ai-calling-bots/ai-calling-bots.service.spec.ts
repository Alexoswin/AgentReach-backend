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

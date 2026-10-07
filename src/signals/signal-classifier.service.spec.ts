import { DEFAULT_GEMINI_TEXT_MODEL } from '../config/gemini-text';
import { SignalClassifierService } from './signal-classifier.service';

const generateContent = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent },
  })),
}));

const RAW = {
  source: 'news-rss',
  companyName: 'Acme',
  companyDomain: 'acme.com',
  title: 'Acme raises a $20M Series B',
  summary: 'Acme announced a Series B round led by Example Ventures.',
  url: 'https://example.com/acme',
} as any;

function classifierWith(env: { geminiApiKey?: string; geminiTextModel?: string }) {
  if (env.geminiApiKey) process.env.GEMINI_API_KEY = env.geminiApiKey;
  else delete process.env.GEMINI_API_KEY;
  if (env.geminiTextModel) process.env.GEMINI_TEXT_MODEL = env.geminiTextModel;
  else delete process.env.GEMINI_TEXT_MODEL;
  return new SignalClassifierService();
}

describe('SignalClassifierService', () => {
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_TEXT_MODEL;
  });

  beforeEach(() => {
    generateContent.mockReset();
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        type: 'funding',
        confidence: 'high',
        summary: 'Acme raised a Series B.',
        entities: { roundStage: 'Series B' },
      }),
    });
  });

  it('uses the platform Gemini text model', async () => {
    const classifier = classifierWith({
      geminiApiKey: 'key',
      geminiTextModel: 'gemini-2.5-flash',
    });

    await classifier.classify(RAW);

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.5-flash' }),
    );
  });

  it('maps a retired model id to the current default', async () => {
    const classifier = classifierWith({
      geminiApiKey: 'key',
      geminiTextModel: 'gemini-2.0-flash',
    });

    await classifier.classify(RAW);

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_GEMINI_TEXT_MODEL }),
    );
  });

  it('uses the default model when none is configured', async () => {
    const classifier = classifierWith({ geminiApiKey: 'key' });

    await classifier.classify(RAW);

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_GEMINI_TEXT_MODEL }),
    );
  });

  it('falls back to the keyword heuristic when Gemini fails', async () => {
    generateContent.mockRejectedValue(new Error('model not found'));
    const classifier = classifierWith({ geminiApiKey: 'key' });

    const result = await classifier.classify(RAW);

    expect(result.type).toBeDefined();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

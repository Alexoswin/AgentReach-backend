import { DEFAULT_GEMINI_TEXT_MODEL } from '../config/gemini-text';
import { SettingsService } from '../settings/settings.service';
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

function classifierWith(settings: Record<string, unknown> | null) {
  const settingsService = {
    getRawSettings: jest.fn().mockResolvedValue(settings),
  } as unknown as SettingsService;
  return new SignalClassifierService(settingsService);
}

describe('SignalClassifierService', () => {
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

  it('uses the Gemini text model saved in Settings', async () => {
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

  it('uses the default model when Settings has none', async () => {
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

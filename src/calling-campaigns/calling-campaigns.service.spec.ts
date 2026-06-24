import { CallingCampaignsService } from './calling-campaigns.service';

describe('CallingCampaignsService.resolveTwilioVoice', () => {
  it('keeps the selected voice mapping when a campaign voice is provided', () => {
    const service = Object.create(CallingCampaignsService.prototype);

    expect(service.resolveTwilioVoice('Puck', 'en-IN')).toBe(
      'Google.en-IN-Wavenet-D',
    );
    expect(service.resolveTwilioVoice('Fenrir', 'en-IN')).toBe(
      'Google.en-IN-Wavenet-D',
    );
    expect(service.resolveTwilioVoice('google:en-IN-Chirp3-HD-Kore')).toBe(
      'Google.en-IN-Wavenet-A',
    );
    expect(service.resolveTwilioVoice('google:en-US-Chirp3-HD-Puck')).toBe(
      'Google.en-US-Neural2-D',
    );
    expect(service.resolveTwilioVoice('google:hi-IN-Chirp3-HD-Puck')).toBe(
      'Google.hi-IN-Neural2-C',
    );
  });

  it('rebuilds the HD voice family when the language changes', () => {
    const service = Object.create(CallingCampaignsService.prototype);

    expect(
      service.resolveTwilioVoice('google:en-US-Chirp3-HD-Puck', 'hi-IN'),
    ).toBe('Google.hi-IN-Neural2-C');
    expect(
      service.resolveTwilioVoice('google:en-US-Chirp3-HD-Puck', 'en-IN'),
    ).toBe('Google.en-IN-Wavenet-D');
    expect(
      service.resolveTwilioVoice('google:en-IN-Chirp3-HD-Puck', 'en-US'),
    ).toBe('Google.en-US-Neural2-D');
  });

  it('uses a Google fallback voice when the campaign voice is unknown', () => {
    const service = Object.create(CallingCampaignsService.prototype);

    expect(service.resolveTwilioVoice('UnknownVoice', 'en-IN')).toBe(
      'Google.en-IN-Wavenet-D',
    );
  });
});

describe('CallingCampaignsService.normalizeLanguageCode', () => {
  it('maps hi to hi-IN', () => {
    const service = Object.create(CallingCampaignsService.prototype);
    expect(service.normalizeLanguageCode('hi')).toBe('hi-IN');
    expect(service.normalizeLanguageCode('en-IN')).toBe('en-IN');
    expect(service.normalizeLanguageCode('en')).toBe('en-US');
  });
});

describe('CallingCampaignsService.normalizeCampaignVoiceInput', () => {
  it('maps selectedLanguage/selectedVoice aliases into language/voice', () => {
    const service = Object.create(CallingCampaignsService.prototype);

    const normalized = service.normalizeCampaignVoiceInput({
      selectedLanguage: 'hi-IN',
      selectedVoice: 'google:hi-IN-Chirp3-HD-Kore',
      name: 'Hindi campaign',
    });

    expect(normalized.language).toBe('hi-IN');
    expect(normalized.voice).toBe('google:hi-IN-Chirp3-HD-Kore');
    expect(normalized.selectedLanguage).toBeUndefined();
    expect(normalized.selectedVoice).toBeUndefined();
  });

  it('uses selected language/voice over raw campaign values when both are provided', () => {
    const service = Object.create(CallingCampaignsService.prototype);

    const normalized = service.normalizeCampaignVoiceInput({
      language: 'en-US',
      voice: 'google:en-US-Chirp3-HD-Puck',
      selectedLanguage: 'hi-IN',
      selectedVoice: 'google:hi-IN-Chirp3-HD-Kore',
    });

    expect(normalized.language).toBe('hi-IN');
    expect(normalized.voice).toBe('google:hi-IN-Chirp3-HD-Kore');
    expect(normalized.selectedLanguage).toBeUndefined();
    expect(normalized.selectedVoice).toBeUndefined();
  });
});

describe('CallingCampaignsService live sales scripting', () => {
  it('turns automotive campaign context into a natural sales opening', () => {
    const service = Object.create(CallingCampaignsService.prototype);

    const opening = service.buildLiveOpeningScript(
      {
        objective: 'Sales for a new SUV',
        prompt: 'You are Alex, a sales person calling about the new SUV.',
        botName: 'Alex',
        botRole: 'Sales person',
        botKnowledge: 'Sales context for the new SUV.',
      },
      { firstName: 'Oswin' },
      service.buildBotProfile({
        botName: 'Alex',
        botRole: 'Sales person',
        botKnowledge: 'Sales context for the new SUV.',
      }),
    );

    expect(opening).toContain('new SUV');
    expect(opening).not.toContain('Tata');
    expect(opening).not.toContain('Sierra');
  });
});

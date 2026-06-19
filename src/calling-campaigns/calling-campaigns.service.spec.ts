import { CallingCampaignsService } from './calling-campaigns.service';

describe('CallingCampaignsService.resolveTwilioVoice', () => {
  it('keeps the selected voice mapping when a campaign voice is provided', () => {
    const service = Object.create(CallingCampaignsService.prototype) as any;

    expect(service.resolveTwilioVoice('Puck')).toBe('Polly.Justin');
    expect(service.resolveTwilioVoice('Fenrir')).toBe('Polly.Joey');
    expect(service.resolveTwilioVoice('Gacrux')).toBe('Polly.Aditi');
    expect(service.resolveTwilioVoice('Orus')).toBe('Google.en-IN-Wavenet-C');
    expect(service.resolveTwilioVoice('Aditi_hi')).toBe('Polly.Aditi');
    expect(service.resolveTwilioVoice('Madhav_hi')).toBe('Google.hi-IN-Neural2-C');
  });

  it('does not force a fallback voice when the campaign voice is unknown', () => {
    const service = Object.create(CallingCampaignsService.prototype) as any;

    expect(service.resolveTwilioVoice('UnknownVoice', 'es-ES')).toBe(
      undefined,
    );
  });
});

describe('CallingCampaignsService.normalizeLanguageCode', () => {
  it('maps hi to hi-IN', () => {
    const service = Object.create(CallingCampaignsService.prototype) as any;
    expect(service.normalizeLanguageCode('hi')).toBe('hi-IN');
    expect(service.normalizeLanguageCode('en-IN')).toBe('en-IN');
    expect(service.normalizeLanguageCode('en')).toBe('en');
  });
});

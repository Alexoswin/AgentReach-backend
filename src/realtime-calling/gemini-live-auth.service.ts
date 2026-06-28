import { BadRequestException, Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { MASKED_CREDENTIAL } from '../settings/credential-encryption';

@Injectable()
export class GeminiLiveAuthService {
  constructor(private readonly settingsService: SettingsService) {}

  async getApiKey(candidate?: string) {
    const provided = candidate?.trim() || '';
    if (provided && provided !== MASKED_CREDENTIAL) return provided;

    const settings = await this.settingsService.getRawSettings();
    return (
      settings?.geminiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim() || ''
    );
  }

  async requireApiKey() {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new BadRequestException(
        'Gemini API key is required for Gemini Live calling.',
      );
    }
    return apiKey;
  }
}

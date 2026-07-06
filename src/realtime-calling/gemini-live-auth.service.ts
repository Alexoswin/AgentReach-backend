import { BadRequestException, Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { MASKED_CREDENTIAL } from '../settings/credential-encryption';

// Every call connect (and every mid-call reconnect) needs this key, so a cold
// DB lookup here sits directly on the path to first audio and on the
// reconnect path where dead air is most costly. The key changes only when a
// human edits Settings, so a short TTL cache trades near-zero staleness risk
// for removing that round trip from the hot path.
const API_KEY_CACHE_TTL_MS = 30_000;

@Injectable()
export class GeminiLiveAuthService {
  private cachedApiKey: string | null = null;
  private cachedAt = 0;

  constructor(private readonly settingsService: SettingsService) {}

  async getApiKey(candidate?: string) {
    const provided = candidate?.trim() || '';
    if (provided && provided !== MASKED_CREDENTIAL) return provided;

    const now = Date.now();
    if (this.cachedApiKey !== null && now - this.cachedAt < API_KEY_CACHE_TTL_MS) {
      return this.cachedApiKey;
    }

    const settings = await this.settingsService.getRawSettings();
    const apiKey =
      settings?.geminiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim() || '';
    this.cachedApiKey = apiKey;
    this.cachedAt = now;
    return apiKey;
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

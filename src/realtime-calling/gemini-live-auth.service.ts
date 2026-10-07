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
  // Keyed by the user whose Settings hold the key: each campaign's calls run
  // on the Gemini key of the user who launched it.
  private readonly cache = new Map<string, { apiKey: string; at: number }>();

  constructor(private readonly settingsService: SettingsService) {}

  async getApiKey(userId: string | null | undefined) {
    if (!userId) return '';

    const now = Date.now();
    const cached = this.cache.get(userId);
    if (cached && now - cached.at < API_KEY_CACHE_TTL_MS) {
      return cached.apiKey;
    }

    const settings = await this.settingsService.getRawSettings(userId);
    const stored = settings?.geminiApiKey?.trim() || '';
    const apiKey = stored === MASKED_CREDENTIAL ? '' : stored;
    this.cache.set(userId, { apiKey, at: now });
    return apiKey;
  }

  async requireApiKey(userId: string | null | undefined) {
    const apiKey = await this.getApiKey(userId);
    if (!apiKey) {
      throw new BadRequestException(
        'Add your Gemini API key in Settings before launching AI calls.',
      );
    }
    return apiKey;
  }
}

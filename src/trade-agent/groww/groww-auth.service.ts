import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MongoService } from '../../mongo.service';
import { SettingsService } from '../../settings/settings.service';
import { encryptSystemSettingsData } from '../../settings/credential-encryption';
import { GrowwApiError, fetchGrowwAccessToken } from '../../config/groww';

/**
 * Owns the Groww daily access token.
 *
 * Groww expires tokens at 06:00 IST every morning, so unattended operation
 * needs either the API secret (approval flow) or a TOTP seed on the server.
 * Without one of those this service can still serve a token that an operator
 * pasted in, but it cannot renew it — `describeReadiness()` says so plainly.
 */
@Injectable()
export class GrowwAuthService {
  private readonly logger = new Logger(GrowwAuthService.name);

  /** In-flight refresh, so a burst of callers triggers exactly one handshake. */
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly db: MongoService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Proactive renewal just after the daily expiry boundary, so the first
   * market-hours cycle never pays for an auth round-trip.
   */
  @Cron('30 0 6 * * *', { timeZone: 'Asia/Kolkata' })
  async refreshDaily() {
    const readiness = await this.describeReadiness();
    if (!readiness.canSelfRenew) {
      this.logger.warn(
        `Skipping daily Groww token refresh: ${readiness.reason}`,
      );
      return;
    }

    try {
      await this.forceRefresh();
      this.logger.log('Groww access token refreshed for the new trading day.');
    } catch (error) {
      this.logger.error(
        `Daily Groww token refresh failed: ${(error as Error).message}`,
      );
    }
  }

  /** Returns a live token, re-authenticating only when the cached one is stale. */
  async getAccessToken(): Promise<string> {
    const settings = await this.settings.getRawSettings();
    const cached = settings?.growwAccessToken?.trim() || '';
    const expiresAt = settings?.growwAccessTokenExpiresAt
      ? new Date(settings.growwAccessTokenExpiresAt)
      : null;

    // A minute of slack so a token cannot expire mid-request.
    const stillValid =
      cached && expiresAt && expiresAt.getTime() - 60_000 > Date.now();

    if (stillValid) return cached;

    return this.forceRefresh();
  }

  /**
   * Drops the cached token and re-authenticates. Called on a 401 — exactly
   * once per request, never in a loop.
   */
  async forceRefresh(): Promise<string> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = this.performRefresh().finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }

  private async performRefresh(): Promise<string> {
    const settings = await this.settings.getRawSettings();
    const apiKey = settings?.growwApiKey?.trim() || '';
    const apiSecret = settings?.growwApiSecret?.trim() || '';
    const totpSecret = settings?.growwTotpSecret?.trim() || '';

    if (!apiKey) {
      throw new GrowwApiError(
        'Groww is not configured. Add an API key in Settings.',
        400,
      );
    }

    if (!apiSecret && !totpSecret) {
      throw new GrowwApiError(
        'Groww cannot renew its daily token: add an API secret or a TOTP secret ' +
          'in Settings, or paste a fresh access token each morning.',
        400,
      );
    }

    const token = await fetchGrowwAccessToken({
      apiKey,
      apiSecret: apiSecret || undefined,
      totpSecret: totpSecret || undefined,
    });

    await this.db.systemSettings.update({
      where: { id: 'default' },
      data: encryptSystemSettingsData({
        growwAccessToken: token.accessToken,
        growwAccessTokenExpiresAt: token.expiresAt,
        growwStatus: 'CONNECTED',
        growwLastVerified: new Date(),
      }),
    });

    return token.accessToken;
  }

  /** Drives the "Groww not ready" states in the UI without leaking secrets. */
  async describeReadiness() {
    const settings = await this.settings.getRawSettings();
    const hasKey = Boolean(settings?.growwApiKey?.trim());
    const hasSecret = Boolean(settings?.growwApiSecret?.trim());
    const hasTotp = Boolean(settings?.growwTotpSecret?.trim());
    const expiresAt = settings?.growwAccessTokenExpiresAt
      ? new Date(settings.growwAccessTokenExpiresAt)
      : null;
    const tokenValid = Boolean(
      settings?.growwAccessToken?.trim() &&
      expiresAt &&
      expiresAt.getTime() > Date.now(),
    );

    const canSelfRenew = hasKey && (hasSecret || hasTotp);

    let reason = '';
    if (!hasKey) reason = 'No Groww API key configured.';
    else if (!canSelfRenew)
      reason =
        'No API secret or TOTP secret stored, so the daily token cannot be renewed automatically.';

    return {
      configured: hasKey,
      canSelfRenew,
      authFlow: hasTotp ? 'totp' : hasSecret ? 'approval' : 'manual',
      tokenValid,
      tokenExpiresAt: expiresAt?.toISOString() ?? null,
      status: settings?.growwStatus || 'DISCONNECTED',
      lastVerified: settings?.growwLastVerified ?? null,
      reason,
    };
  }
}

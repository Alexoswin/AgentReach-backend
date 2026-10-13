import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type MailMessage = {
  idempotencyKey: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
};

type MailServiceHealth = {
  service: string;
  status: string;
};

@Injectable()
export class MailServiceClient {
  private readonly logger = new Logger(MailServiceClient.name);
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly enabledFlag: boolean;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (
      this.config.get<string>('MAIL_SERVICE_URL') || 'http://localhost:3020/api'
    ).replace(/\/+$/, '');
    this.secret = this.config.get<string>('MAIL_SERVICE_SECRET')?.trim() || '';
    this.enabledFlag =
      this.config.get<string>('MAIL_SERVICE_ENABLED')?.trim() === 'true';
  }

  isConfigured() {
    return this.enabledFlag && Boolean(this.secret);
  }

  async testConnection() {
    if (!this.enabledFlag) {
      return {
        configured: false,
        connected: false,
        message: 'Mail service integration is disabled.',
      };
    }

    if (!this.secret) {
      return {
        configured: false,
        connected: false,
        message: 'MAIL_SERVICE_SECRET is not configured.',
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return {
          configured: true,
          connected: false,
          message: `Mail service returned HTTP ${response.status}.`,
        };
      }

      const health = (await response.json()) as MailServiceHealth;
      return {
        configured: true,
        connected: health.status === 'ok',
        service: health.service,
        message:
          health.status === 'ok'
            ? 'Mail service is reachable.'
            : 'Mail service is not healthy.',
      };
    } catch (error: any) {
      this.logger.warn(`Mail service health check failed: ${error?.message}`);
      return {
        configured: true,
        connected: false,
        message: error?.message || 'Mail service is unreachable.',
      };
    }
  }

  async submit(message: MailMessage) {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Mail service integration is not enabled or configured.',
      );
    }

    const response = await fetch(`${this.baseUrl}/internal/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-mail-secret': this.secret,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10000),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ServiceUnavailableException(
        body?.message || `Mail service returned HTTP ${response.status}.`,
      );
    }

    return body as { messageId: string; status: string };
  }
}

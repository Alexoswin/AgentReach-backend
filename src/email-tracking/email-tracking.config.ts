import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Open tracking only needs PUBLIC_API_URL. Reply tracking is set up by each
 * user in their own AWS account and saved in their Settings; see
 * replyDomainFor.
 */
@Injectable()
export class EmailTrackingConfig {
  constructor(private readonly config: ConfigService) {}

  publicApiBaseUrl() {
    const raw =
      this.config.get<string>('PUBLIC_API_URL') ||
      this.config.get<string>('API_BASE_URL') ||
      `http://localhost:${this.config.get<number>('PORT', 3001)}/api`;
    const base = raw.replace(/\/+$/, '');
    return base.endsWith('/api') ? base : `${base}/api`;
  }

  openPixelUrl(trackingToken: string) {
    return `${this.publicApiBaseUrl()}/email-track/o/${trackingToken}.gif`;
  }

  /**
   * Reply-To for one recipient row. It uses the row id rather than the
   * per-send tracking token, which a relaunch replaces, so replies to an
   * earlier send can still be routed.
   */
  replyToAddress(campaignContactId: string, replyDomain: string) {
    return `reply+${campaignContactId}@${replyDomain}`;
  }
}

/**
 * The reply domain from a user's (decrypted) settings, or null while reply
 * tracking is not fully set up. Reply-To is only rewritten when the replies
 * can both be received (domain and SNS topic) and forwarded on to the user
 * (their SES keys and sender address); otherwise replies would go to an
 * address nothing reads.
 */
export function replyDomainFor(settings: any): string | null {
  const domain = settings?.replyTrackingDomain?.trim().toLowerCase();
  if (
    !domain ||
    !settings?.replyTrackingTopicArn?.trim() ||
    !settings?.awsAccessKeyId ||
    !settings?.awsSecretAccessKey ||
    !settings?.awsSenderEmail?.trim()
  ) {
    return null;
  }
  return domain;
}

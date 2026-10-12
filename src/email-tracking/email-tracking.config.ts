import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient } from '@aws-sdk/client-ses';

/**
 * Reads the environment that open and reply tracking depend on.
 *
 * Open tracking only needs PUBLIC_API_URL. Reply tracking rewrites Reply-To to
 * an address on REPLY_TRACKING_DOMAIN, so it turns on only once that domain's
 * inbound side (the SNS topic SES publishes to, and the platform SES identity
 * that forwards replies on) is configured as well. Turning it on with only the
 * domain set would send replies to an address nothing reads.
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

  /** The reply domain, or null while reply tracking is not fully configured. */
  replyDomain(): string | null {
    const domain = this.config
      .get<string>('REPLY_TRACKING_DOMAIN')
      ?.trim()
      .toLowerCase();
    if (!domain || this.snsTopicArns().length === 0 || !this.platformSes()) {
      return null;
    }
    return domain;
  }

  /**
   * Reply-To for one recipient row on the domain from replyDomain(). It uses
   * the row id rather than the per-send tracking token, which a relaunch
   * replaces, so replies to an earlier send can still be routed.
   */
  replyToAddress(campaignContactId: string, replyDomain: string) {
    return `reply+${campaignContactId}@${replyDomain}`;
  }

  /** SNS topics allowed to post inbound mail. Comma-separated in the env. */
  snsTopicArns() {
    return (this.config.get<string>('REPLY_TRACKING_SNS_TOPIC_ARN') || '')
      .split(',')
      .map((arn) => arn.trim())
      .filter(Boolean);
  }

  s3Region() {
    return (
      this.config.get<string>('REPLY_TRACKING_S3_REGION')?.trim() ||
      this.awsRegion()
    );
  }

  /**
   * The platform's own SES identity (the one account emails use). Replies are
   * forwarded from it, never from a user's Settings credentials, because the
   * reply domain belongs to the platform.
   */
  platformSes() {
    const accessKeyId = this.config.get<string>('AWS_KEY_ID')?.trim();
    const secretAccessKey = this.config.get<string>('AWS_KEY')?.trim();
    const senderEmail =
      this.config.get<string>('REPLY_FORWARD_FROM')?.trim() ||
      this.config.get<string>('AWS_SENDER_EMAIL')?.trim();
    if (!accessKeyId || !secretAccessKey || !senderEmail) return null;

    return {
      client: new SESClient({
        region: this.awsRegion(),
        credentials: { accessKeyId, secretAccessKey },
      }),
      credentials: { accessKeyId, secretAccessKey },
      senderEmail,
    };
  }

  private awsRegion() {
    return this.config.get<string>('AWS_REGION')?.trim() || 'us-east-1';
  }
}

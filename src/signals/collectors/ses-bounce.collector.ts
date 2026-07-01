import { Injectable } from '@nestjs/common';
import { RawSignal } from '../signal.types';

/**
 * S4 — Contact left company, inferred from our own send telemetry.
 * Fed by SES bounce/complaint notifications (SNS webhook) rather than polled.
 * Detects "no longer with the company" style bounces and hard bounces on a
 * previously-valid address, which strongly imply a job change.
 */
@Injectable()
export class SesBounceCollector {
  readonly source = 'ses-bounce';

  private readonly JOB_CHANGE_PHRASES = [
    'no longer with',
    'no longer employed',
    'has left the company',
    'is not longer',
    'left the organization',
    'account has been deactivated',
    'user unknown',
    'recipient not found',
    'mailbox unavailable',
    'address rejected',
  ];

  looksLikeJobChange(bounceMessage: string): boolean {
    const text = (bounceMessage || '').toLowerCase();
    return this.JOB_CHANGE_PHRASES.some((p) => text.includes(p));
  }

  buildSignal(input: {
    email: string;
    companyName?: string;
    companyDomain?: string;
    bounceMessage: string;
  }): RawSignal {
    const domain =
      input.companyDomain || input.email.split('@')[1]?.toLowerCase();
    return {
      source: this.source,
      companyDomain: domain,
      companyName: input.companyName || domain,
      title: `${input.email} appears to have left ${input.companyName || domain}`,
      summary:
        'A bounce on a previously-valid address suggests this contact changed roles — a strong reason to reconnect at their new company.',
      occurredAt: new Date(),
      suggestedType: 'job-change',
      raw: { bounceMessage: input.bounceMessage.slice(0, 500) },
    };
  }
}

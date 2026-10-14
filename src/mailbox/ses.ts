import {
  GetSendQuotaCommand,
  SendRawEmailCommand,
  SESClient,
} from '@aws-sdk/client-ses';

/** SES rejects raw messages above 10 MB, counted after base64 encoding. */
export const SES_MAX_RAW_MESSAGE_BYTES = 10 * 1024 * 1024;

export function sesClientFor(settings: any) {
  return new SESClient({
    region: settings.awsRegion || 'us-east-1',
    credentials: {
      accessKeyId: settings.awsAccessKeyId,
      secretAccessKey: settings.awsSecretAccessKey,
    },
  });
}

export function hasSesCredentials(settings: any) {
  return Boolean(settings?.awsAccessKeyId && settings?.awsSecretAccessKey);
}

/**
 * The user's own SES reply domain, or null until their reply tracking is
 * fully set up in their AWS account (domain, SNS topic, SES keys and sender).
 * Mailbox and campaign emails only ever use this; there is no fallback to
 * the platform's SMTP inbound service.
 */
export function sesReplyDomain(settings: any): string | null {
  const domain =
    settings?.replyTrackingTopicArn?.trim() &&
    settings?.replyTrackingDomain?.trim().toLowerCase();
  if (
    !domain ||
    !hasSesCredentials(settings) ||
    !settings?.awsSenderEmail?.trim()
  ) {
    return null;
  }
  return domain;
}

/**
 * The Message-ID recipients see. SES discards the one in the raw message and
 * sets <MessageId@email.amazonses.com> (us-east-1) or
 * <MessageId@REGION.amazonses.com> elsewhere.
 */
export function sesMessageIdHeader(sesMessageId: string, region: string) {
  const host =
    !region || region === 'us-east-1'
      ? 'email.amazonses.com'
      : `${region}.amazonses.com`;
  return `<${sesMessageId}@${host}>`;
}

export async function sendRawEmail(
  client: SESClient,
  raw: Buffer,
  destinations: string[],
  configurationSet?: string,
) {
  const result = await client.send(
    new SendRawEmailCommand({
      RawMessage: { Data: raw },
      Destinations: destinations,
      ConfigurationSetName: configurationSet || undefined,
    }),
  );
  return result.MessageId || null;
}

/** Errors worth retrying later: throttling, timeouts and SES-side failures. */
export function isRetryableSesError(error: any) {
  const name = String(error?.name || error?.Code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('daily message quota')) return false;
  if (
    name.includes('throttl') ||
    message.includes('throttl') ||
    message.includes('rate exceeded') ||
    name.includes('timeout') ||
    name === 'serviceunavailable' ||
    name === 'internalfailure'
  ) {
    return true;
  }
  if (
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(
      error?.code,
    )
  ) {
    return true;
  }
  return (error?.$metadata?.httpStatusCode || 0) >= 500;
}

export async function maxSendRate(client: SESClient) {
  const quota = await client.send(new GetSendQuotaCommand({}));
  return quota.MaxSendRate || 1;
}

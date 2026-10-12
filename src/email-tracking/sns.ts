import { createVerify } from 'crypto';

export type SnsMessage = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
};

// The fields AWS signs, in the order it signs them, per message type.
const SIGNED_FIELDS: Record<string, (keyof SnsMessage)[]> = {
  Notification: [
    'Message',
    'MessageId',
    'Subject',
    'Timestamp',
    'TopicArn',
    'Type',
  ],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

// SNS only ever hands out certificate and subscription URLs on these hosts.
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function isSnsUrl(value: string | undefined, requirePem = false) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      SNS_HOST.test(url.hostname) &&
      (!requirePem || url.pathname.endsWith('.pem'))
    );
  } catch {
    return false;
  }
}

export function snsStringToSign(message: SnsMessage) {
  const fields = SIGNED_FIELDS[message.Type];
  if (!fields) return null;
  return fields
    .filter((field) => message[field] !== undefined)
    .map((field) => `${field}\n${message[field]}\n`)
    .join('');
}

const certificates = new Map<string, Promise<string>>();

function fetchCertificate(url: string) {
  let pending = certificates.get(url);
  if (!pending) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) {
        throw new Error(`SNS certificate request failed (${response.status})`);
      }
      return response.text();
    });
    // A failed download is retried on the next message, not cached.
    pending.catch(() => certificates.delete(url));
    certificates.set(url, pending);
  }
  return pending;
}

/**
 * True only for a message that SNS itself signed. That proves nothing about
 * whose topic sent it (anyone can create a topic and point it at this
 * endpoint), so callers must also check TopicArn against the account the
 * message is for.
 */
export async function verifySnsSignature(message: SnsMessage) {
  if (!message?.TopicArn) return false;
  if (!isSnsUrl(message.SigningCertURL, true)) return false;

  const stringToSign = snsStringToSign(message);
  if (!stringToSign || !message.Signature) return false;

  const algorithm =
    message.SignatureVersion === '2'
      ? 'RSA-SHA256'
      : message.SignatureVersion === '1'
        ? 'RSA-SHA1'
        : null;
  if (!algorithm) return false;

  const certificate = await fetchCertificate(message.SigningCertURL);
  return createVerify(algorithm)
    .update(stringToSign, 'utf8')
    .verify(certificate, message.Signature, 'base64');
}

import { createHmac, timingSafeEqual } from 'crypto';

const LOCAL_DEV_JWT_SECRET = 'reachconvert-local-dev-secret';

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

// The signing secret for access/refresh tokens and call webhook tokens. A
// built-in fallback is only tolerated outside production; a production
// process without JWT_SECRET would accept tokens anyone can forge.
export function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return secret;
  if (isProduction()) {
    throw new Error('JWT_SECRET must be set in production.');
  }
  return LOCAL_DEV_JWT_SECRET;
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Telephony providers call our webhooks and media-stream sockets without a
// user session, so each call's callback URLs carry an HMAC of its callId.
// Only URLs we handed to Twilio/Plivo carry a valid token.
export function signCallToken(callId: string) {
  return createHmac('sha256', getJwtSecret())
    .update(`call-webhook:${callId}`)
    .digest('base64url');
}

export function verifyCallToken(callId: string, token: unknown) {
  if (!callId || typeof token !== 'string' || !token) return false;
  return safeEqual(token, signCallToken(callId));
}

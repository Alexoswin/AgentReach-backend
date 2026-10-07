import { HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

type Limit = { limit: number; windowMs: number };
type Window = { count: number; resetAt: number };

// Per-account limits stop password guessing and inbox flooding against one
// email; per-address limits slow one client spraying many emails. Counters
// live in process memory: the backend runs as a single Cloud Run instance.
const AUTH_LIMITS: Record<string, { perEmail?: Limit; perIp: Limit }> = {
  login: {
    perEmail: { limit: 10, windowMs: 15 * MINUTE },
    perIp: { limit: 50, windowMs: 15 * MINUTE },
  },
  register: {
    perEmail: { limit: 5, windowMs: HOUR },
    perIp: { limit: 10, windowMs: HOUR },
  },
  'identity-platform': { perIp: { limit: 30, windowMs: 15 * MINUTE } },
  'forgot-password': {
    perEmail: { limit: 3, windowMs: HOUR },
    perIp: { limit: 20, windowMs: HOUR },
  },
  'reset-password': { perIp: { limit: 20, windowMs: HOUR } },
  'verify-email': {
    perEmail: { limit: 10, windowMs: 15 * MINUTE },
    perIp: { limit: 30, windowMs: 15 * MINUTE },
  },
  'resend-verification': {
    perEmail: { limit: 5, windowMs: HOUR },
    perIp: { limit: 20, windowMs: HOUR },
  },
};

const MAX_TRACKED_KEYS = 10_000;
const windows = new Map<string, Window>();

function consume(key: string, { limit, windowMs }: Limit) {
  const now = Date.now();
  if (windows.size > MAX_TRACKED_KEYS) {
    for (const [trackedKey, window] of windows) {
      if (window.resetAt <= now) windows.delete(trackedKey);
    }
  }

  const current = windows.get(key);
  const window =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs };
  window.count += 1;
  windows.set(key, window);

  if (window.count > limit) {
    const minutes = Math.max(1, Math.ceil((window.resetAt - now) / MINUTE));
    throw new HttpException(
      `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

// Vercel puts the visitor's address first in x-forwarded-for when it
// proxies /api. A client calling Cloud Run directly can forge that header,
// which is why the per-email limits do not depend on it.
export function clientIp(request: Request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || request.socket?.remoteAddress || 'unknown';
}

export function enforceAuthRateLimit(
  action: keyof typeof AUTH_LIMITS,
  request: Request,
  email?: string,
) {
  const limits = AUTH_LIMITS[action];
  consume(`${action}:ip:${clientIp(request)}`, limits.perIp);
  const normalizedEmail = email?.trim().toLowerCase();
  if (limits.perEmail && normalizedEmail) {
    consume(`${action}:email:${normalizedEmail}`, limits.perEmail);
  }
}

/** Test hook: forget every counter. */
export function resetAuthRateLimits() {
  windows.clear();
}

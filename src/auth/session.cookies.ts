import { randomBytes, timingSafeEqual } from 'crypto';
import type { CookieOptions, Request, Response } from 'express';

export const ACCESS_COOKIE_NAME = 'reachconvert_access';
export const REFRESH_COOKIE_NAME = 'reachconvert_refresh';
export const CSRF_COOKIE_NAME = 'reachconvert_csrf';

const ACCESS_COOKIE_PATH = '/api';
const REFRESH_COOKIE_PATH = '/api/auth/refresh';
const CSRF_COOKIE_PATH = '/api';

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  user: Record<string, unknown>;
};

type SameSite = 'lax' | 'strict' | 'none';

function cookieSettings(httpOnly: boolean, path: string): CookieOptions {
  const sameSite = (process.env.COOKIE_SAME_SITE || 'lax').toLowerCase();
  const secure =
    process.env.NODE_ENV === 'production' ||
    process.env.COOKIE_SECURE === 'true';
  const normalizedSameSite: SameSite =
    sameSite === 'none' || sameSite === 'strict' ? sameSite : 'lax';

  return {
    httpOnly,
    secure,
    sameSite: normalizedSameSite,
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
    path,
  };
}

export function setSessionCookies(response: Response, session: AuthSession) {
  response.cookie(ACCESS_COOKIE_NAME, session.accessToken, {
    ...cookieSettings(true, ACCESS_COOKIE_PATH),
    maxAge: 15 * 60 * 1000,
  });
  response.cookie(REFRESH_COOKIE_NAME, session.refreshToken, {
    ...cookieSettings(true, REFRESH_COOKIE_PATH),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  ensureCsrfCookie(response);
  return { user: session.user };
}

export function clearSessionCookies(response: Response) {
  response.clearCookie(
    ACCESS_COOKIE_NAME,
    cookieSettings(true, ACCESS_COOKIE_PATH),
  );
  response.clearCookie(
    REFRESH_COOKIE_NAME,
    cookieSettings(true, REFRESH_COOKIE_PATH),
  );
}

export function readCookie(request: Request, name: string) {
  const header = request.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

export function ensureCsrfCookie(response: Response, request?: Request) {
  const existing = request ? readCookie(request, CSRF_COOKIE_NAME) : undefined;
  const token = existing || randomBytes(32).toString('base64url');
  if (!existing) {
    response.cookie(CSRF_COOKIE_NAME, token, {
      ...cookieSettings(false, CSRF_COOKIE_PATH),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
  response.setHeader('X-CSRF-Token', token);
  return token;
}

export function csrfTokensMatch(
  expected: string | undefined,
  received: string | undefined,
) {
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

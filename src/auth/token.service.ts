import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { getJwtSecret, safeEqual } from './secrets';

export type TokenType = 'access' | 'refresh';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

interface TokenPayload {
  sub: string;
  email: string;
  type: TokenType;
  exp: number;
  jti?: string;
  // AuthSession id; absent on tokens issued before per-device sessions.
  sid?: string;
}

@Injectable()
export class TokenService {
  signAccessToken(user: { id: string; email: string }, sessionId: string) {
    return this.signToken(user, 'access', ACCESS_TOKEN_TTL_SECONDS, sessionId);
  }

  signRefreshToken(user: { id: string; email: string }, sessionId: string) {
    return this.signToken(
      user,
      'refresh',
      REFRESH_TOKEN_TTL_SECONDS,
      sessionId,
    );
  }

  verifyToken(token: string, type: TokenType) {
    const [encodedHeader, encodedPayload, signature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !signature) {
      throw new UnauthorizedException('Invalid token');
    }

    const expectedSignature = this.sign(`${encodedHeader}.${encodedPayload}`);
    if (!safeEqual(signature, expectedSignature)) {
      throw new UnauthorizedException('Invalid token signature');
    }

    let payload: TokenPayload;
    try {
      payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as TokenPayload;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    if (payload.type !== type) {
      throw new UnauthorizedException('Invalid token type');
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Token expired');
    }

    return payload;
  }

  // True when this backend signed the token, even if it has since expired.
  isAuthentic(token: string) {
    const [encodedHeader, encodedPayload, signature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !signature) return false;
    return safeEqual(
      signature,
      this.sign(`${encodedHeader}.${encodedPayload}`),
    );
  }

  hashToken(token: string) {
    return createHmac('sha256', this.getSecret()).update(token).digest('hex');
  }

  private signToken(
    user: { id: string; email: string },
    type: TokenType,
    ttlSeconds: number,
    sessionId: string,
  ) {
    const header = this.encode({ alg: 'HS256', typ: 'JWT' });
    const payload = this.encode({
      sub: user.id,
      email: user.email,
      type,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      jti: randomBytes(16).toString('hex'),
      sid: sessionId,
    });

    return `${header}.${payload}.${this.sign(`${header}.${payload}`)}`;
  }

  private sign(value: string) {
    return createHmac('sha256', this.getSecret())
      .update(value)
      .digest('base64url');
  }

  private encode(value: Record<string, unknown>) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private getSecret() {
    return getJwtSecret();
  }
}

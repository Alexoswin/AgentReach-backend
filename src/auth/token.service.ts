import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';

export type TokenType = 'access' | 'refresh';

interface TokenPayload {
  sub: string;
  email: string;
  type: TokenType;
  exp: number;
  jti?: string;
}

@Injectable()
export class TokenService {
  constructor(private configService: ConfigService) {}

  signAccessToken(user: { id: string; email: string }) {
    return this.signToken(user, 'access', 15 * 60);
  }

  signRefreshToken(user: { id: string; email: string }) {
    return this.signToken(user, 'refresh', 7 * 24 * 60 * 60);
  }

  verifyToken(token: string, type: TokenType) {
    const [encodedHeader, encodedPayload, signature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !signature) {
      throw new UnauthorizedException('Invalid token');
    }

    const expectedSignature = this.sign(`${encodedHeader}.${encodedPayload}`);
    if (signature !== expectedSignature) {
      throw new UnauthorizedException('Invalid token signature');
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as TokenPayload;
    if (payload.type !== type) {
      throw new UnauthorizedException('Invalid token type');
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Token expired');
    }

    return payload;
  }

  hashToken(token: string) {
    return createHmac('sha256', this.getSecret()).update(token).digest('hex');
  }

  private signToken(user: { id: string; email: string }, type: TokenType, ttlSeconds: number) {
    const header = this.encode({ alg: 'HS256', typ: 'JWT' });
    const payload = this.encode({
      sub: user.id,
      email: user.email,
      type,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      jti: randomBytes(16).toString('hex'),
    });

    return `${header}.${payload}.${this.sign(`${header}.${payload}`)}`;
  }

  private sign(value: string) {
    return createHmac('sha256', this.getSecret()).update(value).digest('base64url');
  }

  private encode(value: Record<string, unknown>) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private getSecret() {
    return this.configService.get<string>('JWT_SECRET') || 'reachconvert-local-dev-secret';
  }
}

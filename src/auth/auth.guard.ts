import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MongoService } from '../mongo.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { TokenService } from './token.service';
import { ACCESS_COOKIE_NAME, readCookie } from './session.cookies';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private tokenService: TokenService,
    private db: MongoService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization || '';
    const [scheme, headerToken] = authHeader.split(' ');
    const token =
      scheme === 'Bearer' && headerToken
        ? headerToken
        : readCookie(request, ACCESS_COOKIE_NAME);

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    const payload = this.tokenService.verifyToken(token, 'access');
    const user = await this.db.user.findUnique({ where: { id: payload.sub } });

    if (!user || user.disabled) {
      throw new UnauthorizedException('User not found');
    }

    // Signing out or resetting the password ends the session at once
    // instead of when its access token expires.
    if (payload.sid) {
      const session = await this.db.authSession.findUnique({
        where: { id: payload.sid, userId: user.id },
      });
      if (!session) {
        throw new UnauthorizedException('Session has ended');
      }
    }

    request.user = {
      id: user.id,
      email: user.email,
      sessionId: payload.sid,
    };

    return true;
  }
}

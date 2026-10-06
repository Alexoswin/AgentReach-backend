import { Module, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { AuthModule } from '../auth/auth.module';
import { TokenService } from '../auth/token.service';

@Module({
  imports: [AuthModule],
})
export class WebPilotModule {
  constructor(
    private configService: ConfigService,
    private tokenService: TokenService,
  ) {}

  async configure(consumer: MiddlewareConsumer) {
    const targetUrl =
      this.configService.get<string>('WEBPILOT_URL') || 'http://localhost:8001';
    const { createProxyMiddleware } = await import('http-proxy-middleware');

    // Middleware runs before the global AuthGuard, so the proxy has to check
    // the access token itself or it would forward anonymous requests.
    const requireAccessToken = (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      const [scheme, token] = (req.headers.authorization || '').split(' ');
      try {
        if (scheme !== 'Bearer' || !token) throw new Error('missing token');
        this.tokenService.verifyToken(token, 'access');
        next();
      } catch {
        res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
      }
    };

    consumer
      .apply(
        requireAccessToken,
        createProxyMiddleware({
          target: targetUrl,
          changeOrigin: true,
          ws: false, // WS handled in main.ts
        }),
      )
      .forRoutes({ path: 'api/webpilot/*path', method: RequestMethod.ALL });
  }
}

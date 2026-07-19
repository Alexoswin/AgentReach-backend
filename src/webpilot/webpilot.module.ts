import { Module, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { ConfigService } from '@nestjs/config';

@Module({})
export class WebPilotModule {
  constructor(private configService: ConfigService) {}

  configure(consumer: MiddlewareConsumer) {
    const targetUrl =
      this.configService.get<string>('WEBPILOT_URL') || 'http://localhost:8001';

    consumer
      .apply(
        createProxyMiddleware({
          target: targetUrl,
          changeOrigin: true,
          ws: false, // WS handled in main.ts
        })
      )
      .forRoutes({ path: 'api/webpilot/*path', method: RequestMethod.ALL });
  }
}

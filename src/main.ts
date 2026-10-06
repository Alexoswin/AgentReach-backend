import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { IncomingMessage, Server } from 'http';
import { Duplex } from 'stream';
import { Server as WsServer } from 'ws';
import { RealtimeCallingGateway } from './realtime-calling/realtime-calling.gateway';
import { TokenService } from './auth/token.service';
import { getJwtSecret, isProduction } from './auth/secrets';

const REQUEST_BODY_LIMIT = '50mb';

// Builds the Nest app and wires up everything except the actual port bind,
// so the same instance can either call app.listen() (Render/local, a
// persistent process) or be driven per-request by a serverless handler
// (Vercel, which invokes this module's export directly and never calls
// listen()). The Twilio/Plivo/webpilot raw WS upgrade dispatch below only
// receives real traffic under the persistent-process path.
async function createApp() {
  // Refuse to boot in production without a signing secret rather than
  // silently falling back to a value anyone can read in the source.
  getJwtSecret();

  const app = await NestFactory.create(AppModule);

  app.use(json({ limit: REQUEST_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

  // CORS_ORIGINS (comma-separated) restricts which sites may call the API;
  // unset keeps the previous allow-all behaviour.
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  app.enableCors(corsOrigins.length ? { origin: corsOrigins } : undefined);

  // Set global API prefix
  app.setGlobalPrefix('api');

  // Swagger is off in production unless ENABLE_SWAGGER=true.
  const swaggerEnabled =
    !isProduction() || process.env.ENABLE_SWAGGER === 'true';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('ReachConvert API')
      .setDescription('ReachConvert outreach platform API endpoints')
      .setVersion('1.0')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
  }

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3001);
  const httpServer = app.getHttpServer() as Server;
  const wsServer = new WsServer({ noServer: true });
  const realtimeGateway = app.get(RealtimeCallingGateway);
  const tokenService = app.get(TokenService);

  const { createProxyMiddleware } = await import('http-proxy-middleware');
  const webpilotProxy = createProxyMiddleware({
    target:
      configService.get<string>('WEBPILOT_URL') || 'http://localhost:8001',
    changeOrigin: true,
    ws: true,
  }) as any;

  httpServer.on(
    'upgrade',
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = (req.url || '').split('?')[0];
      if (pathname === '/twilio/stream') {
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          realtimeGateway.registerTwilioSocket(ws, req);
        });
        return;
      }
      if (pathname === '/plivo/stream') {
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          realtimeGateway.registerPlivoSocket(ws, req);
        });
        return;
      }
      if (pathname.startsWith('/ws/webpilot')) {
        // Browsers cannot set headers on a WebSocket, so the access token
        // travels as ?token=.
        const token = new URL(
          req.url || '',
          'http://localhost',
        ).searchParams.get('token');
        try {
          tokenService.verifyToken(token || '', 'access');
        } catch {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        webpilotProxy.upgrade(req, socket, head);
        return;
      }
      socket.destroy();
    },
  );

  // app.listen() normally triggers this implicitly; the serverless handler
  // path below never calls listen(), so routes would otherwise never mount.
  await app.init();

  return { app, httpServer, port };
}

let cached: ReturnType<typeof createApp> | null = null;
function getApp() {
  if (!cached) cached = createApp();
  return cached;
}

// Vercel Functions invoke this module directly per request and never call
// app.listen() themselves — the exported handler is what they look for.
export default async function handler(
  req: IncomingMessage,
  res: import('http').ServerResponse,
) {
  const { httpServer } = await getApp();
  httpServer.emit('request', req, res);
}

// Render, local dev, and any other host that runs this as a persistent
// process instead of invoking the export above.
if (!process.env.VERCEL) {
  void getApp().then(async ({ app, port }) => {
    const boundPort = Number(process.env.PORT) || port;
    await app.listen(boundPort, '0.0.0.0');
    console.log(`Backend is running on: http://localhost:${boundPort}/api`);
    if (!isProduction() || process.env.ENABLE_SWAGGER === 'true') {
      console.log(
        `Swagger documentation is available at: http://localhost:${boundPort}/docs`,
      );
    }
  });
}

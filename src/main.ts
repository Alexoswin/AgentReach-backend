import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { IncomingMessage, Server } from 'http';
import { Duplex } from 'stream';
import { Server as WsServer } from 'ws';
import { RealtimeCallingGateway } from './realtime-calling/realtime-calling.gateway';
import { getJwtSecret, isProduction } from './auth/secrets';
import {
  csrfTokensMatch,
  ensureCsrfCookie,
  readCookie,
  CSRF_COOKIE_NAME,
} from './auth/session.cookies';

const REQUEST_BODY_LIMIT = '50mb';

// Builds the Nest app and wires up everything except the actual port bind,
// so the same instance can either call app.listen() (Render/local, a
// persistent process) or be driven per-request by a serverless handler
// (Vercel, which invokes this module's export directly and never calls
// listen()). The Twilio/Plivo raw WS upgrade dispatch below only
// receives real traffic under the persistent-process path.
async function createApp() {
  // Refuse to boot in production without a signing secret rather than
  // silently falling back to a value anyone can read in the source.
  getJwtSecret();

  const app = await NestFactory.create(AppModule);

  app.use(json({ limit: REQUEST_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

  // CORS_ORIGINS (comma-separated) restricts which sites may call the API.
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (isProduction() && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must be configured in production.');
  }
  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
    exposedHeaders: ['X-CSRF-Token'],
  });

  // Cookies are used for the application session. A rotating, non-HttpOnly
  // CSRF token is returned in a response header so the frontend can send it
  // back in X-CSRF-Token without ever storing an auth token in JavaScript.
  app.use((request: Request, response: Response, next: NextFunction) => {
    ensureCsrfCookie(response, request);

    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const publicAuthPath = [
      '/api/auth/register',
      '/api/auth/login',
      '/api/auth/identity-platform',
      '/api/auth/refresh',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/auth/verify-email',
      '/api/auth/resend-verification',
    ].includes(request.path);

    if (
      unsafe &&
      !publicAuthPath &&
      !csrfTokensMatch(
        readCookie(request, CSRF_COOKIE_NAME),
        request.headers['x-csrf-token'] as string | undefined,
      )
    ) {
      response.status(403).json({ message: 'Invalid CSRF token' });
      return;
    }

    next();
  });

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

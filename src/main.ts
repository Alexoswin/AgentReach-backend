import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { Server as WsServer } from 'ws';
import { RealtimeCallingGateway } from './realtime-calling/realtime-calling.gateway';

const REQUEST_BODY_LIMIT = '50mb';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(json({ limit: REQUEST_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

  // Enable CORS for frontend requests
  app.enableCors();

  // Set global API prefix
  app.setGlobalPrefix('api');

  // Set up Swagger API Documentation
  const config = new DocumentBuilder()
    .setTitle('ReachConvert API')
    .setDescription('ReachConvert outreach platform API endpoints')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3001);
  const httpServer = app.getHttpServer();
  const wsServer = new WsServer({ noServer: true });
  const realtimeGateway = app.get(RealtimeCallingGateway);

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/twilio/stream') {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        realtimeGateway.registerTwilioSocket(ws, req);
      });
      return;
    }
    socket.destroy();
  });

  await app.listen(port);
  console.log(`Backend is running on: http://localhost:${port}/api`);
  console.log(
    `Swagger documentation is available at: http://localhost:${port}/docs`,
  );
}
void bootstrap();

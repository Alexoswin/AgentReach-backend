import { INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { TokenService } from '../auth/token.service';
import { WebPilotModule } from './webpilot.module';

// AuthModule pulls in Settings and Mongo; the proxy only needs TokenService.
@Module({ providers: [TokenService], exports: [TokenService] })
class TokenOnlyModule {}

type Seen = { method?: string; url?: string; body: string };

describe('WebPilotModule proxy', () => {
  let upstream: Server;
  let seen: Seen[];
  let app: INestApplication;
  let tokens: TokenService;

  beforeAll(async () => {
    seen = [];
    upstream = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const { port } = upstream.address() as AddressInfo;
    process.env.WEBPILOT_URL = `http://127.0.0.1:${port}`;

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), WebPilotModule],
    })
      .overrideModule(AuthModule)
      .useModule(TokenOnlyModule)
      .compile();

    app = moduleRef.createNestApplication();
    // Same prefix as main.ts; the bug was a route that ignored it.
    app.setGlobalPrefix('api');
    await app.init();
    tokens = app.get(TokenService);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => upstream.close(resolve));
    delete process.env.WEBPILOT_URL;
  });

  beforeEach(() => {
    seen = [];
  });

  it('forwards an authorised request with its path and JSON body', async () => {
    const token = tokens.signAccessToken({ id: 'u1', email: 'u1@example.com' });

    const res = await request(app.getHttpServer())
      .post('/api/webpilot/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'open example.com', modelTier: 'auto' })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/api/webpilot/runs');
    expect(JSON.parse(seen[0].body)).toEqual({
      prompt: 'open example.com',
      modelTier: 'auto',
    });
  });

  it('keeps the query string on GET requests', async () => {
    const token = tokens.signAccessToken({ id: 'u1', email: 'u1@example.com' });

    await request(app.getHttpServer())
      .get('/api/webpilot/runs?limit=20')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(seen[0].url).toBe('/api/webpilot/runs?limit=20');
  });

  it('rejects a request without a token and never reaches the service', async () => {
    await request(app.getHttpServer()).get('/api/webpilot/runs').expect(401);
    expect(seen).toHaveLength(0);
  });

  it('rejects a refresh token used as an access token', async () => {
    const refresh = tokens.signRefreshToken({
      id: 'u1',
      email: 'u1@example.com',
    });

    await request(app.getHttpServer())
      .get('/api/webpilot/runs')
      .set('Authorization', `Bearer ${refresh}`)
      .expect(401);
    expect(seen).toHaveLength(0);
  });
});

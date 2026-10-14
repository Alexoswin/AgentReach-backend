import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { Public } from '../auth/public.decorator';
import { EmailTrackingService } from './email-tracking.service';
import { parseTrackingToken, TRANSPARENT_GIF } from './open-pixel';
import { SnsMessage } from './sns';
import { unsubscribePage } from './unsubscribe-page';

// SNS notifications with the email inline are at most ~200 KB once encoded.
const MAX_SNS_BODY_BYTES = 1024 * 1024;
const MAX_RAW_EMAIL_BYTES = 26 * 1024 * 1024;

@ApiExcludeController()
@Controller('email-track')
export class EmailTrackingController {
  private readonly logger = new Logger(EmailTrackingController.name);

  constructor(private readonly tracking: EmailTrackingService) {}

  /**
   * Tracking image embedded in campaign emails. Always answers with the
   * image, whatever the token, so the endpoint reveals nothing about which
   * tokens exist and a failure never shows a broken image in the email.
   */
  @Get('o/:token')
  @Public()
  async open(@Param('token') value: string, @Res() response: Response) {
    const token = parseTrackingToken(value);
    if (token) {
      await this.tracking.recordOpen(token).catch((error: Error) => {
        this.logger.warn(`Could not record email open: ${error.message}`);
      });
    }

    response
      .status(200)
      .set({
        'Content-Type': 'image/gif',
        'Content-Length': String(TRANSPARENT_GIF.length),
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
        Expires: '0',
      })
      .end(TRANSPARENT_GIF);
  }

  /**
   * The unsubscribe link in campaign emails. Opening it only asks; link
   * scanners open every URL in an email, so unsubscribing takes the click.
   */
  @Get('u/:token')
  @Public()
  async unsubscribePage(
    @Param('token') token: string,
    @Res() response: Response,
  ) {
    const target = await this.tracking.unsubscribeTarget(token);
    sendUnsubscribePage(
      response,
      target ? 200 : 404,
      unsubscribePage(
        !target ? 'missing' : target.unsubscribed ? 'done' : 'confirm',
        target,
      ),
    );
  }

  /** The page's button, and one-click unsubscribe from mail apps (RFC 8058). */
  @Post('u/:token')
  @Public()
  async unsubscribe(@Param('token') token: string, @Res() response: Response) {
    const target = await this.tracking.unsubscribe(token);
    sendUnsubscribePage(
      response,
      target ? 200 : 404,
      unsubscribePage(target ? 'done' : 'missing', target),
    );
  }

  /** SNS endpoint for replies that SES receives on the reply domain. */
  @Post('inbound')
  @Public()
  @HttpCode(200)
  async inbound(@Req() request: Request) {
    let message: SnsMessage;
    try {
      message = JSON.parse((await readBody(request)).toString('utf8'));
    } catch {
      throw new BadRequestException('Expected an SNS message');
    }

    if (!(await this.tracking.handleSnsMessage(message))) {
      throw new ForbiddenException('Message is not from an allowed SNS topic');
    }
    return { ok: true };
  }

  /** Raw replies handed over by the inbound SMTP service. */
  @Post('inbound-raw')
  @Public()
  @HttpCode(200)
  async inboundRaw(@Req() request: Request) {
    const secret = Buffer.from(process.env.INBOUND_SECRET || '');
    const given = Buffer.from(
      String(request.headers['x-inbound-secret'] || ''),
    );
    if (
      !secret.length ||
      given.length !== secret.length ||
      !timingSafeEqual(given, secret)
    ) {
      throw new ForbiddenException('Invalid inbound secret');
    }

    const recipients = String(request.headers['x-recipients'] || '')
      .split(',')
      .filter(Boolean);
    const raw = await readBody(request, MAX_RAW_EMAIL_BYTES);
    if (!(await this.tracking.handleRawEmail(raw, recipients))) {
      throw new BadRequestException('Not a campaign reply address');
    }
    return { ok: true };
  }
}

function sendUnsubscribePage(response: Response, status: number, html: string) {
  response
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      'Cache-Control': 'no-store',
    })
    .send(html);
}

// SNS posts JSON as text/plain, which the app's JSON parser leaves unread.
async function readBody(
  request: Request,
  maxBytes = MAX_SNS_BODY_BYTES,
): Promise<Buffer> {
  if (typeof request.body === 'string') return Buffer.from(request.body);
  if (request.body && Object.keys(request.body).length > 0) {
    return Buffer.from(JSON.stringify(request.body));
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new BadRequestException('Message too large');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

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
import { Public } from '../auth/public.decorator';
import { EmailTrackingService } from './email-tracking.service';
import { parseTrackingToken, TRANSPARENT_GIF } from './open-pixel';
import { SnsMessage } from './sns';

// SNS notifications with the email inline are at most ~200 KB once encoded.
const MAX_SNS_BODY_BYTES = 1024 * 1024;

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

  /** SNS endpoint for replies that SES receives on the reply domain. */
  @Post('inbound')
  @Public()
  @HttpCode(200)
  async inbound(@Req() request: Request) {
    let message: SnsMessage;
    try {
      message = JSON.parse(await readBody(request));
    } catch {
      throw new BadRequestException('Expected an SNS message');
    }

    if (!(await this.tracking.handleSnsMessage(message))) {
      throw new ForbiddenException('Message is not from an allowed SNS topic');
    }
    return { ok: true };
  }
}

// SNS posts JSON as text/plain, which the app's JSON parser leaves unread.
async function readBody(request: Request): Promise<string> {
  if (typeof request.body === 'string') return request.body;
  if (request.body && Object.keys(request.body).length > 0) {
    return JSON.stringify(request.body);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_SNS_BODY_BYTES) {
      throw new BadRequestException('Message too large');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

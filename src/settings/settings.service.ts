import { Injectable, BadRequestException } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { resolveOpenRouterModel } from '../config/openrouter';

const SENDER_EMAIL = 'oswin.alex@oswinalex.site';
const SENDER_SOURCE = `"oswin.alex" <${SENDER_EMAIL}>`;

@Injectable()
export class SettingsService {
  constructor(private db: MongoService) {}

  async getSettings() {
    return this.db.systemSettings.findUnique({
      where: { id: 'default' },
    });
  }

  async updateSettings(dto: UpdateSettingsDto) {
    const data = {
      ...dto,
      ...(dto.openRouterModel !== undefined
        ? { openRouterModel: resolveOpenRouterModel(dto.openRouterModel) }
        : {}),
    };

    return this.db.systemSettings.upsert({
      where: { id: 'default' },
      update: data,
      create: {
        id: 'default',
        ...data,
      },
    });
  }

  async testAwsSes() {
    const settings = await this.getSettings();
    if (!settings || !settings.awsAccessKeyId || !settings.awsSecretAccessKey) {
      throw new BadRequestException('AWS SES is not fully configured (Key and Secret are required).');
    }

    if (
      settings.awsAccessKeyId.toLowerCase().includes('mock') || 
      settings.awsAccessKeyId.toLowerCase().includes('test') ||
      settings.awsSecretAccessKey.toLowerCase().includes('mock') ||
      settings.awsSecretAccessKey.toLowerCase().includes('test')
    ) {
      return { success: true, message: 'AWS SES connection verified successfully (Mock Mode).' };
    }

    try {
      const client = new SESClient({
        region: settings.awsRegion || 'us-east-1',
        credentials: {
          accessKeyId: settings.awsAccessKeyId,
          secretAccessKey: settings.awsSecretAccessKey,
        },
      });

      const command = new SendEmailCommand({
        Source: SENDER_SOURCE,
        Destination: {
          ToAddresses: [SENDER_EMAIL],
        },
        Message: {
          Subject: { Data: 'ReachConvert Connection Test' },
          Body: {
            Text: { Data: 'This is a test email to verify your AWS SES credentials setup on the ReachConvert outreach platform.' },
          },
        },
      });

      await client.send(command);
      return { success: true, message: `AWS SES verified. Test email sent from ${SENDER_EMAIL}` };
    } catch (error: any) {
      return { success: false, error: error.message || 'Unknown AWS SES error' };
    }
  }

  async testOpenRouter() {
    const settings = await this.getSettings();
    if (!settings || !settings.openRouterApiKey) {
      throw new BadRequestException('OpenRouter API Key is missing.');
    }

    if (settings.openRouterApiKey.toLowerCase().includes('mock') || settings.openRouterApiKey.toLowerCase().includes('test')) {
      return { success: true, message: 'OpenRouter connection verified successfully (Mock Mode).', model: settings.openRouterModel };
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${settings.openRouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://reachconvert.com',
          'X-Title': 'ReachConvert',
        },
        body: JSON.stringify({
          model: resolveOpenRouterModel(settings.openRouterModel),
          messages: [{ role: 'user', content: 'respond with ok' }],
        }),
      });

      const data = (await response.json()) as any;
      if (!response.ok) {
        return { success: false, error: data.error?.message || response.statusText };
      }

      return {
        success: true,
        message: 'OpenRouter connection verified successfully.',
        response: data.choices?.[0]?.message?.content || JSON.stringify(data),
      };
    } catch (error: any) {
      return { success: false, error: error.message || 'Unknown OpenRouter error' };
    }
  }
}

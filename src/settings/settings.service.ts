import { Injectable, BadRequestException } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { resolveOpenRouterModel } from '../config/openrouter';

const SENDER_EMAIL = 'oswin.alex@oswinalex.site';
const SENDER_SOURCE = `"oswin.alex" <${SENDER_EMAIL}>`;
const GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const GEMINI_TTS_SAMPLE_RATE = 24000;

@Injectable()
export class SettingsService {
  constructor(private db: MongoService) {}

  async getRawSettings() {
    return this.db.systemSettings.findUnique({
      where: { id: 'default' },
    });
  }

  async getSettings() {
    const settings = await this.getRawSettings();
    if (!settings) return null;
    return {
      ...settings,
      awsSecretAccessKey: settings.awsSecretAccessKey ? '••••••••••••••••' : '',
      openRouterApiKey: settings.openRouterApiKey ? '••••••••••••••••' : '',
      twilioAuthToken: settings.twilioAuthToken ? '••••••••••••••••' : '',
      geminiApiKey: settings.geminiApiKey ? '••••••••••••••••' : '',
    };
  }

  async updateSettings(dto: UpdateSettingsDto) {
    const current = await this.getRawSettings();
    const data: any = {};

    const keysToMask = [
      'awsSecretAccessKey',
      'openRouterApiKey',
      'twilioAuthToken',
      'geminiApiKey',
    ];

    for (const [key, val] of Object.entries(dto)) {
      if (keysToMask.includes(key) && val === '••••••••••••••••') {
        if (current && current[key]) {
          data[key] = current[key];
        }
      } else {
        data[key] = val;
      }
    }

    if (dto.openRouterModel !== undefined) {
      data.openRouterModel = resolveOpenRouterModel(dto.openRouterModel);
    }

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
    const settings = await this.getRawSettings();
    if (!settings || !settings.awsAccessKeyId || !settings.awsSecretAccessKey) {
      throw new BadRequestException(
        'AWS SES is not fully configured (Key and Secret are required).',
      );
    }

    if (
      settings.awsAccessKeyId.toLowerCase().includes('mock') ||
      settings.awsAccessKeyId.toLowerCase().includes('test') ||
      settings.awsSecretAccessKey.toLowerCase().includes('mock') ||
      settings.awsSecretAccessKey.toLowerCase().includes('test')
    ) {
      return {
        success: true,
        message: 'AWS SES connection verified successfully (Mock Mode).',
      };
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
            Text: {
              Data: 'This is a test email to verify your AWS SES credentials setup on the ReachConvert outreach platform.',
            },
          },
        },
      });

      await client.send(command);
      return {
        success: true,
        message: `AWS SES verified. Test email sent from ${SENDER_EMAIL}`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Unknown AWS SES error',
      };
    }
  }

  async testOpenRouter() {
    const settings = await this.getRawSettings();
    if (!settings || !settings.openRouterApiKey) {
      throw new BadRequestException('OpenRouter API Key is missing.');
    }

    if (
      settings.openRouterApiKey.toLowerCase().includes('mock') ||
      settings.openRouterApiKey.toLowerCase().includes('test')
    ) {
      return {
        success: true,
        message: 'OpenRouter connection verified successfully (Mock Mode).',
        model: settings.openRouterModel,
      };
    }

    try {
      const response = await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.openRouterApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://reachconvert.com',
            'X-Title': 'ReachConvert',
          },
          body: JSON.stringify({
            model: resolveOpenRouterModel(settings.openRouterModel),
            messages: [{ role: 'user', content: 'respond with ok' }],
          }),
        },
      );

      const data = await response.json();
      if (!response.ok) {
        return {
          success: false,
          error: data.error?.message || response.statusText,
        };
      }

      return {
        success: true,
        message: 'OpenRouter connection verified successfully.',
        response: data.choices?.[0]?.message?.content || JSON.stringify(data),
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Unknown OpenRouter error',
      };
    }
  }

  async testTwilio() {
    const settings = await this.getRawSettings();
    if (
      !settings ||
      !settings.twilioAccountSid ||
      !settings.twilioAuthToken ||
      !settings.twilioPhoneNumber
    ) {
      throw new BadRequestException(
        'Twilio is not fully configured (Account SID, Auth Token, and Phone Number are required).',
      );
    }

    if (
      settings.twilioAccountSid.toLowerCase().includes('mock') ||
      settings.twilioAccountSid.toLowerCase().includes('test') ||
      settings.twilioAuthToken.toLowerCase().includes('mock') ||
      settings.twilioAuthToken.toLowerCase().includes('test')
    ) {
      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: {
          twilioStatus: 'CONNECTED',
          twilioLastVerified: new Date(),
        },
      });
      return {
        success: true,
        message: 'Twilio connection verified successfully (Mock Mode).',
      };
    }

    try {
      const auth = Buffer.from(
        `${settings.twilioAccountSid}:${settings.twilioAuthToken}`,
      ).toString('base64');
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${settings.twilioAccountSid}.json`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        },
      );

      if (!response.ok) {
        const errText = await response.text();
        await this.db.systemSettings.update({
          where: { id: 'default' },
          data: { twilioStatus: 'FAILED' },
        });
        return {
          success: false,
          error: `Twilio API error: ${response.statusText} (${errText})`,
        };
      }

      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: {
          twilioStatus: 'CONNECTED',
          twilioLastVerified: new Date(),
        },
      });

      return {
        success: true,
        message: 'Twilio connection verified successfully.',
      };
    } catch (error: any) {
      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: { twilioStatus: 'FAILED' },
      });
      return {
        success: false,
        error: error.message || 'Unknown Twilio error',
      };
    }
  }

  async testGemini() {
    const settings = await this.getRawSettings();
    if (!settings || !settings.geminiApiKey) {
      throw new BadRequestException('Gemini API Key is missing.');
    }

    if (
      settings.geminiApiKey.toLowerCase().includes('mock') ||
      settings.geminiApiKey.toLowerCase().includes('test')
    ) {
      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: {
          geminiStatus: 'CONNECTED',
          geminiLastVerified: new Date(),
        },
      });
      return {
        success: true,
        message: 'Gemini connection verified successfully (Mock Mode).',
      };
    }

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${settings.geminiApiKey}`,
      );

      const data = await response.json();
      if (!response.ok) {
        await this.db.systemSettings.update({
          where: { id: 'default' },
          data: { geminiStatus: 'FAILED' },
        });
        return {
          success: false,
          error: data.error?.message || response.statusText,
        };
      }

      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: {
          geminiStatus: 'CONNECTED',
          geminiLastVerified: new Date(),
        },
      });

      return {
        success: true,
        message: 'Gemini connection verified successfully.',
      };
    } catch (error: any) {
      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: { geminiStatus: 'FAILED' },
      });
      return {
        success: false,
        error: error.message || 'Unknown Gemini error',
      };
    }
  }

  async previewGeminiVoice(dto: {
    voice: string;
    language?: string;
    text?: string;
  }) {
    const settings = await this.getRawSettings();
    if (!settings || !settings.geminiApiKey) {
      throw new BadRequestException('Gemini API Key is missing.');
    }

    const voice = dto.voice?.trim();
    if (!voice) {
      throw new BadRequestException('Voice is required.');
    }

    if (
      settings.geminiApiKey.toLowerCase().includes('mock') ||
      settings.geminiApiKey.toLowerCase().includes('test')
    ) {
      throw new BadRequestException(
        'Gemini voice preview requires a real Gemini API key.',
      );
    }

    const languageHint =
      dto.language === 'en-IN'
        ? ' Speak naturally in Indian English with a clear, professional accent.'
        : dto.language
          ? ` Speak naturally in language code ${dto.language}.`
          : '';
    const text =
      dto.text?.trim() ||
      `Say warmly:${languageHint} Hello, this is a quick ReachConvert voice preview.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${settings.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voice,
                },
              },
            },
          },
        }),
      },
    );

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new BadRequestException(
        data?.error?.message || 'Gemini voice preview failed.',
      );
    }

    const inlineData =
      data?.candidates?.[0]?.content?.parts?.find(
        (part: any) => part.inlineData,
      )?.inlineData || data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    const audioBase64 = inlineData?.data;
    if (!audioBase64) {
      throw new BadRequestException('Gemini did not return preview audio.');
    }

    return {
      success: true,
      voice,
      mimeType: 'audio/wav',
      audioDataUrl: `data:audio/wav;base64,${this.toWaveBase64(audioBase64)}`,
    };
  }

  private toWaveBase64(pcmBase64: string) {
    const pcm = Buffer.from(pcmBase64, 'base64');
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(GEMINI_TTS_SAMPLE_RATE, 24);
    header.writeUInt32LE(GEMINI_TTS_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);

    return Buffer.concat([header, pcm]).toString('base64');
  }
}

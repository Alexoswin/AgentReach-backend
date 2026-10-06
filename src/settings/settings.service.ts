import { Injectable, BadRequestException } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { resolveGeminiTextModel } from '../config/gemini-text';
import {
  MASKED_CREDENTIAL,
  SYSTEM_CREDENTIAL_FIELDS,
  decryptSystemSettings,
  encryptSystemSettingsData,
  maskSystemSettings,
} from './credential-encryption';

@Injectable()
export class SettingsService {
  constructor(private db: MongoService) {}

  async getRawSettings() {
    const settings = await this.db.systemSettings.findUnique({
      where: { id: 'default' },
    });
    return decryptSystemSettings(settings);
  }

  async getSettings() {
    const settings = await this.getRawSettings();
    return maskSystemSettings(settings);
  }

  async updateSettings(dto: UpdateSettingsDto) {
    const current = await this.db.systemSettings.findUnique({
      where: { id: 'default' },
    });
    const data: any = {};

    for (const [key, val] of Object.entries(dto)) {
      if (
        SYSTEM_CREDENTIAL_FIELDS.includes(key as any) &&
        val === MASKED_CREDENTIAL
      ) {
        if (current && current[key]) {
          data[key] = current[key];
        }
      } else {
        data[key] = val;
      }
    }

    if (dto.geminiTextModel !== undefined) {
      data.geminiTextModel = resolveGeminiTextModel(dto.geminiTextModel);
    }

    const encryptedData = encryptSystemSettingsData(data);
    const settings = await this.db.systemSettings.upsert({
      where: { id: 'default' },
      update: encryptedData,
      create: {
        id: 'default',
        ...encryptedData,
      },
    });

    return maskSystemSettings(decryptSystemSettings(settings));
  }

  async testAwsSes() {
    const settings = await this.getRawSettings();
    if (!settings || !settings.awsAccessKeyId || !settings.awsSecretAccessKey) {
      throw new BadRequestException(
        'AWS SES is not fully configured (Key and Secret are required).',
      );
    }
    if (!settings.awsSenderEmail) {
      throw new BadRequestException(
        'Add a Sender Email Address before testing your SES connection.',
      );
    }

    const senderEmail = settings.awsSenderEmail;
    const senderSource = `<${senderEmail}>`;

    try {
      const client = new SESClient({
        region: settings.awsRegion || 'us-east-1',
        credentials: {
          accessKeyId: settings.awsAccessKeyId,
          secretAccessKey: settings.awsSecretAccessKey,
        },
      });

      const command = new SendEmailCommand({
        Source: senderSource,
        Destination: {
          ToAddresses: [senderEmail],
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
        message: `AWS SES verified. Test email sent from ${senderEmail}`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Unknown AWS SES error',
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

  async testPlivo() {
    const settings = await this.getRawSettings();
    if (
      !settings ||
      !settings.plivoAuthId ||
      !settings.plivoAuthToken ||
      !settings.plivoPhoneNumber
    ) {
      throw new BadRequestException(
        'Plivo is not fully configured (Auth ID, Auth Token, and Phone Number are required).',
      );
    }

    try {
      const auth = Buffer.from(
        `${settings.plivoAuthId}:${settings.plivoAuthToken}`,
      ).toString('base64');
      const response = await fetch(
        `https://api.plivo.com/v1/Account/${settings.plivoAuthId}/`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
          signal: AbortSignal.timeout(15000),
        },
      );

      if (!response.ok) {
        const errText = await response.text();
        await this.db.systemSettings.update({
          where: { id: 'default' },
          data: { plivoStatus: 'FAILED' },
        });
        return {
          success: false,
          error: `Plivo API error: ${response.statusText} (${errText})`,
        };
      }

      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: {
          plivoStatus: 'CONNECTED',
          plivoLastVerified: new Date(),
        },
      });

      return {
        success: true,
        message: 'Plivo connection verified successfully.',
      };
    } catch (error: any) {
      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: { plivoStatus: 'FAILED' },
      });
      return {
        success: false,
        error: error.message || 'Unknown Plivo error',
      };
    }
  }

  async testGemini(payload: { geminiApiKey?: string } = {}) {
    const apiKey = await this.getGeminiApiKey(payload.geminiApiKey);
    if (!apiKey) {
      throw new BadRequestException('Gemini API key is missing.');
    }

    try {
      await this.testGeminiApiKey(apiKey);

      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: {
          geminiStatus: 'CONNECTED',
          geminiLastVerified: new Date(),
        },
      });

      return {
        success: true,
        message: 'Gemini API key verified successfully.',
      };
    } catch (error: any) {
      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: { geminiStatus: 'FAILED' },
      });
      return {
        success: false,
        error: error.message || 'Unknown Gemini API key error',
      };
    }
  }

  async previewGeminiVoice(dto: {
    voice: string;
    language?: string;
    text?: string;
  }) {
    const apiKey = await this.getGeminiApiKey();
    if (!apiKey) {
      throw new BadRequestException(
        'Gemini API key is not configured. Set it in Settings to enable voice preview.',
      );
    }

    const rawVoice = String(dto.voice || '').trim();
    const withoutProvider = rawVoice.replace(/^google:/i, '');
    const parts = withoutProvider.split('-');
    const lastName = parts.at(-1) || '';
    const voiceName =
      lastName.charAt(0).toUpperCase() + lastName.slice(1).toLowerCase() ||
      'Puck';
    const languageCode =
      String(
        dto.language ||
          withoutProvider.match(/^([a-z]{2,3}-[A-Z]{2})-/)?.[1] ||
          'en-IN',
      ).trim() || 'en-IN';
    const speechLanguageCode =
      languageCode.split('-')[0]?.toLowerCase() || 'en';

    const text =
      String(dto.text || '').trim() ||
      'Hello! This is a preview of the selected voice.';

    const model = 'gemini-2.5-flash-preview-tts';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              languageCode: speechLanguageCode,
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
          },
        }),
        signal: AbortSignal.timeout(12000),
      });
    } catch (err) {
      throw new BadRequestException(
        `Voice preview request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const data = await response.json().catch(() => null);
    const pcmBase64: string | undefined =
      data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!response.ok || !pcmBase64) {
      throw new BadRequestException(
        `Voice preview failed: ${data?.error?.message || response.statusText || 'empty audio response'}`,
      );
    }

    const pcm = Buffer.from(pcmBase64, 'base64');
    const wav = this.pcmToWav(pcm, 24000, 1, 16);
    const audioDataUrl = `data:audio/wav;base64,${wav.toString('base64')}`;
    return { audioDataUrl };
  }

  private pcmToWav(
    pcm: Buffer,
    sampleRate: number,
    numChannels: number,
    bitsPerSample: number,
  ): Buffer {
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }

  private async testGeminiApiKey(apiKey: string) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new BadRequestException(
        data?.error?.message ||
          response.statusText ||
          'Gemini API key verification failed.',
      );
    }
  }

  private async getGeminiApiKey(candidate?: string) {
    const provided = candidate?.trim() || '';
    if (provided && provided !== MASKED_CREDENTIAL) return provided;

    const settings = await this.getRawSettings();
    return (
      settings?.geminiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim() || ''
    );
  }
}

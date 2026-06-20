import { Injectable, BadRequestException } from '@nestjs/common';
import { createSign } from 'crypto';
import { MongoService } from '../mongo.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { resolveOpenRouterModel } from '../config/openrouter';
import {
  MASKED_CREDENTIAL,
  SYSTEM_CREDENTIAL_FIELDS,
  decryptSystemSettings,
  encryptSystemSettingsData,
  maskSystemSettings,
} from './credential-encryption';

const SENDER_EMAIL = 'oswin.alex@oswinalex.site';
const SENDER_SOURCE = `"oswin.alex" <${SENDER_EMAIL}>`;
const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

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

    if (dto.openRouterModel !== undefined) {
      data.openRouterModel = resolveOpenRouterModel(dto.openRouterModel);
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
    if (!settings?.googleServiceAccountJson) {
      throw new BadRequestException('Google service account JSON is missing.');
    }

    try {
      await this.getGoogleAccessTokenFromServiceAccount(
        settings.googleServiceAccountJson,
      );

      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: {
          geminiStatus: 'CONNECTED',
          geminiLastVerified: new Date(),
        },
      });

      return {
        success: true,
        message: 'Google service account verified successfully.',
      };
    } catch (error: any) {
      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: { geminiStatus: 'FAILED' },
      });
      return {
        success: false,
        error: error.message || 'Unknown Google credential error',
      };
    }
  }

  async previewGeminiVoice(dto: {
    voice: string;
    language?: string;
    text?: string;
  }) {
    const settings = await this.getRawSettings();
    if (!settings?.googleServiceAccountJson) {
      throw new BadRequestException('Google service account JSON is missing.');
    }

    const voice = dto.voice?.trim();
    if (!voice) {
      throw new BadRequestException('Voice is required.');
    }

    const accessToken = await this.getGoogleAccessTokenFromServiceAccount(
      settings.googleServiceAccountJson,
    );
    const languageCode = this.normalizeLanguageCode(dto.language) || 'en-IN';
    const voiceName = this.resolveGoogleVoiceName(voice, languageCode);
    const text =
      dto.text?.trim() ||
      'Hello, this is a quick ReachConvert voice preview.';

    const response = await fetch(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode,
            name: voiceName,
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: languageCode === 'hi-IN' ? 0.96 : 1.02,
            pitch: 0,
          },
        }),
      },
    );

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.audioContent) {
      throw new BadRequestException(
        data?.error?.message || 'Google voice preview failed.',
      );
    }

    return {
      success: true,
      voice: voiceName,
      mimeType: 'audio/mpeg',
      audioDataUrl: `data:audio/mpeg;base64,${data.audioContent}`,
    };
  }

  private normalizeLanguageCode(language?: string) {
    const normalized = language?.trim();
    if (normalized === 'hi') return 'hi-IN';
    if (normalized === 'en') return 'en-US';
    return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(normalized || '')
      ? normalized
      : undefined;
  }

  private resolveGoogleVoiceName(voice: string, languageCode: string) {
    const normalizedVoice = voice.trim();
    const withoutProvider = normalizedVoice.startsWith('google:')
      ? normalizedVoice.slice('google:'.length)
      : normalizedVoice;

    if (/^[a-z]{2}-[A-Z]{2}-Chirp3-HD-[A-Za-z]+$/.test(withoutProvider)) {
      return withoutProvider;
    }

    const rawName = withoutProvider.split('-').at(-1) || 'Puck';
    const formattedName = `${rawName.charAt(0).toUpperCase()}${rawName
      .slice(1)
      .toLowerCase()}`;

    return `${languageCode}-Chirp3-HD-${formattedName || 'Puck'}`;
  }

  private async getGoogleAccessTokenFromServiceAccount(
    serviceAccountJson: string,
  ) {
    let credentials: any;

    try {
      credentials = JSON.parse(serviceAccountJson);
    } catch {
      throw new BadRequestException('Google service account JSON is invalid JSON.');
    }

    const clientEmail = String(credentials?.client_email || '').trim();
    const privateKey = String(credentials?.private_key || '').trim();

    if (!clientEmail || !privateKey) {
      throw new BadRequestException(
        'Google service account JSON must include client_email and private_key.',
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const header = this.base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = this.base64UrlEncode(
      JSON.stringify({
        iss: clientEmail,
        scope: GOOGLE_CLOUD_SCOPE,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    );
    const unsignedJwt = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256').update(unsignedJwt).sign(privateKey);
    const assertion = `${unsignedJwt}.${this.base64UrlEncode(signature)}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.access_token) {
      throw new BadRequestException(
        data?.error_description ||
          data?.error ||
          response.statusText ||
          'Google OAuth token request failed.',
      );
    }

    return String(data.access_token);
  }

  private base64UrlEncode(value: string | Buffer) {
    return Buffer.from(value)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

}

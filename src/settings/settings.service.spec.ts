import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { MASKED_CREDENTIAL } from './credential-encryption';
import { UpdateSettingsDto } from './dto/update-settings.dto';

function createSettingsService() {
  const records: any[] = [];
  const systemSettings = {
    findUnique: jest.fn(
      async ({ where }) => records.find((item) => item.id === where.id) || null,
    ),
    upsert: jest.fn(async ({ where, update, create }) => {
      const index = records.findIndex((item) => item.id === where.id);
      if (index >= 0) {
        records[index] = { ...records[index], ...update };
        return records[index];
      }
      records.push(create);
      return create;
    }),
  };
  return new SettingsService({ systemSettings } as any);
}

describe('SettingsService', () => {
  it("keeps each user's provider credentials to that user", async () => {
    const service = createSettingsService();

    await service.updateSettings('user-a', {
      geminiApiKey: 'a-gemini-key',
      twilioAuthToken: 'a-twilio-token',
    });

    expect((await service.getRawSettings('user-a'))?.geminiApiKey).toBe(
      'a-gemini-key',
    );
    expect(await service.getRawSettings('user-b')).toBeNull();
    expect(await service.getRawSettings(undefined)).toBeNull();
    // The API only ever returns the mask.
    expect((await service.getSettings('user-a'))?.twilioAuthToken).toBe(
      MASKED_CREDENTIAL,
    );
  });

  it('keeps a saved credential when the masked value is sent back', async () => {
    const service = createSettingsService();
    await service.updateSettings('user-a', { geminiApiKey: 'real-key' });

    await service.updateSettings('user-a', {
      geminiApiKey: MASKED_CREDENTIAL,
    });

    expect((await service.getRawSettings('user-a'))?.geminiApiKey).toBe(
      'real-key',
    );
  });

  it('saves only the fields filled in, leaving the rest optional', async () => {
    const service = createSettingsService();

    // What the Settings page sends for a user who only adds a Gemini key.
    await service.updateSettings('user-a', {
      awsAccessKeyId: '',
      awsSecretAccessKey: '',
      awsRegion: 'us-east-1',
      awsSenderEmail: '',
      geminiApiKey: '  gemini-key-with-spaces  ',
      twilioAccountSid: '',
      twilioAuthToken: '',
      twilioPhoneNumber: '',
      callProvider: 'twilio',
    });

    const saved = await service.getRawSettings('user-a');
    expect(saved).toMatchObject({
      geminiApiKey: 'gemini-key-with-spaces',
      awsSenderEmail: '',
      twilioAuthToken: '',
    });
  });

  it('ignores fields the validator passes through as undefined', async () => {
    const service = createSettingsService();
    await service.updateSettings('user-a', {
      twilioAuthToken: 'token-1',
    });

    await service.updateSettings('user-a', {
      twilioAuthToken: undefined,
      twilioPhoneNumber: '+15550100',
    });

    expect(await service.getRawSettings('user-a')).toMatchObject({
      twilioAuthToken: 'token-1',
      twilioPhoneNumber: '+15550100',
    });
  });

  it('clears a credential when its field is emptied', async () => {
    const service = createSettingsService();
    await service.updateSettings('user-a', { geminiApiKey: 'old' });

    await service.updateSettings('user-a', { geminiApiKey: '' });

    expect((await service.getRawSettings('user-a'))?.geminiApiKey).toBe('');
  });

  it('rejects an edited mask instead of saving it as the credential', async () => {
    const service = createSettingsService();
    await service.updateSettings('user-a', { twilioAuthToken: 'real' });

    await expect(
      service.updateSettings('user-a', {
        twilioAuthToken: `${MASKED_CREDENTIAL}x`,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await service.getRawSettings('user-a'))?.twilioAuthToken).toBe(
      'real',
    );
  });

  it('checks the sender email only when one is entered', async () => {
    const service = createSettingsService();

    await expect(
      service.updateSettings('user-a', {
        awsSenderEmail: 'not-an-email',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.updateSettings('user-a', {
      awsSenderEmail: ' sender@example.com ',
    });

    expect((await service.getRawSettings('user-a'))?.awsSenderEmail).toBe(
      'sender@example.com',
    );
  });
});

describe('UpdateSettingsDto', () => {
  it('accepts a save with every field blank', async () => {
    const dto = plainToInstance(UpdateSettingsDto, {
      awsAccessKeyId: '',
      awsSecretAccessKey: '',
      awsRegion: '',
      awsSenderEmail: '',
      geminiApiKey: '',
      geminiTextModel: '',
      twilioAccountSid: '',
      twilioAuthToken: '',
      twilioPhoneNumber: '',
      callProvider: 'twilio',
      plivoAuthId: '',
      plivoAuthToken: '',
      plivoPhoneNumber: '',
    });

    expect(await validate(dto, { whitelist: true })).toEqual([]);
  });
});

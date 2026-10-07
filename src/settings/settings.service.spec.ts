import { SettingsService } from './settings.service';
import { MASKED_CREDENTIAL } from './credential-encryption';

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
});

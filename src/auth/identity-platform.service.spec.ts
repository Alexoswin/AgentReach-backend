import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { IdentityPlatformService } from './identity-platform.service';

const verifyIdToken = jest.fn();

function createService() {
  const configService = {
    get: jest.fn((key: string) =>
      key === 'FIREBASE_PROJECT_ID' ? 'test-project' : undefined,
    ),
  };
  const service = new IdentityPlatformService(configService as any);
  jest.spyOn(service as any, 'loadAdminSdk').mockResolvedValue({
    getApps: () => [{}],
    initializeApp: jest.fn(),
    getAuth: () => ({ verifyIdToken }),
  });
  return service;
}

function adminError(code: string) {
  return Object.assign(new Error(code), { code });
}

describe('IdentityPlatformService', () => {
  beforeEach(() => verifyIdToken.mockReset());

  it('accepts a verified Google token', async () => {
    verifyIdToken.mockResolvedValue({
      uid: 'google-uid',
      email: 'jane@x.com',
      email_verified: true,
      firebase: { sign_in_provider: 'google.com' },
    });

    await expect(
      createService().verifyGoogleIdToken('token'),
    ).resolves.toMatchObject({ uid: 'google-uid' });
    expect(verifyIdToken).toHaveBeenCalledWith('token', true);
  });

  it('reports a bad or expired token as unauthorized', async () => {
    verifyIdToken.mockRejectedValue(adminError('auth/id-token-expired'));

    await expect(
      createService().verifyGoogleIdToken('token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reports a server-side verification failure as unavailable', async () => {
    verifyIdToken.mockRejectedValue(adminError('auth/insufficient-permission'));

    await expect(
      createService().verifyGoogleIdToken('token'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects tokens from other providers', async () => {
    verifyIdToken.mockResolvedValue({
      uid: 'uid',
      email: 'jane@x.com',
      email_verified: true,
      firebase: { sign_in_provider: 'password' },
    });

    await expect(
      createService().verifyGoogleIdToken('token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

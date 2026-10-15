import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError, JwtExpiredError } from 'aws-jwt-verify/error';
import { CognitoAuthService } from './cognito-auth.service';

const googleClaims = {
  sub: 'cognito-sub',
  email: 'Jane@Acme.com',
  email_verified: 'true',
  name: 'Jane Doe',
  nonce: 'nonce-1',
  identities: [
    { providerName: 'Google', providerType: 'Google', userId: '1098765' },
  ],
};

function setup(verify: jest.Mock) {
  jest.spyOn(CognitoJwtVerifier, 'create').mockReturnValue({ verify } as never);
  const config = {
    get: jest.fn(
      (key: string) =>
        ({
          COGNITO_USER_POOL_ID: 'ap-south-1_example',
          COGNITO_CLIENT_ID: 'client-1',
        })[key],
    ),
  };
  return new CognitoAuthService(config as any);
}

describe('CognitoAuthService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the Google identity from a valid ID token', async () => {
    const createVerifier = jest.spyOn(CognitoJwtVerifier, 'create');
    const service = setup(jest.fn().mockResolvedValue(googleClaims));

    await expect(
      service.verifyGoogleIdToken('token', 'nonce-1'),
    ).resolves.toEqual({
      googleId: '1098765',
      email: 'jane@acme.com',
      name: 'Jane Doe',
    });
    expect(createVerifier).toHaveBeenCalledWith({
      userPoolId: 'ap-south-1_example',
      clientId: 'client-1',
      tokenUse: 'id',
    });
  });

  it.each([
    ['an unverified email', { email_verified: 'false' }],
    ['no Google identity', { identities: [] }],
    ['a different nonce', { nonce: 'someone-else' }],
  ])('rejects a token with %s', async (_, overrides) => {
    const service = setup(
      jest.fn().mockResolvedValue({ ...googleClaims, ...overrides }),
    );

    await expect(
      service.verifyGoogleIdToken('token', 'nonce-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reports an expired token as the user’s problem', async () => {
    const service = setup(
      jest.fn().mockRejectedValue(new JwtExpiredError('expired', 1)),
    );

    await expect(service.verifyGoogleIdToken('token')).rejects.toThrow(
      'The Google sign-in has expired. Try again.',
    );
  });

  it('reports an unreachable key set as a server problem', async () => {
    const service = setup(
      jest.fn().mockRejectedValue(new FetchError('https://jwks', 'timeout')),
    );

    await expect(service.verifyGoogleIdToken('token')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('is unavailable until the user pool is configured', async () => {
    const service = new CognitoAuthService({ get: jest.fn() } as any);

    expect(service.isConfigured()).toBe(false);
    await expect(service.verifyGoogleIdToken('token')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

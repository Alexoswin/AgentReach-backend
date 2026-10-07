import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { hashPassword, verifyPassword } from './password';
import { signCallToken, verifyCallToken } from './secrets';

function createUserDelegate(records: any[] = []) {
  const matches = (item: any, where: any) =>
    Object.entries(where).every(([key, value]) => item[key] === value);
  return {
    records,
    findUnique: jest.fn(
      async ({ where }) => records.find((item) => matches(item, where)) || null,
    ),
    create: jest.fn(async ({ data }) => {
      const item = { id: `${records.length + 1}`, ...data };
      records.push(item);
      return item;
    }),
    update: jest.fn(async ({ where, data }) => {
      const index = records.findIndex((item) => item.id === where.id);
      records[index] = { ...records[index], ...data };
      return records[index];
    }),
  };
}

function createService(users: any[] = [], env: Record<string, string> = {}) {
  const user = createUserDelegate(users);
  const settingsService = { getRawSettings: jest.fn(async () => null) };
  const configService = { get: jest.fn((key: string) => env[key]) };
  const service = new AuthService(
    { user } as any,
    new TokenService(),
    settingsService as any,
    configService as any,
    { verifyGoogleIdToken: jest.fn() } as any,
  );
  return { service, user };
}

describe('AuthService', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('closes registration in production unless explicitly allowed', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'test-secret';
    const dto = {
      name: 'Jane Doe',
      email: 'jane@x.com',
      password: 'secret123',
    };

    await expect(createService().service.register(dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const allowlisted = createService([], {
      ALLOWED_SIGNUP_EMAILS: 'Jane@x.com',
    });
    jest
      .spyOn(allowlisted.service as any, 'sendEmailVerificationCode')
      .mockResolvedValue(undefined);
    await expect(allowlisted.service.register(dto)).resolves.toHaveProperty(
      'requiresEmailVerification',
      true,
    );

    const open = createService([], { ALLOW_REGISTRATION: 'true' });
    jest
      .spyOn(open.service as any, 'sendEmailVerificationCode')
      .mockResolvedValue(undefined);
    await expect(open.service.register(dto)).resolves.toHaveProperty(
      'requiresEmailVerification',
      true,
    );
    delete process.env.JWT_SECRET;
  });

  it('verifies a new email before issuing a password session', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'test-secret';
    const { service, user } = createService([], {
      ALLOW_REGISTRATION: 'true',
    });
    let sentCode = '';
    jest
      .spyOn(service as any, 'sendEmailVerificationCode')
      .mockImplementation(async (_email: string, code: string) => {
        sentCode = code;
      });

    const registration = await service.register({
      name: 'Jane Doe',
      email: 'jane@x.com',
      password: 'secret123',
    });
    expect(registration).toMatchObject({
      requiresEmailVerification: true,
      email: 'jane@x.com',
    });
    expect(user.records[0].emailVerified).toBe(false);

    await expect(
      service.login({ email: 'jane@x.com', password: 'secret123' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const session = await service.verifyEmail({
      email: 'jane@x.com',
      code: sentCode,
    });
    expect(session).toHaveProperty('accessToken');
    expect(user.records[0].emailVerified).toBe(true);
    expect(user.records[0].emailVerificationCodeHash).toBeNull();
    delete process.env.JWT_SECRET;
  });

  it('reuses an unverified password account during signup', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'test-secret';
    const { service, user } = createService(
      [
        {
          id: 'pending-1',
          email: 'jane@x.com',
          passwordHash: 'previous-password-hash',
          authProvider: 'password',
          emailVerified: false,
          identityPlatformUid: null,
          emailVerificationSentAt: new Date(Date.now() - 61_000),
        },
      ],
      { ALLOW_REGISTRATION: 'true' },
    );
    let sentCode = '';
    jest
      .spyOn(service as any, 'sendEmailVerificationCode')
      .mockImplementation(async (_email: string, code: string) => {
        sentCode = code;
      });

    const result = await service.register({
      name: 'Updated Jane',
      email: 'jane@x.com',
      password: 'newsecret123',
    });

    expect(result).toMatchObject({
      requiresEmailVerification: true,
      email: 'jane@x.com',
    });
    expect(sentCode).toMatch(/^\d{6}$/);
    expect(user.records[0].name).toBe('Updated Jane');
    expect(user.records[0].emailVerified).toBe(false);
    expect(user.records[0].emailVerificationAttempts).toBe(0);
    expect(user.records[0].emailVerificationCodeHash).not.toBeNull();
    delete process.env.JWT_SECRET;
  });

  it('allows a pending account to restart signup when registration is closed', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'test-secret';
    const { service } = createService([
      {
        id: 'pending-1',
        email: 'jane@x.com',
        passwordHash: 'previous-password-hash',
        authProvider: 'password',
        emailVerified: false,
        identityPlatformUid: null,
        emailVerificationSentAt: new Date(Date.now() - 61_000),
      },
    ]);
    jest
      .spyOn(service as any, 'sendEmailVerificationCode')
      .mockResolvedValue(undefined);

    await expect(
      service.register({
        name: 'Jane Doe',
        email: 'jane@x.com',
        password: 'newsecret123',
      }),
    ).resolves.toMatchObject({ requiresEmailVerification: true });
    delete process.env.JWT_SECRET;
  });

  it('does not reuse an SSO account during password signup', async () => {
    process.env.NODE_ENV = 'production';
    const { service } = createService(
      [
        {
          id: 'google-1',
          email: 'jane@x.com',
          passwordHash: null,
          authProvider: 'google',
          identityPlatformUid: 'google-uid',
          emailVerified: false,
        },
      ],
      { ALLOW_REGISTRATION: 'true' },
    );

    await expect(
      service.register({
        name: 'Jane Doe',
        email: 'jane@x.com',
        password: 'newsecret123',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('verifies and links an existing account on Google SSO login', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'test-secret';
    const { service, user } = createService([
      {
        id: 'password-1',
        email: 'jane@x.com',
        passwordHash: 'password-hash',
        authProvider: 'password',
        emailVerified: false,
        identityPlatformUid: null,
        emailVerificationCodeHash: 'code-hash',
        emailVerificationExpiresAt: new Date(Date.now() + 60_000),
        emailVerificationAttempts: 0,
        emailVerificationSentAt: new Date(),
      },
    ]);
    (service as any).identityPlatformService.verifyGoogleIdToken = jest
      .fn()
      .mockResolvedValue({
        uid: 'google-uid',
        email: 'jane@x.com',
        email_verified: true,
        name: 'Jane Doe',
      });

    const session = await service.loginWithGoogle('google-token');

    expect(session).toHaveProperty('accessToken');
    expect(user.records[0]).toMatchObject({
      identityPlatformUid: 'google-uid',
      authProvider: 'password+google',
      emailVerified: true,
      emailVerificationCodeHash: null,
    });
    delete process.env.JWT_SECRET;
  });

  it('links Google SSO to an already-verified password account', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const { service, user } = createService([
      {
        id: 'password-verified-1',
        email: 'jane@x.com',
        passwordHash: 'password-hash',
        authProvider: 'password',
        emailVerified: true,
        identityPlatformUid: null,
      },
    ]);
    (service as any).identityPlatformService.verifyGoogleIdToken = jest
      .fn()
      .mockResolvedValue({
        uid: 'google-uid',
        email: 'jane@x.com',
        email_verified: true,
      });

    await expect(
      service.loginWithGoogle('google-token'),
    ).resolves.toHaveProperty('accessToken');
    expect(user.records[0]).toMatchObject({
      identityPlatformUid: 'google-uid',
      authProvider: 'password+google',
      emailVerified: true,
    });
    delete process.env.JWT_SECRET;
  });

  it('rejects SSO when the email is linked to another Google identity', async () => {
    const { service } = createService([
      {
        id: 'google-1',
        email: 'jane@x.com',
        passwordHash: null,
        authProvider: 'google',
        identityPlatformUid: 'different-google-uid',
        emailVerified: true,
      },
    ]);
    (service as any).identityPlatformService.verifyGoogleIdToken = jest
      .fn()
      .mockResolvedValue({
        uid: 'google-uid',
        email: 'jane@x.com',
        email_verified: true,
      });

    await expect(
      service.loginWithGoogle('google-token'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers forgot-password the same way for unknown emails', async () => {
    const { service, user } = createService([
      { id: '1', email: 'a@x.com', passwordHash: 'x' },
    ]);

    const known = await service.forgotPassword({ email: 'a@x.com' });
    const unknown = await service.forgotPassword({ email: 'b@x.com' });

    expect(unknown).toEqual(known);
    expect(user.records[0].passwordResetTokenHash).toEqual(expect.any(String));
    expect(user.records[0].passwordResetExpiresAt).toBeInstanceOf(Date);
  });

  it('only resets a password with a valid, unexpired token', async () => {
    const tokens = new TokenService();
    const { service, user } = createService([
      {
        id: '1',
        email: 'a@x.com',
        passwordHash: await hashPassword('old-password'),
        passwordResetTokenHash: tokens.hashToken('good-token-0123456789'),
        passwordResetExpiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    await expect(
      service.resetPassword({
        token: 'wrong-token-0123456789',
        newPassword: 'new-password',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await service.resetPassword({
      token: 'good-token-0123456789',
      newPassword: 'new-password',
    });
    expect(
      await verifyPassword('new-password', user.records[0].passwordHash),
    ).toBe(true);
    expect(user.records[0].passwordResetTokenHash).toBeNull();

    // A token can only be used once.
    await expect(
      service.resetPassword({
        token: 'good-token-0123456789',
        newPassword: 'another-password',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an expired reset token', async () => {
    const tokens = new TokenService();
    const { service } = createService([
      {
        id: '1',
        email: 'a@x.com',
        passwordHash: 'x',
        passwordResetTokenHash: tokens.hashToken('old-token-0123456789'),
        passwordResetExpiresAt: new Date(Date.now() - 1),
      },
    ]);

    await expect(
      service.resetPassword({
        token: 'old-token-0123456789',
        newPassword: 'new-password',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('call webhook tokens', () => {
  it('accepts only the token signed for that call', () => {
    const token = signCallToken('call-1');
    expect(verifyCallToken('call-1', token)).toBe(true);
    expect(verifyCallToken('call-2', token)).toBe(false);
    expect(verifyCallToken('call-1', undefined)).toBe(false);
    expect(verifyCallToken('call-1', 'forged')).toBe(false);
  });
});

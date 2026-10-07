import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomBytes, randomInt } from 'crypto';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import { isProduction, safeEqual } from './secrets';
import { hashPassword, verifyPassword } from './password';
import { TokenService } from './token.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { RegisterDto } from './dto/register.dto';
import { IdentityPlatformService } from './identity-platform.service';
import { VerifyEmailDto } from './dto/verify-email.dto';

const THEME_VALUES = [
  'system',
  'dark-midnight',
  'dark-slate',
  'dark-graphite',
  'dark-violet',
  'light-cloud',
  'light-paper',
  'light-mint',
  'light-rose',
];

const ACCENT_VALUES = ['indigo', 'emerald', 'sky', 'rose', 'amber', 'violet'];

const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = 10 * 60 * 1000;
const EMAIL_VERIFICATION_RESEND_DELAY_MS = 60 * 1000;
const MAX_EMAIL_VERIFICATION_ATTEMPTS = 5;
const FORGOT_PASSWORD_RESPONSE = {
  success: true,
  message: 'If an account exists for that email, a reset link has been sent.',
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private db: MongoService,
    private tokenService: TokenService,
    private settingsService: SettingsService,
    private configService: ConfigService,
    private identityPlatformService: IdentityPlatformService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    const existing = await this.db.user.findUnique({
      where: { email },
    });

    if (existing) {
      const isPendingPasswordUser =
        !existing.emailVerified &&
        Boolean(existing.passwordHash) &&
        !existing.identityPlatformUid &&
        existing.authProvider !== 'google';

      if (!isPendingPasswordUser) {
        throw new BadRequestException('User with that email already exists');
      }

      // A pending account already started registration. Let the user restart
      // verification even when new account creation is closed.

      const sentAt = existing.emailVerificationSentAt
        ? new Date(existing.emailVerificationSentAt).getTime()
        : 0;
      if (sentAt && Date.now() - sentAt < EMAIL_VERIFICATION_RESEND_DELAY_MS) {
        return {
          requiresEmailVerification: true,
          email,
          message:
            'This account is awaiting email verification. Enter the code we already sent to your email.',
        };
      }

      const passwordHash = await hashPassword(dto.password);
      const verificationCode = this.createEmailVerificationCode();
      await this.sendEmailVerificationCode(email, verificationCode);
      const now = new Date();

      const parts = dto.name.trim().split(' ');
      const initials =
        parts.length > 1
          ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
          : dto.name.slice(0, 2).toUpperCase();

      await this.db.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          authProvider: 'password',
          emailVerified: false,
          emailVerificationCodeHash:
            this.tokenService.hashToken(verificationCode),
          emailVerificationExpiresAt: new Date(
            now.getTime() + EMAIL_VERIFICATION_TTL_MS,
          ),
          emailVerificationAttempts: 0,
          emailVerificationSentAt: now,
          name: dto.name.trim(),
          initials,
        },
      });

      return {
        requiresEmailVerification: true,
        email,
        message: 'We sent a new verification code to your email address.',
      };
    }

    this.assertRegistrationAllowed(email);

    const passwordHash = await hashPassword(dto.password);
    const verificationCode = this.createEmailVerificationCode();
    await this.sendEmailVerificationCode(email, verificationCode);
    const now = new Date();

    // Auto-generate initials from name
    const parts = dto.name.trim().split(' ');
    const initials =
      parts.length > 1
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : dto.name.slice(0, 2).toUpperCase();

    const user = await this.db.user.create({
      data: {
        email,
        passwordHash,
        authProvider: 'password',
        emailVerified: false,
        emailVerificationCodeHash:
          this.tokenService.hashToken(verificationCode),
        emailVerificationExpiresAt: new Date(
          now.getTime() + EMAIL_VERIFICATION_TTL_MS,
        ),
        emailVerificationAttempts: 0,
        emailVerificationSentAt: now,
        name: dto.name.trim(),
        initials,
      },
    });

    return {
      requiresEmailVerification: true,
      email: user.email,
      message: 'We sent a verification code to your email address.',
    };
  }

  async login(dto: LoginDto) {
    const user = await this.db.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (
      !user ||
      user.disabled ||
      !(await verifyPassword(dto.password, user.passwordHash))
    ) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.emailVerified && user.emailVerificationCodeHash) {
      throw new ForbiddenException(
        'Please verify your email before signing in. Enter the code we sent to your email.',
      );
    }

    await this.db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return this.issueSession(user);
  }

  async loginWithGoogle(idToken: string) {
    const decoded =
      await this.identityPlatformService.verifyGoogleIdToken(idToken);
    const email = decoded.email!.trim().toLowerCase();

    let user = await this.db.user.findUnique({
      where: { identityPlatformUid: decoded.uid },
    });

    if (user) {
      if (user.disabled)
        throw new ForbiddenException('This account is disabled.');
      user = await this.db.user.update({
        where: { id: user.id },
        data: {
          emailVerified: true,
          lastLoginAt: new Date(),
        },
      });
      return this.issueSession(user);
    }

    const existingEmailUser = await this.db.user.findUnique({
      where: { email },
    });
    if (existingEmailUser) {
      if (existingEmailUser.disabled) {
        throw new ForbiddenException('This account is disabled.');
      }
      if (
        existingEmailUser.identityPlatformUid &&
        existingEmailUser.identityPlatformUid !== decoded.uid
      ) {
        throw new ConflictException(
          'This email is already linked to a different Google account.',
        );
      }

      // Google has already verified this email. Attach the identity to the
      // existing account and allow SSO to complete its first login.
      user = await this.db.user.update({
        where: { id: existingEmailUser.id },
        data: {
          identityPlatformUid: decoded.uid,
          authProvider: existingEmailUser.passwordHash
            ? 'password+google'
            : 'google',
          emailVerified: true,
          emailVerificationCodeHash: null,
          emailVerificationExpiresAt: null,
          emailVerificationAttempts: 0,
          emailVerificationSentAt: null,
          lastLoginAt: new Date(),
        },
      });
      return this.issueSession(user);
    }

    this.assertRegistrationAllowed(email, 'google');

    const name = decoded.name?.trim() || email.split('@')[0];
    const parts = name.split(/\s+/).filter(Boolean);
    const initials =
      parts.length > 1
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();

    user = await this.db.user.create({
      data: {
        email,
        passwordHash: null,
        identityPlatformUid: decoded.uid,
        authProvider: 'google',
        emailVerified: true,
        lastLoginAt: new Date(),
        name,
        initials,
      },
    });

    return this.issueSession(user);
  }

  async linkGoogle(userId: string, idToken: string) {
    const decoded =
      await this.identityPlatformService.verifyGoogleIdToken(idToken);
    const email = decoded.email!.trim().toLowerCase();
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.disabled)
      throw new ForbiddenException('This account is disabled.');
    if (user.email.toLowerCase() !== email) {
      throw new ForbiddenException(
        'The Google email must match your ReachConvert email.',
      );
    }
    if (user.identityPlatformUid && user.identityPlatformUid !== decoded.uid) {
      throw new ConflictException(
        'A different Google account is already linked.',
      );
    }

    const linkedUser = await this.db.user.findUnique({
      where: { identityPlatformUid: decoded.uid },
    });
    if (linkedUser && linkedUser.id !== userId) {
      throw new ConflictException(
        'This Google account is linked to another user.',
      );
    }

    const updated = await this.db.user.update({
      where: { id: userId },
      data: {
        identityPlatformUid: decoded.uid,
        authProvider: user.passwordHash ? 'password+google' : 'google',
        emailVerified: true,
        lastLoginAt: new Date(),
      },
    });
    return this.issueSession(updated);
  }

  async refresh(refreshToken: string) {
    const payload = this.tokenService.verifyToken(refreshToken, 'refresh');
    const user = await this.db.user.findUnique({ where: { id: payload.sub } });

    if (!user?.refreshTokenHash) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    if (this.tokenService.hashToken(refreshToken) !== user.refreshTokenHash) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return this.issueSession(user);
  }

  async logout(userId: string) {
    await this.db.user.update({
      where: { id: userId },
      data: { refreshTokenHash: null },
    });

    return { success: true };
  }

  async me(userId: string) {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    return this.sanitizeUser(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const data: any = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.email !== undefined
        ? { email: dto.email.trim().toLowerCase() }
        : {}),
      ...(dto.initials !== undefined
        ? { initials: dto.initials.trim().slice(0, 3).toUpperCase() }
        : {}),
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.company !== undefined ? { company: dto.company.trim() } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone.trim() } : {}),
      ...(dto.theme !== undefined ? { theme: dto.theme } : {}),
      ...(dto.accentColor !== undefined
        ? { accentColor: dto.accentColor }
        : {}),
    };

    if (dto.password) {
      data.passwordHash = await hashPassword(dto.password);
      data.refreshTokenHash = null;
    }

    try {
      const user = await this.db.user.update({
        where: { id: userId },
        data,
      });

      return this.sanitizeUser(user);
    } catch {
      throw new BadRequestException(
        'Could not update profile. The email may already be in use.',
      );
    }
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    // Same response whether or not the account exists, so this endpoint
    // cannot be used to discover which emails are registered.
    const user = await this.db.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (!user) return FORGOT_PASSWORD_RESPONSE;

    const token = randomBytes(32).toString('base64url');
    await this.db.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: this.tokenService.hashToken(token),
        passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    try {
      await this.sendPasswordResetEmail(user.email, token);
    } catch (error: any) {
      this.logger.error(
        `Could not send password reset email: ${error?.message || error}`,
      );
    }

    return FORGOT_PASSWORD_RESPONSE;
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.db.user.findUnique({
      where: { passwordResetTokenHash: this.tokenService.hashToken(dto.token) },
    });

    const expiresAt = user?.passwordResetExpiresAt
      ? new Date(user.passwordResetExpiresAt).getTime()
      : 0;
    if (!user || expiresAt < Date.now()) {
      throw new BadRequestException(
        'This reset link is invalid or has expired.',
      );
    }

    await this.db.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(dto.newPassword),
        refreshTokenHash: null,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });

    return { success: true, message: 'Password reset successfully' };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.db.user.findUnique({ where: { email } });
    const expiresAt = user?.emailVerificationExpiresAt
      ? new Date(user.emailVerificationExpiresAt).getTime()
      : 0;
    const attempts = user?.emailVerificationAttempts || 0;

    if (
      !user ||
      !user.passwordHash ||
      user.emailVerified ||
      !user.emailVerificationCodeHash ||
      !expiresAt ||
      expiresAt < Date.now() ||
      attempts >= MAX_EMAIL_VERIFICATION_ATTEMPTS
    ) {
      throw new BadRequestException(
        'This verification code is invalid or has expired. Request a new code.',
      );
    }

    const codeHash = this.tokenService.hashToken(dto.code);
    if (!safeEqual(codeHash, user.emailVerificationCodeHash)) {
      await this.db.user.update({
        where: { id: user.id },
        data: { emailVerificationAttempts: attempts + 1 },
      });
      throw new BadRequestException('The verification code is incorrect.');
    }

    const verifiedUser = await this.db.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationCodeHash: null,
        emailVerificationExpiresAt: null,
        emailVerificationAttempts: 0,
        emailVerificationSentAt: null,
        lastLoginAt: new Date(),
      },
    });

    return this.issueSession(verifiedUser);
  }

  async resendVerification(emailInput: string) {
    const email = emailInput.trim().toLowerCase();
    const user = await this.db.user.findUnique({ where: { email } });
    const genericResponse = {
      success: true,
      message:
        'If this account needs verification, a new code has been sent to its email address.',
    };

    if (!user || !user.passwordHash || user.emailVerified) {
      return genericResponse;
    }

    const sentAt = user.emailVerificationSentAt
      ? new Date(user.emailVerificationSentAt).getTime()
      : 0;
    if (sentAt && Date.now() - sentAt < EMAIL_VERIFICATION_RESEND_DELAY_MS) {
      throw new BadRequestException(
        'Please wait one minute before requesting another verification code.',
      );
    }

    const verificationCode = this.createEmailVerificationCode();
    await this.sendEmailVerificationCode(email, verificationCode);
    const now = new Date();
    await this.db.user.update({
      where: { id: user.id },
      data: {
        emailVerificationCodeHash:
          this.tokenService.hashToken(verificationCode),
        emailVerificationExpiresAt: new Date(
          now.getTime() + EMAIL_VERIFICATION_TTL_MS,
        ),
        emailVerificationAttempts: 0,
        emailVerificationSentAt: now,
      },
    });

    return genericResponse;
  }

  // Data is not partitioned per user — every account sees the whole
  // workspace — so self-service sign-up is closed in production unless
  // ALLOW_REGISTRATION=true or the email is on ALLOWED_SIGNUP_EMAILS.
  private assertRegistrationAllowed(
    email: string,
    provider: 'password' | 'google' = 'password',
  ) {
    const allowlist = (
      this.configService.get<string>('ALLOWED_SIGNUP_EMAILS') || ''
    )
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    if (allowlist.includes(email)) return;

    const flagName =
      provider === 'google' ? 'ALLOW_SSO_REGISTRATION' : 'ALLOW_REGISTRATION';
    const flag = this.configService.get<string>(flagName)?.trim();
    const open = flag ? flag === 'true' : !isProduction();
    if (!open) {
      throw new ForbiddenException(
        'Registration is disabled. Ask an administrator for access.',
      );
    }
  }

  private async sendPasswordResetEmail(email: string, token: string) {
    const appUrl = (
      this.configService.get<string>('PUBLIC_APP_URL') ||
      (isProduction() ? '' : 'http://localhost:3000')
    ).replace(/\/+$/, '');
    if (!appUrl) {
      throw new Error('PUBLIC_APP_URL is not configured.');
    }

    const settings = await this.settingsService.getRawSettings();
    const senderEmail = settings?.awsSenderEmail?.trim();
    if (
      !settings?.awsAccessKeyId ||
      !settings?.awsSecretAccessKey ||
      !senderEmail
    ) {
      throw new Error('AWS SES is not configured in Settings.');
    }

    const link = `${appUrl}/login?resetToken=${encodeURIComponent(token)}`;
    const client = new SESClient({
      region: settings.awsRegion || 'us-east-1',
      credentials: {
        accessKeyId: settings.awsAccessKeyId,
        secretAccessKey: settings.awsSecretAccessKey,
      },
    });
    await client.send(
      new SendEmailCommand({
        Source: `<${senderEmail}>`,
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: 'Reset your ReachConvert password' },
          Body: {
            Text: {
              Data: `Someone asked to reset the password for your ReachConvert account.\n\nOpen this link within 30 minutes to choose a new password:\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
            },
          },
        },
      }),
    );
  }

  private createEmailVerificationCode() {
    return randomInt(100000, 1000000).toString();
  }

  private async sendEmailVerificationCode(email: string, code: string) {
    const settings = await this.settingsService.getRawSettings();
    const accessKeyId =
      settings?.awsAccessKeyId?.trim() || process.env.AWS_KEY_ID?.trim();
    const secretAccessKey =
      settings?.awsSecretAccessKey?.trim() || process.env.AWS_KEY?.trim();
    const senderEmail =
      settings?.awsSenderEmail?.trim() || process.env.AWS_SENDER_EMAIL?.trim();

    if (!accessKeyId || !secretAccessKey || !senderEmail) {
      throw new BadRequestException(
        'Email verification is not configured. Ask an administrator to configure the global SES credentials.',
      );
    }

    try {
      const client = new SESClient({
        region:
          settings?.awsRegion?.trim() || process.env.AWS_REGION || 'us-east-1',
        credentials: { accessKeyId, secretAccessKey },
      });
      await client.send(
        new SendEmailCommand({
          Source: `<${senderEmail}>`,
          Destination: { ToAddresses: [email] },
          Message: {
            Subject: { Data: 'Verify your ReachConvert email' },
            Body: {
              Text: {
                Data: `Your ReachConvert verification code is ${code}.\n\nThis code expires in 10 minutes. If you did not create this account, you can ignore this email.`,
              },
            },
          },
        }),
      );
    } catch (error: any) {
      this.logger.error(
        `Could not send email verification code: ${error?.message || error}`,
      );
      throw new BadRequestException(
        'We could not send the verification email. Please try again later.',
      );
    }
  }

  private async issueSession(user: UserProfile) {
    const accessToken = this.tokenService.signAccessToken(user);
    const refreshToken = this.tokenService.signRefreshToken(user);

    const updatedUser = await this.db.user.update({
      where: { id: user.id },
      data: {
        refreshTokenHash: this.tokenService.hashToken(refreshToken),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: this.sanitizeUser(updatedUser),
    };
  }

  private sanitizeUser(user: UserProfile) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      initials: user.initials,
      title: user.title,
      company: user.company,
      phone: user.phone,
      theme: this.normalizeTheme(user.theme),
      accentColor: this.normalizeAccent(user.accentColor),
      authProvider: user.authProvider || 'password',
      emailVerified: user.emailVerified === true,
    };
  }

  private normalizeTheme(theme?: string) {
    if (theme === 'dark') return 'dark-midnight';
    if (theme === 'light') return 'light-cloud';
    return theme && THEME_VALUES.includes(theme) ? theme : 'system';
  }

  private normalizeAccent(accentColor?: string) {
    return accentColor && ACCENT_VALUES.includes(accentColor)
      ? accentColor
      : 'indigo';
  }
}

type UserProfile = {
  id: string;
  email: string;
  name: string;
  initials: string;
  title: string;
  company: string;
  phone: string;
  theme: string;
  accentColor?: string;
  passwordHash?: string | null;
  identityPlatformUid?: string | null;
  authProvider?: string;
  disabled?: boolean;
  emailVerified?: boolean;
  emailVerificationCodeHash?: string | null;
  emailVerificationExpiresAt?: Date | null;
  emailVerificationAttempts?: number;
  emailVerificationSentAt?: Date | null;
};

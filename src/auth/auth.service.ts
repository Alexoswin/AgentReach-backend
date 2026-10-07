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
import { randomBytes, randomInt, randomUUID } from 'crypto';
import { MongoService } from '../mongo.service';
import { isProduction, safeEqual } from './secrets';
import { hashPassword, verifyPassword } from './password';
import { REFRESH_TOKEN_TTL_SECONDS, TokenService } from './token.service';
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
// Signed-in devices kept per account; signing in on another drops the oldest.
const MAX_SESSIONS_PER_USER = 10;
// Two tabs share one refresh cookie and can refresh at the same moment; the
// one that loses the race may still use the token that was just replaced.
const REFRESH_REUSE_GRACE_MS = 60 * 1000;
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
      const linkedIdentityUid = existingEmailUser.identityPlatformUid?.trim();
      if (linkedIdentityUid && linkedIdentityUid !== decoded.uid) {
        throw new ConflictException(
          'This email is already linked to a different Google account.',
        );
      }

      // A password signup still awaiting its email code never proved it owns
      // this mailbox, so anyone could have chosen that password. Drop it now
      // that Google has proved ownership, or the person who started the
      // signup could sign in to the owner's account with it.
      const unprovenPassword =
        !existingEmailUser.emailVerified &&
        Boolean(existingEmailUser.emailVerificationCodeHash);
      const keepsPassword =
        Boolean(existingEmailUser.passwordHash) && !unprovenPassword;

      // Google has already verified this email. Attach the identity to the
      // existing account and allow SSO to complete its first login.
      user = await this.db.user.update({
        where: { id: existingEmailUser.id },
        data: {
          identityPlatformUid: decoded.uid,
          ...(unprovenPassword ? { passwordHash: null } : {}),
          authProvider: keepsPassword ? 'password+google' : 'google',
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

    if (!user || user.disabled) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    const tokenHash = this.tokenService.hashToken(refreshToken);

    if (!payload.sid) {
      // Issued before per-device sessions existed: accept it once and move
      // it onto its own session.
      if (
        !user.refreshTokenHash ||
        !safeEqual(tokenHash, user.refreshTokenHash)
      ) {
        throw new UnauthorizedException('Refresh token has been revoked');
      }
      await this.db.user.update({
        where: { id: user.id },
        data: { refreshTokenHash: null },
      });
      return this.issueSession(user);
    }

    const session = await this.db.authSession.findUnique({
      where: { id: payload.sid, userId: user.id },
    });
    if (!session) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    // Compare-and-swap on the current hash, so two refreshes of one session
    // cannot both rotate it.
    const nextRefreshToken = this.tokenService.signRefreshToken(
      user,
      session.id,
    );
    const rotated = await this.db.authSession.update({
      where: { id: session.id, refreshTokenHash: tokenHash },
      data: {
        refreshTokenHash: this.tokenService.hashToken(nextRefreshToken),
        previousRefreshTokenHash: tokenHash,
        rotatedAt: new Date(),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });
    if (rotated) {
      return {
        accessToken: this.tokenService.signAccessToken(user, session.id),
        refreshToken: nextRefreshToken,
        user: this.sanitizeUser(user),
      };
    }

    // Another tab rotated this session a moment ago and the browser already
    // holds that new refresh cookie: issue an access token and leave the
    // refresh cookie alone.
    const latest = await this.db.authSession.findUnique({
      where: { id: session.id },
    });
    const rotatedAt = latest?.rotatedAt
      ? new Date(latest.rotatedAt).getTime()
      : 0;
    if (
      latest?.previousRefreshTokenHash &&
      safeEqual(tokenHash, latest.previousRefreshTokenHash) &&
      Date.now() - rotatedAt < REFRESH_REUSE_GRACE_MS
    ) {
      return {
        accessToken: this.tokenService.signAccessToken(user, session.id),
        user: this.sanitizeUser(user),
      };
    }

    // An already-replaced refresh token came back after the grace window:
    // assume it was stolen and end that session.
    await this.db.authSession.delete({ where: { id: session.id } });
    throw new UnauthorizedException('Refresh token has been revoked');
  }

  async logout(userId: string, sessionId?: string) {
    if (sessionId) {
      await this.db.authSession.deleteMany({
        where: { id: sessionId, userId },
      });
    } else {
      await this.db.user.update({
        where: { id: userId },
        data: { refreshTokenHash: null },
      });
    }

    return { success: true };
  }

  async me(userId: string) {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    return this.sanitizeUser(user);
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
    sessionId?: string,
  ) {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    const nextEmail = dto.email?.trim().toLowerCase();
    const emailChanged = nextEmail !== undefined && nextEmail !== user.email;

    // A new password or sign-in email is what someone holding a stolen
    // session would set to keep the account, so both need the current one.
    if (dto.password || emailChanged) {
      if (!user.passwordHash) {
        throw new BadRequestException(
          emailChanged
            ? 'This account signs in with Google, so its email follows your Google account.'
            : 'Use "Forgot password?" on the sign-in page to add a password to this account.',
        );
      }
      if (
        !dto.currentPassword ||
        !(await verifyPassword(dto.currentPassword, user.passwordHash))
      ) {
        throw new BadRequestException(
          'Enter your current password correctly to change your password or email.',
        );
      }
    }

    const data: any = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
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

    if (emailChanged) {
      const taken = await this.db.user.findUnique({
        where: { email: nextEmail },
      });
      if (taken) {
        throw new BadRequestException('That email is already in use.');
      }
      // The new address is unproven until its code is entered (asked for at
      // the next sign-in), and the Google link belonged to the old address.
      const verificationCode = this.createEmailVerificationCode();
      await this.sendEmailVerificationCode(nextEmail, verificationCode);
      const now = new Date();
      Object.assign(data, {
        email: nextEmail,
        emailVerified: false,
        emailVerificationCodeHash: this.tokenService.hashToken(verificationCode),
        emailVerificationExpiresAt: new Date(
          now.getTime() + EMAIL_VERIFICATION_TTL_MS,
        ),
        emailVerificationAttempts: 0,
        emailVerificationSentAt: now,
        identityPlatformUid: null,
        authProvider: 'password',
      });
    }

    let updated: UserProfile;
    try {
      updated = await this.db.user.update({ where: { id: userId }, data });
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new BadRequestException('That email is already in use.');
      }
      throw error;
    }

    if (dto.password || emailChanged) {
      // Sign out every other device; this one stays signed in.
      await this.endSessions(userId, sessionId);
    }

    return this.sanitizeUser(updated);
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
        // The link was opened from this mailbox, which proves the address,
        // so a sign-up still waiting for its code is now verified too.
        emailVerified: true,
        emailVerificationCodeHash: null,
        emailVerificationExpiresAt: null,
        emailVerificationAttempts: 0,
        emailVerificationSentAt: null,
      },
    });
    await this.endSessions(user.id);

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

    const ses = this.platformSes();
    if (!ses) {
      throw new Error(
        'Platform SES is not configured (AWS_KEY_ID, AWS_KEY, AWS_SENDER_EMAIL).',
      );
    }
    const { client, senderEmail } = ses;

    const link = `${appUrl}/login?resetToken=${encodeURIComponent(token)}`;
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

  // Account emails (verification codes, password resets) are sent from the
  // platform's own SES identity, never with a user's Settings credentials.
  private platformSes() {
    const accessKeyId = this.configService.get<string>('AWS_KEY_ID')?.trim();
    const secretAccessKey = this.configService.get<string>('AWS_KEY')?.trim();
    const senderEmail = this.configService
      .get<string>('AWS_SENDER_EMAIL')
      ?.trim();
    if (!accessKeyId || !secretAccessKey || !senderEmail) return null;

    return {
      client: new SESClient({
        region: this.configService.get<string>('AWS_REGION')?.trim() || 'us-east-1',
        credentials: { accessKeyId, secretAccessKey },
      }),
      senderEmail,
    };
  }

  private async sendEmailVerificationCode(email: string, code: string) {
    const ses = this.platformSes();
    if (!ses) {
      throw new BadRequestException(
        'Email verification is not configured. Ask an administrator to configure the platform SES credentials.',
      );
    }
    const { client, senderEmail } = ses;

    try {
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

  // Every sign-in gets its own session, so signing in or out on one device
  // leaves the others alone.
  private async issueSession(user: UserProfile) {
    const sessionId = randomUUID();
    const refreshToken = this.tokenService.signRefreshToken(user, sessionId);

    await this.db.authSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshTokenHash: this.tokenService.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });
    await this.pruneSessions(user.id);

    return {
      accessToken: this.tokenService.signAccessToken(user, sessionId),
      refreshToken,
      user: this.sanitizeUser(user),
    };
  }

  private async pruneSessions(userId: string) {
    const sessions = await this.db.authSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    for (const stale of sessions.slice(MAX_SESSIONS_PER_USER)) {
      await this.db.authSession.delete({ where: { id: stale.id } });
    }
  }

  private async endSessions(userId: string, keepSessionId?: string) {
    const sessions = await this.db.authSession.findMany({ where: { userId } });
    for (const session of sessions) {
      if (session.id !== keepSessionId) {
        await this.db.authSession.delete({ where: { id: session.id } });
      }
    }
    await this.db.user.update({
      where: { id: userId },
      data: { refreshTokenHash: null },
    });
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
  refreshTokenHash?: string | null;
  identityPlatformUid?: string | null;
  authProvider?: string;
  disabled?: boolean;
  emailVerified?: boolean;
  emailVerificationCodeHash?: string | null;
  emailVerificationExpiresAt?: Date | null;
  emailVerificationAttempts?: number;
  emailVerificationSentAt?: Date | null;
};

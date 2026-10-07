import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomBytes } from 'crypto';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import { isProduction } from './secrets';
import { hashPassword, verifyPassword } from './password';
import { TokenService } from './token.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { RegisterDto } from './dto/register.dto';

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
  ) {}

  async register(dto: RegisterDto) {
    this.assertRegistrationAllowed(dto.email.toLowerCase());

    const existing = await this.db.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existing) {
      throw new BadRequestException('User with that email already exists');
    }

    const passwordHash = await hashPassword(dto.password);

    // Auto-generate initials from name
    const parts = dto.name.trim().split(' ');
    const initials =
      parts.length > 1
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : dto.name.slice(0, 2).toUpperCase();

    const user = await this.db.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        name: dto.name.trim(),
        initials,
      },
    });

    return this.issueSession(user);
  }

  async login(dto: LoginDto) {
    const user = await this.db.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user || !(await verifyPassword(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.issueSession(user);
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

  // Data is not partitioned per user — every account sees the whole
  // workspace — so self-service sign-up is closed in production unless
  // ALLOW_REGISTRATION=true or the email is on ALLOWED_SIGNUP_EMAILS.
  private assertRegistrationAllowed(email: string) {
    const allowlist = (
      this.configService.get<string>('ALLOWED_SIGNUP_EMAILS') || ''
    )
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    if (allowlist.includes(email)) return;

    const flag = this.configService.get<string>('ALLOW_REGISTRATION')?.trim();
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
};

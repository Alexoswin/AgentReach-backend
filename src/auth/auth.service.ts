import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { hashPassword, verifyPassword } from './password';
import { TokenService } from './token.service';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class AuthService {
  constructor(
    private db: MongoService,
    private tokenService: TokenService,
  ) {}

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
      ...(dto.email !== undefined ? { email: dto.email.trim().toLowerCase() } : {}),
      ...(dto.initials !== undefined ? { initials: dto.initials.trim().slice(0, 3).toUpperCase() } : {}),
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.company !== undefined ? { company: dto.company.trim() } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone.trim() } : {}),
      ...(dto.theme !== undefined ? { theme: dto.theme } : {}),
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
      throw new BadRequestException('Could not update profile. The email may already be in use.');
    }
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.db.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      throw new BadRequestException('No account found for that email');
    }

    await this.db.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(dto.newPassword),
        refreshTokenHash: null,
      },
    });

    return { success: true, message: 'Password reset successfully' };
  }

  private async issueSession(user: { id: string; email: string; name: string; initials: string; title: string; company: string; phone: string; theme: string }) {
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

  private sanitizeUser(user: { id: string; email: string; name: string; initials: string; title: string; company: string; phone: string; theme: string }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      initials: user.initials,
      title: user.title,
      company: user.company,
      phone: user.phone,
      theme: user.theme,
    };
  }
}

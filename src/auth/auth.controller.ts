import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  Res,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { Public } from './public.decorator';
import { IdentityPlatformDto } from './dto/identity-platform.dto';
import {
  clearSessionCookies,
  readCookie,
  REFRESH_COOKIE_NAME,
  setSessionCookies,
} from './session.cookies';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('register')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Register a new account' })
  register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.writeSession(response, this.authService.register(dto));
  }

  @Public()
  @Post('login')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Login and receive a secure session cookie' })
  login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
    return this.writeSession(response, this.authService.login(dto));
  }

  @Public()
  @Post('identity-platform')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({
    summary: 'Exchange a verified Google Identity Platform token for a session',
  })
  identityPlatform(
    @Body() dto: IdentityPlatformDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.writeSession(
      response,
      this.authService.loginWithGoogle(dto.idToken),
    );
  }

  @Public()
  @Post('refresh')
  @ApiOperation({
    summary: 'Rotate the secure refresh session cookie',
  })
  refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = readCookie(request, REFRESH_COOKIE_NAME);
    if (!refreshToken) {
      return this.authService.refresh('');
    }
    return this.writeSession(response, this.authService.refresh(refreshToken));
  }

  @Public()
  @Post('forgot-password')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Email a one-time password reset link' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @Post('reset-password')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Set a new password using a reset link token' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  me(@Req() request: any) {
    return this.authService.me(request.user.id);
  }

  @Patch('profile')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update current user profile' })
  updateProfile(@Req() request: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(request.user.id, dto);
  }

  @Post('logout')
  @ApiOperation({ summary: 'Revoke current refresh token' })
  logout(@Req() request: any, @Res({ passthrough: true }) response: Response) {
    clearSessionCookies(response);
    return this.authService.logout(request.user.id);
  }

  @Post('link-google')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({
    summary: 'Link the matching Google identity to the current account',
  })
  linkGoogle(
    @Req() request: any,
    @Body() dto: IdentityPlatformDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.writeSession(
      response,
      this.authService.linkGoogle(request.user.id, dto.idToken),
    );
  }

  private async writeSession(
    response: Response,
    sessionPromise: Promise<{
      accessToken: string;
      refreshToken: string;
      user: Record<string, unknown>;
    }>,
  ) {
    const session = await sessionPromise;
    return setSessionCookies(response, session);
  }
}

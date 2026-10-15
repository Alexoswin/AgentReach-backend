import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SettingsModule } from '../settings/settings.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { CognitoAuthService } from './cognito-auth.service';

@Module({
  imports: [SettingsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    CognitoAuthService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}

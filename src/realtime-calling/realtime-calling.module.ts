import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { SettingsModule } from '../settings/settings.module';
import { GeminiLiveAuthService } from './gemini-live-auth.service';
import { RealtimeCallingGateway } from './realtime-calling.gateway';

@Module({
  imports: [BotModule, SettingsModule],
  providers: [RealtimeCallingGateway, GeminiLiveAuthService],
  exports: [RealtimeCallingGateway],
})
export class RealtimeCallingModule {}

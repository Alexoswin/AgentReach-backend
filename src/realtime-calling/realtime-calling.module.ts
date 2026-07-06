import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { SettingsModule } from '../settings/settings.module';
import { GeminiLiveAuthService } from './gemini-live-auth.service';
import { RealtimeCallingGateway } from './realtime-calling.gateway';
import { CallMonitorHub } from './call-monitor.hub';

@Module({
  imports: [BotModule, SettingsModule],
  providers: [RealtimeCallingGateway, GeminiLiveAuthService, CallMonitorHub],
  exports: [RealtimeCallingGateway, CallMonitorHub],
})
export class RealtimeCallingModule {}

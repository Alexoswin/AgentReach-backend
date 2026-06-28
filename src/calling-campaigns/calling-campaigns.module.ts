import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotModule } from '../bot/bot.module';
import { SettingsModule } from '../settings/settings.module';
import { CallingCampaignsController } from './calling-campaigns.controller';
import { CallingCampaignsService } from './calling-campaigns.service';

@Module({
  imports: [BotModule, SettingsModule, ConfigModule],
  controllers: [CallingCampaignsController],
  providers: [CallingCampaignsService],
  exports: [CallingCampaignsService],
})
export class CallingCampaignsModule {}

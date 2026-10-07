import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { EmailCampaignsService } from './email-campaigns.service';
import { EmailCampaignsController } from './email-campaigns.controller';

@Module({
  imports: [SettingsModule],
  controllers: [EmailCampaignsController],
  providers: [EmailCampaignsService],
  exports: [EmailCampaignsService],
})
export class EmailCampaignsModule {}

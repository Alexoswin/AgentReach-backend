import { Module } from '@nestjs/common';
import { EmailCampaignsModule } from '../email-campaigns/email-campaigns.module';
import { CallingCampaignsModule } from '../calling-campaigns/calling-campaigns.module';
import { CampaignSchedulerService } from './campaign-scheduler.service';

// ScheduleModule.forRoot() is registered once in SignalsModule; its explorer
// discovers the @Cron handler in CampaignSchedulerService app-wide.
@Module({
  imports: [EmailCampaignsModule, CallingCampaignsModule],
  providers: [CampaignSchedulerService],
})
export class CampaignSchedulerModule {}

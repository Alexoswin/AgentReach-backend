import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EmailCampaignsService } from '../email-campaigns/email-campaigns.service';
import { CallingCampaignsService } from '../calling-campaigns/calling-campaigns.service';

/**
 * Polls once a minute for campaigns whose scheduled launch time has arrived and
 * launches them. Campaigns are marked SCHEDULED via the `/:id/schedule`
 * endpoints; launching flips their status to RUNNING so they are not picked up
 * again. Failures are logged and the campaign is marked FAILED so a stuck
 * SCHEDULED row is not retried forever.
 */
@Injectable()
export class CampaignSchedulerService {
  private readonly logger = new Logger(CampaignSchedulerService.name);

  constructor(
    private readonly emailCampaigns: EmailCampaignsService,
    private readonly callingCampaigns: CallingCampaignsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async runDueCampaigns() {
    await this.runDueEmailCampaigns();
    await this.runDueCallingCampaigns();
  }

  private async runDueEmailCampaigns() {
    let due: any[] = [];
    try {
      due = await this.emailCampaigns.findDueScheduled();
    } catch (err) {
      this.logger.warn(
        `Failed to query due email campaigns: ${(err as Error).message}`,
      );
      return;
    }

    for (const campaign of due) {
      try {
        this.logger.log(`Launching scheduled email campaign ${campaign.id}`);
        await this.emailCampaigns.launchCampaign(campaign.id);
      } catch (err) {
        this.logger.error(
          `Scheduled email campaign ${campaign.id} failed to launch: ${(err as Error).message}`,
        );
        await this.emailCampaigns
          .unscheduleCampaign(campaign.id)
          .catch(() => undefined);
      }
    }
  }

  private async runDueCallingCampaigns() {
    let due: any[] = [];
    try {
      due = await this.callingCampaigns.findDueScheduled();
    } catch (err) {
      this.logger.warn(
        `Failed to query due calling campaigns: ${(err as Error).message}`,
      );
      return;
    }

    for (const campaign of due) {
      try {
        this.logger.log(`Launching scheduled calling campaign ${campaign.id}`);
        await this.callingCampaigns.launchCampaign(campaign.id);
      } catch (err) {
        this.logger.error(
          `Scheduled calling campaign ${campaign.id} failed to launch: ${(err as Error).message}`,
        );
        await this.callingCampaigns
          .unscheduleCampaign(campaign.id)
          .catch(() => undefined);
      }
    }
  }
}

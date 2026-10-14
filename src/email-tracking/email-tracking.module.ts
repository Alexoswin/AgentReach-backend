import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { MailboxModule } from '../mailbox/mailbox.module';
import { EmailTrackingConfig } from './email-tracking.config';
import { EmailTrackingController } from './email-tracking.controller';
import { EmailTrackingService } from './email-tracking.service';

@Module({
  imports: [SettingsModule, MailboxModule],
  controllers: [EmailTrackingController],
  providers: [EmailTrackingService, EmailTrackingConfig],
  exports: [EmailTrackingConfig],
})
export class EmailTrackingModule {}

import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { EmailTrackingConfig } from '../email-tracking/email-tracking.config';
import { MailboxController } from './mailbox.controller';
import { MailboxService } from './mailbox.service';
import { MailAttachmentsService } from './mail-attachments.service';
import { MailIngestService } from './mail-ingest.service';
import { MailQueueService } from './mail-queue.service';
import { MailSendersService } from './mail-senders.service';
import { MailStoreService } from './mail-store.service';

// EmailTrackingConfig is provided here as well as in EmailTrackingModule:
// that module needs this one for incoming replies, so importing it back
// would be circular. The config is stateless, so two instances are fine.
@Module({
  imports: [SettingsModule],
  controllers: [MailboxController],
  providers: [
    MailboxService,
    MailAttachmentsService,
    MailIngestService,
    MailQueueService,
    MailSendersService,
    MailStoreService,
    EmailTrackingConfig,
  ],
  exports: [
    MailAttachmentsService,
    MailIngestService,
    MailQueueService,
    MailSendersService,
    MailStoreService,
  ],
})
export class MailboxModule {}

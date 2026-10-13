import { Module } from '@nestjs/common';
import { MailServiceClient } from './mail-service.client';

@Module({
  providers: [MailServiceClient],
  exports: [MailServiceClient],
})
export class MailServiceModule {}

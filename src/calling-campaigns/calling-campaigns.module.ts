import { Module } from '@nestjs/common';
import { CallingCampaignsService } from './calling-campaigns.service';
import { CallingCampaignsController } from './calling-campaigns.controller';

@Module({
  controllers: [CallingCampaignsController],
  providers: [CallingCampaignsService],
  exports: [CallingCampaignsService],
})
export class CallingCampaignsModule {}

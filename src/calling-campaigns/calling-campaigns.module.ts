import { Module } from '@nestjs/common';
import { CallingCampaignsService } from './calling-campaigns.service';
import { CallingCampaignsController } from './calling-campaigns.controller';
import { AiCallingBotsModule } from '../ai-calling-bots/ai-calling-bots.module';

@Module({
  imports: [AiCallingBotsModule],
  controllers: [CallingCampaignsController],
  providers: [CallingCampaignsService],
  exports: [CallingCampaignsService],
})
export class CallingCampaignsModule {}

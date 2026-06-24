import { Module } from '@nestjs/common';
import { CallingCampaignsService } from './calling-campaigns.service';
import { CallingCampaignsController } from './calling-campaigns.controller';
import { AiCallingBotsModule } from '../ai-calling-bots/ai-calling-bots.module';
import { GeminiLiveService } from '../ai-calling/gemini-live.service';

@Module({
  imports: [AiCallingBotsModule],
  controllers: [CallingCampaignsController],
  providers: [CallingCampaignsService, GeminiLiveService],
  exports: [CallingCampaignsService],
})
export class CallingCampaignsModule {}

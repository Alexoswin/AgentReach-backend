import { Module } from '@nestjs/common';
import { AiCallingBotsController } from './ai-calling-bots.controller';
import { AiCallingBotsService } from './ai-calling-bots.service';

@Module({
  controllers: [AiCallingBotsController],
  providers: [AiCallingBotsService],
  exports: [AiCallingBotsService],
})
export class AiCallingBotsModule {}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiCallingBotsService } from './ai-calling-bots.service';
import { CreateAiCallingBotDto } from './dto/create-ai-calling-bot.dto';
import { SearchAiCallingBotDto } from './dto/search-ai-calling-bot.dto';
import { TrainAiCallingBotDto } from './dto/train-ai-calling-bot.dto';

@ApiTags('ai-calling-bots')
@Controller('ai-calling-bots')
export class AiCallingBotsController {
  constructor(private readonly aiCallingBotsService: AiCallingBotsService) {}

  @Get('voices/google')
  @ApiOperation({ summary: 'Get Google-only AI calling voice profiles' })
  getGoogleVoices() {
    return this.aiCallingBotsService.getGoogleVoiceProfiles();
  }

  @Get()
  @ApiOperation({ summary: 'Get AI calling bots' })
  findAll() {
    return this.aiCallingBotsService.findAll();
  }

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Create an AI calling bot' })
  create(@Body() dto: CreateAiCallingBotDto) {
    return this.aiCallingBotsService.create(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an AI calling bot' })
  findOne(@Param('id') id: string) {
    return this.aiCallingBotsService.findOne(id);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update an AI calling bot' })
  update(@Param('id') id: string, @Body() dto: Partial<CreateAiCallingBotDto>) {
    return this.aiCallingBotsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an AI calling bot and its embeddings' })
  remove(@Param('id') id: string) {
    return this.aiCallingBotsService.remove(id);
  }

  @Post(':id/train')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Train an AI calling bot with RAG embeddings' })
  train(@Param('id') id: string, @Body() dto: TrainAiCallingBotDto) {
    return this.aiCallingBotsService.train(id, dto);
  }

  @Post(':id/search')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Search an AI calling bot knowledge base' })
  search(@Param('id') id: string, @Body() dto: SearchAiCallingBotDto) {
    return this.aiCallingBotsService.search(id, dto);
  }
}

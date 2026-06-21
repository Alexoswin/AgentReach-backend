import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiCallingBotsService } from './ai-calling-bots.service';
import { CreateAiCallingBotDto } from './dto/create-ai-calling-bot.dto';
import { SearchAiCallingBotDto } from './dto/search-ai-calling-bot.dto';
import { TrainAiCallingBotDto } from './dto/train-ai-calling-bot.dto';
import { TrainAiCallingBotPdfDto } from './dto/train-ai-calling-bot-pdf.dto';
import { ChatAiCallingBotDto } from './dto/chat-ai-calling-bot.dto';

const MAX_TRAINING_PDF_BYTES = 8 * 1024 * 1024;

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

  @Post(':id/train-pdf')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_TRAINING_PDF_BYTES },
      fileFilter: (_req, file, cb) => {
        const isPdf =
          file.mimetype === 'application/pdf' ||
          file.originalname?.toLowerCase().endsWith('.pdf');
        if (!isPdf) {
          cb(new BadRequestException('Training file must be a PDF'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Train an AI calling bot from a PDF file' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
        replace: { type: 'string', example: 'true' },
        chunkSize: { type: 'string', example: '900' },
        chunkOverlap: { type: 'string', example: '120' },
        sourceName: { type: 'string', example: 'product-playbook.pdf' },
      },
      required: ['file'],
    },
  })
  trainPdf(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: TrainAiCallingBotPdfDto,
  ) {
    return this.aiCallingBotsService.trainFromPdf(id, file, dto);
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

  @Post(':id/chat')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Chat with an AI calling bot using trained context' })
  chat(@Param('id') id: string, @Body() dto: ChatAiCallingBotDto) {
    return this.aiCallingBotsService.chat(id, dto);
  }
}

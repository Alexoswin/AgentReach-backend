import {
  BadRequestException,
  Body,
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
import { BotService } from './bot.service';
import { CreateBotDto } from './dto/create-bot.dto';
import { SearchBotDto } from './dto/search-bot.dto';

const MAX_TRAINING_PDF_BYTES = 8 * 1024 * 1024;

@ApiTags('ai-calling-bots')
@Controller('ai-calling-bots')
export class BotController {
  constructor(private readonly botService: BotService) {}

  @Get('voices/google')
  @ApiOperation({ summary: 'Get Google Gemini Live voice profiles' })
  getGoogleVoices() {
    return this.botService.getGoogleVoiceProfiles();
  }

  @Get()
  @ApiOperation({ summary: 'Get AI calling bots' })
  findAll() {
    return this.botService.findAll();
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('knowledgeBasePdf', {
      limits: { fileSize: MAX_TRAINING_PDF_BYTES },
      fileFilter: (_req, file, cb) => {
        const isPdf =
          file.mimetype === 'application/pdf' ||
          file.originalname?.toLowerCase().endsWith('.pdf');
        cb(
          isPdf ? null : new BadRequestException('Knowledge base file must be a PDF'),
          isPdf,
        );
      },
    }),
  )
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create a Gemini Live calling bot' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        personality: { type: 'string' },
        botObjective: { type: 'string' },
        botGoal: { type: 'string' },
        botFlow: { type: 'string' },
        knowledgeBaseText: { type: 'string' },
        contextOutsideKnowledgeBase: { type: 'string' },
        ragEnabled: { type: 'string' },
        knowledgeBasePdf: { type: 'string', format: 'binary' },
      },
      required: ['name'],
    },
  })
  create(
    @Body() dto: CreateBotDto,
    @UploadedFile() knowledgeBasePdf?: Express.Multer.File,
  ) {
    return this.botService.create(dto, knowledgeBasePdf);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an AI calling bot' })
  findOne(@Param('id') id: string) {
    return this.botService.findOne(id);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @ApiOperation({ summary: 'Update an AI calling bot' })
  update(@Param('id') id: string, @Body() dto: Partial<CreateBotDto>) {
    return this.botService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an AI calling bot and embeddings' })
  remove(@Param('id') id: string) {
    return this.botService.remove(id);
  }

  @Post(':id/search')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @ApiOperation({ summary: 'Search bot knowledge base' })
  search(@Param('id') id: string, @Body() dto: SearchBotDto) {
    return this.botService.search(id, dto);
  }
}

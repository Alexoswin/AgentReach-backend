import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { GenerateTemplateDto } from './dto/generate-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';

@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all saved templates' })
  async findAll() {
    return this.templatesService.findAll();
  }

  @Get('predefined')
  @ApiOperation({
    summary: 'Get list of predefined templates across categories',
  })
  getPredefinedTemplates() {
    return this.templatesService.getPredefinedTemplates();
  }

  @Post('generate')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({
    summary: 'Generate a personalized template using Gemini AI',
  })
  async generateTemplate(
    @Req() request: any,
    @Body() dto: GenerateTemplateDto,
  ) {
    return this.templatesService.generateAiTemplate(dto, request.user.id);
  }

  @Post('generate-jobs')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Start AI template generation as a pollable job' })
  async startGenerateTemplate(
    @Req() request: any,
    @Body() dto: GenerateTemplateDto,
  ) {
    return this.templatesService.startAiTemplateGeneration(
      dto,
      request.user.id,
    );
  }

  @Get('generate-jobs/:id')
  @ApiOperation({ summary: 'Get AI template generation job status' })
  async getGenerateTemplateStatus(
    @Req() request: any,
    @Param('id') id: string,
  ) {
    return this.templatesService.getAiTemplateGenerationStatus(
      id,
      request.user.id,
    );
  }

  @Post('reference-pdf')
  // Stop oversized uploads while streaming instead of buffering them first.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Extract text from a PDF reference file for AI template generation',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async parseReferencePdf(@UploadedFile() file: Express.Multer.File) {
    return this.templatesService.parseReferencePdf(file);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a template by ID' })
  async findOne(@Param('id') id: string) {
    return this.templatesService.findOne(id);
  }

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Save a new template' })
  async create(@Body() dto: CreateTemplateDto) {
    return this.templatesService.create(dto);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update a template' })
  async update(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.templatesService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a template' })
  async remove(@Param('id') id: string) {
    return this.templatesService.remove(id);
  }
}

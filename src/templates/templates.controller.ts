import { Controller, Get, Post, Patch, Delete, Body, Param, UsePipes, ValidationPipe } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { GenerateTemplateDto } from './dto/generate-template.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

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
  @ApiOperation({ summary: 'Get list of predefined templates across categories' })
  getPredefinedTemplates() {
    return this.templatesService.getPredefinedTemplates();
  }

  @Post('generate')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Generate a personalized template using OpenRouter AI' })
  async generateTemplate(@Body() dto: GenerateTemplateDto) {
    return this.templatesService.generateAiTemplate(dto);
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
  async update(@Param('id') id: string, @Body() dto: Partial<CreateTemplateDto>) {
    return this.templatesService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a template' })
  async remove(@Param('id') id: string) {
    return this.templatesService.remove(id);
  }
}

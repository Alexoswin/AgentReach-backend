import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CallingCampaignsService } from './calling-campaigns.service';
import { CreateCallingCampaignDto } from './dto/create-calling-campaign.dto';
import { GenerateCallingCampaignDto } from './dto/generate-calling-campaign.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('calling-campaigns')
@Controller('calling-campaigns')
export class CallingCampaignsController {
  constructor(
    private readonly callingCampaignsService: CallingCampaignsService,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get AI Calling dashboard metrics' })
  async getDashboardMetrics() {
    return this.callingCampaignsService.getDashboardMetrics();
  }

  @Get()
  @ApiOperation({ summary: 'Get all AI calling campaigns' })
  async findAll() {
    return this.callingCampaignsService.findAll();
  }

  @Post('generate')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Generate an AI calling campaign from a prompt' })
  async generate(@Body() dto: GenerateCallingCampaignDto) {
    return this.callingCampaignsService.generateCampaign(dto);
  }

  @Post('generate-jobs')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({
    summary: 'Start AI calling campaign generation from a prompt',
  })
  async startGenerate(@Body() dto: GenerateCallingCampaignDto) {
    return this.callingCampaignsService.startCampaignGeneration(dto);
  }

  @Get('generate-jobs/:id')
  @ApiOperation({ summary: 'Get AI calling campaign generation status' })
  async generationStatus(@Param('id') id: string) {
    return this.callingCampaignsService.getCampaignGenerationStatus(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details of an AI calling campaign' })
  async findOne(@Param('id') id: string) {
    return this.callingCampaignsService.findOne(id);
  }

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Create a new AI calling campaign' })
  async create(@Body() dto: CreateCallingCampaignDto) {
    return this.callingCampaignsService.create(dto);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update an AI calling campaign' })
  async update(
    @Param('id') id: string,
    @Body() dto: Partial<CreateCallingCampaignDto> & { status?: string },
  ) {
    return this.callingCampaignsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an AI calling campaign' })
  async remove(@Param('id') id: string) {
    return this.callingCampaignsService.remove(id);
  }

  @Post(':id/launch')
  @ApiOperation({ summary: 'Launch AI calling campaign simulation' })
  async launchCampaign(@Param('id') id: string) {
    return this.callingCampaignsService.launchCampaign(id);
  }
}

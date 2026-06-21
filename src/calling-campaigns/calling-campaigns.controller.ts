import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Header,
  Query,
  HttpCode,
  StreamableFile,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CallingCampaignsService } from './calling-campaigns.service';
import { CreateCallingCampaignDto } from './dto/create-calling-campaign.dto';
import { GenerateCallingCampaignDto } from './dto/generate-calling-campaign.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

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

  @Post('twilio/answer/:callId')
  @Public()
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'Twilio AI calling answer webhook' })
  async twilioAnswer(@Param('callId') callId: string, @Body() body: any) {
    return this.callingCampaignsService.handleTwilioAnswer(callId, body);
  }

  @Get('twilio/answer/:callId')
  @Public()
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'Twilio AI calling answer webhook (GET fallback)' })
  async twilioAnswerGet(@Param('callId') callId: string, @Query() query: any) {
    return this.callingCampaignsService.handleTwilioAnswer(callId, query);
  }

  @Post('twilio/respond/:callId')
  @Public()
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'Twilio AI calling speech response webhook' })
  async twilioRespond(@Param('callId') callId: string, @Body() body: any) {
    return this.callingCampaignsService.handleTwilioResponse(callId, body);
  }

  @Get('twilio/respond/:callId')
  @Public()
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'Twilio AI calling speech response webhook (GET fallback)' })
  async twilioRespondGet(@Param('callId') callId: string, @Query() query: any) {
    return this.callingCampaignsService.handleTwilioResponse(callId, query);
  }

  @Post('twilio/status/:callId')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Twilio AI calling status webhook' })
  async twilioStatus(@Param('callId') callId: string, @Body() body: any) {
    return this.callingCampaignsService.handleTwilioStatus(callId, body);
  }

  @Get('twilio/status/:callId')
  @Public()
  @ApiOperation({ summary: 'Twilio AI calling status webhook (GET fallback)' })
  async twilioStatusGet(@Param('callId') callId: string, @Query() query: any) {
    return this.callingCampaignsService.handleTwilioStatus(callId, query);
  }

  @Post('twilio/recording/:callId')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Twilio AI calling recording webhook' })
  async twilioRecording(@Param('callId') callId: string, @Body() body: any) {
    return this.callingCampaignsService.handleTwilioRecording(callId, body);
  }

  @Get('twilio/recording/:callId')
  @Public()
  @ApiOperation({ summary: 'Twilio AI calling recording webhook (GET fallback)' })
  async twilioRecordingGet(@Param('callId') callId: string, @Query() query: any) {
    return this.callingCampaignsService.handleTwilioRecording(callId, query);
  }

  @Get('twilio/tts/:audioId')
  @Public()
  @Header('Content-Type', 'audio/mpeg')
  @ApiOperation({ summary: 'Google TTS audio for Twilio AI calling' })
  async twilioTts(@Param('audioId') audioId: string) {
    const audio =
      await this.callingCampaignsService.renderGoogleSpeechAudio(audioId);
    return new StreamableFile(audio, {
      type: 'audio/mpeg',
      disposition: 'inline',
      length: audio.length,
    });
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
  @ApiOperation({ summary: 'Launch AI calling campaign (Twilio or simulation)' })
  async launchCampaign(@Param('id') id: string) {
    return this.callingCampaignsService.launchCampaign(id);
  }

  @Post(':id/relaunch')
  @ApiOperation({
    summary:
      'Relaunch AI calling campaign from the beginning (resets prior call outcomes)',
  })
  async relaunchCampaign(@Param('id') id: string) {
    return this.callingCampaignsService.relaunchCampaign(id);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { CallingCampaignsService } from './calling-campaigns.service';
import { CreateCallingCampaignDto } from './dto/create-calling-campaign.dto';
import { GenerateCallingCampaignDto } from './dto/generate-calling-campaign.dto';

@ApiTags('calling-campaigns')
@Controller('calling-campaigns')
export class CallingCampaignsController {
  constructor(private readonly service: CallingCampaignsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get AI calling dashboard metrics' })
  getDashboardMetrics() {
    return this.service.getDashboardMetrics();
  }

  @Post('generate')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Generate an AI calling campaign draft' })
  generate(@Body() dto: GenerateCallingCampaignDto) {
    return this.service.generateCampaign(dto);
  }

  @Post('generate-jobs')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Start AI calling campaign generation' })
  startGenerate(@Body() dto: GenerateCallingCampaignDto) {
    return this.service.startGenerate(dto);
  }

  @Get('generate-jobs/:id')
  @ApiOperation({ summary: 'Get AI calling campaign generation status' })
  generationStatus(@Param('id') id: string) {
    return this.service.generationStatus(id);
  }

  @Get()
  @ApiOperation({ summary: 'Get all AI calling campaigns' })
  findAll() {
    return this.service.findAll();
  }

  @Post('twilio/answer/:callId')
  @Public()
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'Twilio streaming answer webhook' })
  twilioAnswer(@Param('callId') callId: string, @Body() body: any) {
    return this.service.handleTwilioAnswer(callId, body);
  }

  @Get('twilio/answer/:callId')
  @Public()
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'Twilio streaming answer webhook fallback' })
  twilioAnswerGet(@Param('callId') callId: string, @Query() query: any) {
    return this.service.handleTwilioAnswer(callId, query);
  }

  @Post('twilio/respond/:callId')
  @Public()
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'Legacy Twilio respond compatibility no-op' })
  twilioRespond(@Param('callId') callId: string, @Body() body: any) {
    return this.service.handleTwilioResponse(callId, body);
  }

  @Get('twilio/respond/:callId')
  @Public()
  @Header('Content-Type', 'text/xml')
  @ApiOperation({ summary: 'Legacy Twilio respond compatibility no-op' })
  twilioRespondGet(@Param('callId') callId: string, @Query() query: any) {
    return this.service.handleTwilioResponse(callId, query);
  }

  @Post('twilio/status/:callId')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Twilio status callback' })
  twilioStatus(@Param('callId') callId: string, @Body() body: any) {
    return this.service.handleTwilioStatus(callId, body);
  }

  @Get('twilio/status/:callId')
  @Public()
  @ApiOperation({ summary: 'Twilio status callback fallback' })
  twilioStatusGet(@Param('callId') callId: string, @Query() query: any) {
    return this.service.handleTwilioStatus(callId, query);
  }

  @Post('twilio/recording/:callId')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Twilio recording callback' })
  twilioRecording(@Param('callId') callId: string, @Body() body: any) {
    return this.service.handleTwilioRecording(callId, body);
  }

  @Get('twilio/recording/:callId')
  @Public()
  @ApiOperation({ summary: 'Twilio recording callback fallback' })
  twilioRecordingGet(@Param('callId') callId: string, @Query() query: any) {
    return this.service.handleTwilioRecording(callId, query);
  }

  @Get('recordings/:callId/audio')
  @ApiOperation({ summary: 'Get proxied AI call recording audio' })
  async recordingAudio(
    @Param('callId') callId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const recording = await this.service.getCallRecordingAudio(callId);
    res.setHeader('Content-Type', recording.contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${recording.filename}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    return new StreamableFile(recording.buffer);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an AI calling campaign' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @ApiOperation({ summary: 'Create a new AI calling campaign' })
  create(@Body() dto: CreateCallingCampaignDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @ApiOperation({ summary: 'Update an AI calling campaign' })
  update(
    @Param('id') id: string,
    @Body() dto: Partial<CreateCallingCampaignDto> & { status?: string },
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an AI calling campaign' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/launch')
  @ApiOperation({ summary: 'Launch AI calling campaign' })
  launch(@Param('id') id: string) {
    return this.service.launchCampaign(id);
  }

  @Post(':id/relaunch')
  @ApiOperation({ summary: 'Relaunch AI calling campaign' })
  relaunch(@Param('id') id: string) {
    return this.service.relaunchCampaign(id);
  }

  @Post(':id/stop')
  @ApiOperation({ summary: 'Stop AI calling campaign' })
  stop(@Param('id') id: string) {
    return this.service.stopCampaign(id);
  }
}

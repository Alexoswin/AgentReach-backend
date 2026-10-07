import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get current settings' })
  @ApiResponse({ status: 200, description: 'Settings returned successfully.' })
  async getSettings(@Req() request: any) {
    return this.settingsService.getSettings(request.user.id);
  }

  @Patch()
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update system settings' })
  @ApiResponse({ status: 200, description: 'Settings updated successfully.' })
  async updateSettings(@Req() request: any, @Body() dto: UpdateSettingsDto) {
    return this.settingsService.updateSettings(request.user.id, dto);
  }

  @Post('test-ses')
  @ApiOperation({ summary: 'Test AWS SES connection' })
  async testAwsSes(@Req() request: any) {
    return this.settingsService.testAwsSes(request.user.id);
  }

  @Post('test-twilio')
  @ApiOperation({ summary: 'Test Twilio connection' })
  async testTwilio(@Req() request: any) {
    return this.settingsService.testTwilio(request.user.id);
  }

  @Post('test-plivo')
  @ApiOperation({ summary: 'Test Plivo connection' })
  async testPlivo(@Req() request: any) {
    return this.settingsService.testPlivo(request.user.id);
  }

  @Post('test-gemini')
  @ApiOperation({ summary: 'Test Gemini API key connection' })
  async testGemini(
    @Req() request: any,
    @Body() body?: { geminiApiKey?: string },
  ) {
    return this.settingsService.testGemini(request.user.id, body || {});
  }

  @Post('preview-gemini-voice')
  @ApiOperation({ summary: 'Generate a short Google voice preview' })
  async previewGeminiVoice(
    @Req() request: any,
    @Body() dto: { voice: string; language?: string; text?: string },
  ) {
    return this.settingsService.previewGeminiVoice(request.user.id, dto);
  }
}

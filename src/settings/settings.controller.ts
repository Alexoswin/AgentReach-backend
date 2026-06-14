import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
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
  async getSettings() {
    return this.settingsService.getSettings();
  }

  @Patch()
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update system settings' })
  @ApiResponse({ status: 200, description: 'Settings updated successfully.' })
  async updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.settingsService.updateSettings(dto);
  }

  @Post('test-ses')
  @ApiOperation({ summary: 'Test AWS SES connection' })
  async testAwsSes() {
    return this.settingsService.testAwsSes();
  }

  @Post('test-openrouter')
  @ApiOperation({ summary: 'Test OpenRouter connection' })
  async testOpenRouter() {
    return this.settingsService.testOpenRouter();
  }
}

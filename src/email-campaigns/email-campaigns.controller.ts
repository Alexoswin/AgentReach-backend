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
import { EmailCampaignsService } from './email-campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { AddContactsDto } from './dto/add-contacts.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('email-campaigns')
@Controller('email-campaigns')
export class EmailCampaignsController {
  constructor(private readonly emailCampaignsService: EmailCampaignsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all email campaigns' })
  async findAll() {
    return this.emailCampaignsService.findAll();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get details of a campaign (including contacts and templates)',
  })
  async findOne(@Param('id') id: string) {
    return this.emailCampaignsService.findOne(id);
  }

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Create a new campaign' })
  async create(@Body() dto: CreateCampaignDto) {
    return this.emailCampaignsService.create(dto);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update campaign properties' })
  async update(@Param('id') id: string, @Body() dto: UpdateCampaignDto) {
    return this.emailCampaignsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a campaign' })
  async remove(@Param('id') id: string) {
    return this.emailCampaignsService.remove(id);
  }

  @Post(':id/contacts')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Add a list of contacts to a campaign' })
  async addContacts(@Param('id') id: string, @Body() dto: AddContactsDto) {
    return this.emailCampaignsService.addContacts(id, dto);
  }

  @Delete(':id/contacts/:contactId')
  @ApiOperation({ summary: 'Remove a contact from a campaign' })
  async removeContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
  ) {
    return this.emailCampaignsService.removeContact(id, contactId);
  }

  @Post(':id/launch')
  @ApiOperation({ summary: 'Launch the email campaign' })
  async launchCampaign(@Param('id') id: string) {
    return this.emailCampaignsService.launchCampaign(id);
  }

  @Post(':id/relaunch')
  @ApiOperation({
    summary:
      'Re-send the campaign to every recipient, including those already sent',
  })
  async relaunchCampaign(@Param('id') id: string) {
    return this.emailCampaignsService.relaunchCampaign(id);
  }

  @Post(':id/schedule')
  @ApiOperation({ summary: 'Schedule the email campaign for a future time' })
  async schedule(
    @Param('id') id: string,
    @Body() body: { scheduledAt: string },
  ) {
    return this.emailCampaignsService.scheduleCampaign(id, body.scheduledAt);
  }

  @Post(':id/unschedule')
  @ApiOperation({ summary: 'Cancel a scheduled email campaign' })
  async unschedule(@Param('id') id: string) {
    return this.emailCampaignsService.unscheduleCampaign(id);
  }
}

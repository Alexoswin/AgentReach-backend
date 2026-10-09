import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
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
  async findAll(@Req() request: any) {
    return this.emailCampaignsService.findAll(request.user.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get details of a campaign (including contacts and templates)',
  })
  async findOne(@Req() request: any, @Param('id') id: string) {
    return this.emailCampaignsService.findOne(id, request.user.id);
  }

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Create a new campaign' })
  async create(@Req() request: any, @Body() dto: CreateCampaignDto) {
    return this.emailCampaignsService.create(dto, request.user.id);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update campaign properties' })
  async update(
    @Req() request: any,
    @Param('id') id: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.emailCampaignsService.update(id, dto, request.user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a campaign' })
  async remove(@Req() request: any, @Param('id') id: string) {
    return this.emailCampaignsService.remove(id, request.user.id);
  }

  @Post(':id/contacts')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Add a list of contacts to a campaign' })
  async addContacts(
    @Req() request: any,
    @Param('id') id: string,
    @Body() dto: AddContactsDto,
  ) {
    return this.emailCampaignsService.addContacts(id, dto, request.user.id);
  }

  @Delete(':id/contacts/:contactId')
  @ApiOperation({ summary: 'Remove a contact from a campaign' })
  async removeContact(
    @Req() request: any,
    @Param('id') id: string,
    @Param('contactId') contactId: string,
  ) {
    return this.emailCampaignsService.removeContact(
      id,
      contactId,
      request.user.id,
    );
  }

  @Post(':id/launch')
  @ApiOperation({ summary: 'Launch the email campaign' })
  async launchCampaign(@Req() request: any, @Param('id') id: string) {
    return this.emailCampaignsService.launchCampaign(id, request.user.id);
  }

  @Post(':id/relaunch')
  @ApiOperation({
    summary:
      'Re-send the campaign to every recipient, including those already sent',
  })
  async relaunchCampaign(@Req() request: any, @Param('id') id: string) {
    return this.emailCampaignsService.relaunchCampaign(id, request.user.id);
  }

  @Post(':id/schedule')
  @ApiOperation({ summary: 'Schedule the email campaign for a future time' })
  async schedule(
    @Req() request: any,
    @Param('id') id: string,
    @Body() body: { scheduledAt: string },
  ) {
    return this.emailCampaignsService.scheduleCampaign(
      id,
      String(body?.scheduledAt ?? ''),
      request.user.id,
    );
  }

  @Post(':id/unschedule')
  @ApiOperation({ summary: 'Cancel a scheduled email campaign' })
  async unschedule(@Req() request: any, @Param('id') id: string) {
    return this.emailCampaignsService.unscheduleCampaign(id, request.user.id);
  }
}

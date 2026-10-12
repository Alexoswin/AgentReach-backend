import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AddProspectsToContactsDto,
  BuildProfileDto,
  CreateProspectSearchDto,
  UpdateProspectDto,
} from './dto/prospect.dto';
import { ProspectsService } from './prospects.service';

@ApiTags('prospects')
@Controller('prospects')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ProspectsController {
  constructor(private readonly prospects: ProspectsService) {}

  @Post('profile')
  @ApiOperation({
    summary: 'Turn a description into an editable search profile',
  })
  buildProfile(@Req() request: any, @Body() dto: BuildProfileDto) {
    return this.prospects.buildProfile(request.user.id, dto);
  }

  @Post('searches')
  @ApiOperation({ summary: 'Create a prospect search' })
  createSearch(@Req() request: any, @Body() dto: CreateProspectSearchDto) {
    return this.prospects.createSearch(request.user.id, dto);
  }

  @Get('searches')
  @ApiOperation({ summary: 'List prospect searches' })
  listSearches(@Req() request: any) {
    return this.prospects.listSearches(request.user.id);
  }

  @Get('searches/:id')
  @ApiOperation({ summary: 'Get one prospect search' })
  getSearch(@Req() request: any, @Param('id') id: string) {
    return this.prospects.getSearch(request.user.id, id);
  }

  @Get('searches/:id/companies')
  @ApiOperation({ summary: 'Companies found by a search' })
  listCompanies(@Req() request: any, @Param('id') id: string) {
    return this.prospects.listCompanies(request.user.id, id);
  }

  @Get('searches/:id/people')
  @ApiOperation({ summary: 'People found by a search' })
  listPeople(
    @Req() request: any,
    @Param('id') id: string,
    @Query('status') status?: string,
  ) {
    return this.prospects.listPeople(request.user.id, id, status);
  }

  @Post('searches/:id/run')
  @ApiOperation({
    summary:
      'Work on a search for up to about 50 seconds. Call again while the result says done is false.',
  })
  run(
    @Req() request: any,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ) {
    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) controller.abort();
    });
    return this.prospects.run(request.user.id, id, controller.signal);
  }

  @Post('searches/:id/cancel')
  @ApiOperation({ summary: 'Cancel a search' })
  cancel(@Req() request: any, @Param('id') id: string) {
    return this.prospects.cancel(request.user.id, id);
  }

  @Delete('searches/:id')
  @ApiOperation({ summary: 'Delete a search and everything it found' })
  removeSearch(@Req() request: any, @Param('id') id: string) {
    return this.prospects.removeSearch(request.user.id, id);
  }

  @Patch('people/:id')
  @ApiOperation({ summary: 'Edit the email of, dismiss or restore a prospect' })
  updateProspect(
    @Req() request: any,
    @Param('id') id: string,
    @Body() dto: UpdateProspectDto,
  ) {
    return this.prospects.updateProspect(request.user.id, id, dto);
  }

  @Post('people/add-to-contacts')
  @ApiOperation({ summary: 'Add selected prospects to Contacts' })
  addToContacts(@Req() request: any, @Body() dto: AddProspectsToContactsDto) {
    return this.prospects.addToContacts(request.user.id, dto);
  }

  @Post('companies/:id/watch')
  @ApiOperation({ summary: 'Watch a company in Signals' })
  watchCompany(@Req() request: any, @Param('id') id: string) {
    return this.prospects.watchCompany(request.user.id, id);
  }
}

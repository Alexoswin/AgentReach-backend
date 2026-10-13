import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateDomainDto, UpdateDomainDto } from './dto/domain.dto';
import { DomainsService } from './domains.service';

@ApiTags('domains')
@Controller('domains')
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get()
  @ApiOperation({ summary: 'List the current user sending domains' })
  list(@Req() request: any) {
    return this.domains.list(request.user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Add a sending domain' })
  create(@Req() request: any, @Body() dto: CreateDomainDto) {
    return this.domains.create(request.user.id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a domain sender address' })
  update(
    @Req() request: any,
    @Param('id') id: string,
    @Body() dto: UpdateDomainDto,
  ) {
    return this.domains.update(request.user.id, id, dto);
  }

  @Post(':id/verify')
  @ApiOperation({ summary: 'Check the domain ownership DNS record' })
  verify(@Req() request: any, @Param('id') id: string) {
    return this.domains.verify(request.user.id, id);
  }

  @Post(':id/default')
  @ApiOperation({ summary: 'Make a verified domain the default sender' })
  setDefault(@Req() request: any, @Param('id') id: string) {
    return this.domains.setDefault(request.user.id, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a sending domain' })
  remove(@Req() request: any, @Param('id') id: string) {
    return this.domains.remove(request.user.id, id);
  }
}

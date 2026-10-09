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
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SignalsService } from './signals.service';
import { PlaybooksService } from './playbooks.service';
import { WatchService } from './watch.service';
import { CreatePlaybookDto } from './dto/create-playbook.dto';
import { UpdatePlaybookDto } from './dto/update-playbook.dto';
import { CreateManualSignalDto } from './dto/create-manual-signal.dto';
import { ReviewMatchDto } from './dto/review-match.dto';
import { IngestBounceDto } from './dto/ingest-bounce.dto';
import { CreateWatchDto } from './dto/create-watch.dto';
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS } from './signal.types';

@ApiTags('signals')
@Controller('signals')
export class SignalsController {
  constructor(
    private readonly signals: SignalsService,
    private readonly playbooks: PlaybooksService,
    private readonly watches: WatchService,
  ) {}

  @Get('types')
  @ApiOperation({ summary: 'List signal types and labels' })
  getTypes() {
    return SIGNAL_TYPES.map((id) => ({ id, label: SIGNAL_TYPE_LABELS[id] }));
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Signal-triggered vs manual performance comparison',
  })
  getStats(@Req() request: any) {
    return this.signals.getStats(request.user.id);
  }

  @Get('review-queue')
  @ApiOperation({ summary: 'Pending matches awaiting review' })
  getReviewQueue(@Req() request: any) {
    return this.signals.getReviewQueue(request.user.id);
  }

  @Post('review/:matchId')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Approve (launch) or reject a pending match' })
  review(
    @Req() request: any,
    @Param('matchId') matchId: string,
    @Body() dto: ReviewMatchDto,
  ) {
    return this.signals.reviewMatch(matchId, dto, request.user.id);
  }

  @Post('manual')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Create a manual signal' })
  createManual(@Req() request: any, @Body() dto: CreateManualSignalDto) {
    return this.signals.createManualSignal(dto, request.user.id);
  }

  @Post('bounce')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({
    summary: 'Ingest an SES bounce/complaint (job-change signal)',
  })
  bounce(@Req() request: any, @Body() dto: IngestBounceDto) {
    return this.signals.ingestBounce(dto, request.user.id);
  }

  @Post('poll')
  @ApiOperation({ summary: 'Run a collection poll immediately' })
  poll(@Req() request: any) {
    return this.signals.runPollNow(request.user.id);
  }

  // ---- Playbooks ----
  @Get('playbooks')
  @ApiOperation({ summary: 'List playbooks' })
  listPlaybooks(@Req() request: any) {
    return this.playbooks.findAll(request.user.id);
  }

  @Post('playbooks')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Create a playbook' })
  createPlaybook(@Req() request: any, @Body() dto: CreatePlaybookDto) {
    return this.playbooks.create(dto, request.user.id);
  }

  @Patch('playbooks/:id')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update a playbook' })
  updatePlaybook(
    @Req() request: any,
    @Param('id') id: string,
    @Body() dto: UpdatePlaybookDto,
  ) {
    return this.playbooks.update(id, dto, request.user.id);
  }

  @Post('playbooks/:id/toggle')
  @ApiOperation({ summary: 'Toggle a playbook active/paused' })
  togglePlaybook(@Req() request: any, @Param('id') id: string) {
    return this.playbooks.toggle(id, request.user.id);
  }

  @Delete('playbooks/:id')
  @ApiOperation({ summary: 'Delete a playbook' })
  removePlaybook(@Req() request: any, @Param('id') id: string) {
    return this.playbooks.remove(id, request.user.id);
  }

  // ---- Company watches ----
  @Get('watches')
  @ApiOperation({ summary: 'List watched companies' })
  listWatches(@Req() request: any) {
    return this.watches.findAll(request.user.id);
  }

  @Post('watches')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Add a watched company' })
  createWatch(@Req() request: any, @Body() dto: CreateWatchDto) {
    return this.watches.create(
      dto.companyName,
      dto.domain,
      request.user.id,
      dto.sourcesEnabled,
    );
  }

  @Post('watches/:id/toggle')
  @ApiOperation({ summary: 'Pause/resume a watch' })
  toggleWatch(@Req() request: any, @Param('id') id: string) {
    return this.watches.toggle(id, request.user.id);
  }

  @Delete('watches/:id')
  @ApiOperation({ summary: 'Remove a watch' })
  removeWatch(@Req() request: any, @Param('id') id: string) {
    return this.watches.remove(id, request.user.id);
  }

  // ---- Feed (kept last so it doesn't shadow the static routes above) ----
  @Get()
  @ApiOperation({ summary: 'Signal feed' })
  getFeed(
    @Req() request: any,
    @Query('type') type?: string,
    @Query('status') status?: string,
  ) {
    return this.signals.getFeed(request.user.id, { type, status });
  }
}

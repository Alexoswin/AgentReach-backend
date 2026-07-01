import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
  getStats() {
    return this.signals.getStats();
  }

  @Get('review-queue')
  @ApiOperation({ summary: 'Pending matches awaiting review' })
  getReviewQueue() {
    return this.signals.getReviewQueue();
  }

  @Post('review/:matchId')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Approve (launch) or reject a pending match' })
  review(@Param('matchId') matchId: string, @Body() dto: ReviewMatchDto) {
    return this.signals.reviewMatch(matchId, dto);
  }

  @Post('manual')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Create a manual signal' })
  createManual(@Body() dto: CreateManualSignalDto) {
    return this.signals.createManualSignal(dto);
  }

  @Post('bounce')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({
    summary: 'Ingest an SES bounce/complaint (job-change signal)',
  })
  bounce(@Body() dto: IngestBounceDto) {
    return this.signals.ingestBounce(dto);
  }

  @Post('poll')
  @ApiOperation({ summary: 'Run a collection poll immediately' })
  poll() {
    return this.signals.runPollNow();
  }

  // ---- Playbooks ----
  @Get('playbooks')
  @ApiOperation({ summary: 'List playbooks' })
  listPlaybooks() {
    return this.playbooks.findAll();
  }

  @Post('playbooks')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Create a playbook' })
  createPlaybook(@Body() dto: CreatePlaybookDto) {
    return this.playbooks.create(dto);
  }

  @Patch('playbooks/:id')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update a playbook' })
  updatePlaybook(@Param('id') id: string, @Body() dto: UpdatePlaybookDto) {
    return this.playbooks.update(id, dto);
  }

  @Post('playbooks/:id/toggle')
  @ApiOperation({ summary: 'Toggle a playbook active/paused' })
  togglePlaybook(@Param('id') id: string) {
    return this.playbooks.toggle(id);
  }

  @Delete('playbooks/:id')
  @ApiOperation({ summary: 'Delete a playbook' })
  removePlaybook(@Param('id') id: string) {
    return this.playbooks.remove(id);
  }

  // ---- Company watches ----
  @Get('watches')
  @ApiOperation({ summary: 'List watched companies' })
  listWatches() {
    return this.watches.findAll();
  }

  @Post('watches')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Add a watched company' })
  createWatch(@Body() dto: CreateWatchDto) {
    return this.watches.create(dto.companyName, dto.domain, dto.sourcesEnabled);
  }

  @Post('watches/:id/toggle')
  @ApiOperation({ summary: 'Pause/resume a watch' })
  async toggleWatch(@Param('id') id: string) {
    const all = await this.watches.findAll();
    const current = all.find((w) => w.id === id);
    const next = current?.status === 'active' ? 'paused' : 'active';
    return this.watches.setStatus(id, next);
  }

  @Delete('watches/:id')
  @ApiOperation({ summary: 'Remove a watch' })
  removeWatch(@Param('id') id: string) {
    return this.watches.remove(id);
  }

  // ---- Feed (kept last so it doesn't shadow the static routes above) ----
  @Get()
  @ApiOperation({ summary: 'Signal feed' })
  getFeed(@Query('type') type?: string, @Query('status') status?: string) {
    return this.signals.getFeed({ type, status });
  }
}

import {
  Body,
  Controller,
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
import { TradeAgentService } from './trade-agent.service';
import { UpdateTradePolicyDto } from './dto/update-trade-policy.dto';
import { DecideIntentDto } from './dto/decide-intent.dto';

@ApiTags('trade-agent')
@Controller('trade-agent')
export class TradeAgentController {
  constructor(private readonly tradeAgent: TradeAgentService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Desk overview: readiness, policy, session, book' })
  overview() {
    return this.tradeAgent.getOverview();
  }

  @Post('portfolio/refresh')
  @ApiOperation({ summary: 'Pull a fresh portfolio snapshot from the broker' })
  refreshPortfolio() {
    return this.tradeAgent.refreshPortfolio();
  }

  /* ---------------------------- runs ---------------------------- */

  @Get('runs')
  @ApiOperation({ summary: 'List orchestration runs' })
  listRuns(@Query('limit') limit?: string) {
    return this.tradeAgent.listRuns(limit ? Number(limit) : undefined);
  }

  @Get('runs/:runId')
  @ApiOperation({ summary: 'One run with its full agent transcript' })
  getRun(@Param('runId') runId: string) {
    return this.tradeAgent.getRun(runId);
  }

  @Post('runs')
  @ApiOperation({ summary: 'Start an analysis cycle now' })
  startRun() {
    return this.tradeAgent.startRun();
  }

  /* -------------------------- proposals ------------------------- */

  @Get('proposals')
  @ApiOperation({ summary: 'Order intents awaiting a decision' })
  listProposals(@Query('status') status?: string) {
    return this.tradeAgent.listProposals(status);
  }

  @Post('proposals/:intentId/decide')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({
    summary: 'Approve or decline a proposal (approval re-runs the risk engine)',
  })
  decide(
    @Req() request: any,
    @Param('intentId') intentId: string,
    @Body() dto: DecideIntentDto,
  ) {
    return this.tradeAgent.decideIntent(
      intentId,
      dto,
      request.user?.email || 'unknown',
    );
  }

  /* --------------------------- orders --------------------------- */

  @Get('orders')
  @ApiOperation({ summary: 'Orders and fills, simulated ones included' })
  listOrders(@Query('limit') limit?: string) {
    return this.tradeAgent.listOrders(limit ? Number(limit) : undefined);
  }

  @Post('orders/reconcile')
  @ApiOperation({ summary: 'Reconcile open orders against the broker now' })
  reconcile() {
    return this.tradeAgent.reconcileNow();
  }

  /* ---------------------------- risk ---------------------------- */

  @Get('risk-events')
  @ApiOperation({ summary: 'Risk gate decisions, most recent first' })
  listRiskEvents(@Query('limit') limit?: string) {
    return this.tradeAgent.listRiskEvents(limit ? Number(limit) : undefined);
  }

  /* --------------------------- policy --------------------------- */

  @Get('policy')
  @ApiOperation({ summary: 'Current execution policy and breaker state' })
  getPolicy() {
    return this.tradeAgent.getPolicy();
  }

  @Patch('policy')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  @ApiOperation({ summary: 'Update the execution policy or the kill switch' })
  updatePolicy(@Req() request: any, @Body() dto: UpdateTradePolicyDto) {
    return this.tradeAgent.updatePolicy(dto, request.user?.email || 'unknown');
  }

  /* ------------------------ instruments ------------------------- */

  @Get('instruments')
  @ApiOperation({
    summary: 'Search the instrument master (operator picker only)',
  })
  searchInstruments(@Query('q') term: string) {
    return this.tradeAgent.searchInstruments(term || '');
  }

  @Post('instruments/refresh')
  @ApiOperation({ summary: 'Re-download the instrument master' })
  refreshInstruments() {
    return this.tradeAgent.refreshInstruments();
  }
}

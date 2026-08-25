import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SettingsModule } from '../settings/settings.module';

import { TradeAgentController } from './trade-agent.controller';
import { TradeAgentService } from './trade-agent.service';
import { TradePolicyService } from './policy.service';
import { PortfolioService } from './portfolio.service';
import { MarketCalendarService } from './market-calendar.service';
import { MasterOrchestratorService } from './master-orchestrator.service';
import { MarketSchedulerService } from './market-scheduler.service';

import { GrowwAuthService } from './groww/groww-auth.service';
import { GrowwClientService } from './groww/groww-client.service';
import { InstrumentCacheService } from './groww/instrument-cache.service';

import { GeminiAgentService } from './llm/gemini-agent.service';

import { MarketDataWorker } from './workers/market-data.worker';
import { ResearchWorker } from './workers/research.worker';
import { TechnicalWorker } from './workers/technical.worker';
import { FnoStrategyWorker } from './workers/fno-strategy.worker';
import { EquityInvestmentWorker } from './workers/equity-investment.worker';

import { OrderIntentValidatorService } from './risk/order-intent-validator.service';
import { RiskEngineService } from './risk/risk-engine.service';
import { ExecutionService } from './execution/execution.service';
import { ReconciliationService } from './execution/reconciliation.service';

/**
 * Trade-Agent.
 *
 * The dependency direction encodes the trust boundary: workers and the master
 * depend on the LLM layer and read-only broker calls; only `ExecutionService`
 * is wired to the write path, and it depends on the risk engine rather than
 * the other way round.
 */
@Module({
  imports: [ScheduleModule.forRoot(), SettingsModule],
  controllers: [TradeAgentController],
  providers: [
    TradeAgentService,
    TradePolicyService,
    PortfolioService,
    MarketCalendarService,
    MasterOrchestratorService,
    MarketSchedulerService,

    GrowwAuthService,
    GrowwClientService,
    InstrumentCacheService,

    GeminiAgentService,

    MarketDataWorker,
    ResearchWorker,
    TechnicalWorker,
    FnoStrategyWorker,
    EquityInvestmentWorker,

    OrderIntentValidatorService,
    RiskEngineService,
    ExecutionService,
    ReconciliationService,
  ],
  exports: [TradeAgentService, MarketCalendarService],
})
export class TradeAgentModule {}

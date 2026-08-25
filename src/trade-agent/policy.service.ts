import { Injectable } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import {
  EXECUTION_MODES,
  ExecutionMode,
  TradePolicy,
} from './trade-agent.types';

/**
 * Reads the operator's execution policy.
 *
 * Always read fresh at the top of a cycle and again before execution — an
 * operator flipping the kill switch mid-run must take effect immediately, not
 * on the next process restart.
 */
@Injectable()
export class TradePolicyService {
  constructor(
    private readonly db: MongoService,
    private readonly settings: SettingsService,
  ) {}

  async read(): Promise<TradePolicy> {
    const settings = await this.settings.getRawSettings();

    const rawMode = String(settings?.tradeExecutionMode || 'paper');
    // Anything unrecognised falls back to the safest mode, never the riskiest.
    const mode: ExecutionMode = EXECUTION_MODES.includes(
      rawMode as ExecutionMode,
    )
      ? (rawMode as ExecutionMode)
      : 'paper';

    return {
      mode,
      killSwitch: Boolean(settings?.tradeKillSwitch),
      maxOrderValue: Number(settings?.tradeMaxOrderValue ?? 0),
      maxDailyLoss: Number(settings?.tradeMaxDailyLoss ?? 0),
      maxOpenPositions: Number(settings?.tradeMaxOpenPositions ?? 0),
      allowedSegments: Array.isArray(settings?.tradeAllowedSegments)
        ? settings.tradeAllowedSegments
        : ['CASH'],
      allowNakedOptions: Boolean(settings?.tradeAllowNakedOptions),
      marginBuffer: Number(settings?.tradeMarginBuffer ?? 0.2),
      maxTokensPerRun: Number(settings?.tradeMaxTokensPerRun ?? 400000),
      maxTokensPerDay: Number(settings?.tradeMaxTokensPerDay ?? 4000000),
    };
  }

  async setKillSwitch(engaged: boolean, reason: string) {
    await this.db.systemSettings.update({
      where: { id: 'default' },
      data: { tradeKillSwitch: engaged },
    });

    await this.db.riskEvent.create({
      data: {
        type: 'kill-switch',
        gate: 'kill-switch',
        severity: engaged ? 'critical' : 'info',
        message: engaged
          ? `Kill switch engaged: ${reason}`
          : `Kill switch cleared: ${reason}`,
        context: { engaged },
      },
    });

    return this.read();
  }

  /**
   * Tokens spent across all runs since IST midnight, for the daily ceiling.
   * The Gemini API has no server-side spend ceiling, so this accounting is ours.
   */
  async tokensSpentToday(): Promise<number> {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    const istMidnight = Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate(),
    );
    const since = new Date(istMidnight - IST_OFFSET_MS);

    const runs = await this.db.tradeAgentRun.findMany({
      where: { startedAt: { gte: since } },
    });

    return runs.reduce((sum: number, run: any) => {
      const usage = run?.tokenUsage || {};
      return (
        sum +
        Number(usage.inputTokens ?? 0) +
        Number(usage.outputTokens ?? 0) +
        Number(usage.cacheReadTokens ?? 0) +
        Number(usage.cacheWriteTokens ?? 0)
      );
    }, 0);
  }
}

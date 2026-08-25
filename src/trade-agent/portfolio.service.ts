import { Injectable, Logger } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { GrowwClientService } from './groww/groww-client.service';
import { PortfolioState } from './trade-agent.types';

/**
 * Builds the portfolio snapshot the master reasons over and the risk engine
 * gates against.
 *
 * When the broker is unreachable this returns a *degraded* state — an empty
 * book flagged with a reason — rather than throwing. That matters because the
 * risk engine treats a degraded state conservatively: with no positions and no
 * margin, the margin gate fails and nothing gets through. Failing closed is the
 * correct behaviour when we cannot see the account.
 */
@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    private readonly db: MongoService,
    private readonly groww: GrowwClientService,
  ) {}

  async capture(options: { persist?: boolean } = {}): Promise<PortfolioState> {
    const capturedAt = new Date();

    try {
      const [positions, holdings, margin] = await Promise.all([
        this.groww.getPositions(),
        this.groww.getHoldings(),
        this.groww.getUserMargin(),
      ]);

      const realisedPnl = positions.reduce(
        (sum, position) => sum + Number(position?.realised_pnl ?? 0),
        0,
      );

      const openPositions = positions.filter(
        (position) => Number(position?.quantity ?? 0) !== 0,
      );

      const unrealisedPnl = await this.markToMarket(openPositions);

      const state: PortfolioState = {
        positions,
        holdings,
        margin,
        realisedPnl: round2(realisedPnl),
        unrealisedPnl: round2(unrealisedPnl),
        openPositionCount: openPositions.length,
        capturedAt: capturedAt.toISOString(),
      };

      if (options.persist !== false) await this.persist(state);

      return state;
    } catch (error) {
      const reason = (error as Error).message;
      this.logger.warn(
        `Portfolio capture failed, returning degraded state: ${reason}`,
      );

      return {
        positions: [],
        holdings: [],
        margin: {},
        realisedPnl: 0,
        unrealisedPnl: 0,
        openPositionCount: 0,
        capturedAt: capturedAt.toISOString(),
        degraded: reason,
      };
    }
  }

  /**
   * Unrealised P&L from live LTPs. Returns 0 when quotes are unavailable —
   * and the caller can tell the difference via `degraded` on the state.
   */
  private async markToMarket(positions: Record<string, any>[]) {
    if (!positions.length) return 0;

    const bySegment = new Map<string, Record<string, any>[]>();
    for (const position of positions) {
      const segment = String(position?.segment || 'CASH');
      bySegment.set(segment, [...(bySegment.get(segment) ?? []), position]);
    }

    let total = 0;

    for (const [segment, group] of bySegment) {
      const symbols = group
        .map((position) => ({
          exchange: String(position?.exchange || 'NSE'),
          tradingSymbol: String(position?.trading_symbol || ''),
        }))
        .filter((entry) => entry.tradingSymbol);

      if (!symbols.length) continue;

      let ltp: Record<string, number> = {};
      try {
        ltp = await this.groww.getLtp(segment, symbols);
      } catch (error) {
        this.logger.warn(
          `LTP fetch failed for segment ${segment}: ${(error as Error).message}`,
        );
        continue;
      }

      for (const position of group) {
        const key = `${position?.exchange || 'NSE'}_${position?.trading_symbol}`;
        const last = Number(ltp[key] ?? 0);
        const quantity = Number(position?.quantity ?? 0);
        const netPrice = Number(
          position?.net_price ?? position?.credit_price ?? 0,
        );

        if (!last || !quantity || !netPrice) continue;
        total += (last - netPrice) * quantity;
      }
    }

    return total;
  }

  private async persist(state: PortfolioState) {
    try {
      await this.db.positionSnapshot.create({
        data: {
          capturedAt: new Date(state.capturedAt),
          positions: state.positions,
          holdings: state.holdings,
          margin: state.margin,
          realisedPnl: state.realisedPnl,
          unrealisedPnl: state.unrealisedPnl,
          openPositionCount: state.openPositionCount,
          simulated: false,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not persist position snapshot: ${(error as Error).message}`,
      );
    }
  }

  /** Most recent snapshot, for screens that must not trigger a broker call. */
  async latestSnapshot() {
    const rows = await this.db.positionSnapshot.findMany({
      orderBy: { capturedAt: 'desc' },
      take: 1,
    });
    return rows[0] ?? null;
  }
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

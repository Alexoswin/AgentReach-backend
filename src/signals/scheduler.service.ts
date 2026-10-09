import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WatchService } from './watch.service';
import { IngestionService } from './ingestion.service';
import { NewsRssCollector } from './collectors/news-rss.collector';
import { EdgarCollector } from './collectors/edgar.collector';
import { JobBoardCollector } from './collectors/job-board.collector';
import { CompanyWatchLike, SignalCollector } from './signal.types';

/**
 * Cron-driven polling. Iterates active company watches and runs each enabled
 * collector, feeding results into the ingestion pipeline. Every collector call
 * is isolated so one failure never blocks the rest (circuit-safe).
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly collectors: Record<string, SignalCollector>;
  private running = false;

  constructor(
    private readonly watches: WatchService,
    private readonly ingestion: IngestionService,
    news: NewsRssCollector,
    edgar: EdgarCollector,
    jobBoard: JobBoardCollector,
  ) {
    this.collectors = {
      [news.source]: news,
      [edgar.source]: edgar,
      [jobBoard.source]: jobBoard,
    };
  }

  // News + job boards every 6 hours; EDGAR effectively daily via its cursor.
  @Cron(CronExpression.EVERY_6_HOURS)
  async pollAll(): Promise<void> {
    await this.runPoll();
  }

  /**
   * Poll every owner's watches, or only ownerId's (the "Run now" control).
   */
  async runPoll(
    ownerId?: string,
  ): Promise<{ processed: number; created: number }> {
    if (this.running) {
      return { processed: 0, created: 0 };
    }
    this.running = true;
    let processed = 0;
    let created = 0;

    try {
      const watches = await this.watches.findActive(ownerId);
      for (const watch of watches) {
        for (const source of watch.sourcesEnabled) {
          const collector = this.collectors[source];
          if (!collector) continue;
          const madeCount = await this.pollOne(watch, collector);
          created += madeCount;
          processed++;
        }
      }
    } finally {
      this.running = false;
    }

    if (created > 0) {
      this.logger.log(`Poll complete: ${created} new signal(s) ingested`);
    }
    return { processed, created };
  }

  private async pollOne(
    watch: CompanyWatchLike,
    collector: SignalCollector,
  ): Promise<number> {
    let created = 0;
    try {
      const rawSignals = await collector.collect(watch);
      for (const raw of rawSignals) {
        const id = await this.ingestion.ingest(raw, watch.ownerId, watch.id);
        if (id) created++;
      }
      await this.watches.markPolled(watch.id, collector.source);
    } catch (err) {
      this.logger.warn(
        `Collector ${collector.source} failed for ${watch.domain}: ${(err as Error).message}`,
      );
    }
    return created;
  }
}

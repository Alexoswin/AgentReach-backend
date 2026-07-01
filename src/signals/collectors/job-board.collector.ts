import { Injectable, Logger } from '@nestjs/common';
import {
  CompanyWatchLike,
  RawSignal,
  SignalCollector,
} from '../signal.types';

/**
 * S3 — Hiring surge. Reads the public Greenhouse job-board API for a company
 * slug derived from the company name. Free, public JSON.
 *
 * A meaningful jump in open roles is emitted as a single hiring-surge signal.
 */
@Injectable()
export class JobBoardCollector implements SignalCollector {
  readonly source = 'job-board';
  private readonly logger = new Logger(JobBoardCollector.name);
  private readonly SURGE_THRESHOLD = 5;

  async collect(watch: CompanyWatchLike): Promise<RawSignal[]> {
    const slug = this.slugify(watch.companyName);
    if (!slug) return [];

    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as { jobs?: Array<{ title?: string }> };
      const jobs = data?.jobs || [];
      if (jobs.length < this.SURGE_THRESHOLD) return [];

      const sampleRoles = jobs
        .slice(0, 5)
        .map((j) => j.title)
        .filter(Boolean)
        .join(', ');

      return [
        {
          source: this.source,
          companyDomain: watch.domain,
          companyName: watch.companyName,
          title: `${watch.companyName} is hiring — ${jobs.length} open roles`,
          summary: `Open roles include: ${sampleRoles}.`,
          url: `https://boards.greenhouse.io/${slug}`,
          occurredAt: new Date(),
          suggestedType: 'hiring-surge',
          raw: { roleCount: jobs.length },
        },
      ];
    } catch (err) {
      this.logger.warn(
        `job-board collect failed for ${watch.domain}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|corp|co|the)\b/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }
}

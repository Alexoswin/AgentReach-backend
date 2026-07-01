import { Injectable, Logger } from '@nestjs/common';
import {
  CompanyWatchLike,
  RawSignal,
  SignalCollector,
} from '../signal.types';

/**
 * S2 — Funding rounds via SEC EDGAR full-text search (Form D).
 * Uses the public EDGAR full-text search JSON API. Free, public.
 */
@Injectable()
export class EdgarCollector implements SignalCollector {
  readonly source = 'edgar';
  private readonly logger = new Logger(EdgarCollector.name);

  async collect(watch: CompanyWatchLike): Promise<RawSignal[]> {
    const url =
      'https://efts.sec.gov/LATEST/search-index?q=' +
      encodeURIComponent(`"${watch.companyName}"`) +
      '&forms=D';

    try {
      const res = await fetch(url, {
        headers: {
          // EDGAR requires a descriptive UA.
          'User-Agent': 'ReachConvert Signals signals@reachconvert.app',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as {
        hits?: { hits?: Array<{ _source?: any; _id?: string }> };
      };
      const hits = data?.hits?.hits || [];

      return hits.slice(0, 10).map((hit): RawSignal => {
        const src = hit._source || {};
        const filedAt = src.file_date ? new Date(src.file_date) : new Date();
        return {
          source: this.source,
          companyDomain: watch.domain,
          companyName: watch.companyName,
          title: `${watch.companyName} filed a Form D (exempt securities offering)`,
          summary:
            'A Form D filing typically indicates a private funding round or capital raise.',
          url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany`,
          occurredAt: filedAt,
          suggestedType: 'funding',
          raw: { edgarId: hit._id },
        };
      });
    } catch (err) {
      this.logger.warn(
        `edgar collect failed for ${watch.domain}: ${(err as Error).message}`,
      );
      return [];
    }
  }
}

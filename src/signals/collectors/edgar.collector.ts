import { Injectable, Logger } from '@nestjs/common';
import { CompanyWatchLike, RawSignal, SignalCollector } from '../signal.types';

// A first poll should surface recent funding activity, not a company's entire
// filing history — anything older than this is stale as a buying signal.
const MAX_FILING_AGE_DAYS = 90;

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
      const cutoff = new Date(
        Date.now() - MAX_FILING_AGE_DAYS * 24 * 60 * 60 * 1000,
      );

      return hits
        .slice(0, 10)
        .map((hit): RawSignal | null => {
          const src = hit._source || {};
          const filedAt = src.file_date ? new Date(src.file_date) : new Date();
          if (Number.isNaN(filedAt.getTime()) || filedAt < cutoff) return null;
          return {
            source: this.source,
            companyDomain: watch.domain,
            companyName: watch.companyName,
            title: `${watch.companyName} filed a Form D (exempt securities offering) on ${src.file_date || 'an unknown date'}`,
            summary:
              'A Form D filing typically indicates a private funding round or capital raise.',
            url: this.filingUrl(src, hit._id),
            occurredAt: filedAt,
            suggestedType: 'funding',
            // The accession id is the filing's stable identity — hashing on it
            // keeps distinct filings from deduping into one signal.
            dedupKey: hit._id,
            raw: { edgarId: hit._id },
          };
        })
        .filter((s): s is RawSignal => s !== null);
    } catch (err) {
      this.logger.warn(
        `edgar collect failed for ${watch.domain}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /** Direct link to the filing index when the accession id is parseable. */
  private filingUrl(src: any, edgarId?: string): string {
    const cik = Array.isArray(src?.ciks) ? src.ciks[0] : undefined;
    const accession = edgarId?.split(':')[0];
    if (cik && accession) {
      const cikNum = String(Number(cik));
      return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession.replace(/-/g, '')}/${accession}-index.htm`;
    }
    return 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany';
  }
}

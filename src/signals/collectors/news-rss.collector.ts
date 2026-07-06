import { Injectable, Logger } from '@nestjs/common';
import Parser from 'rss-parser';
import { CompanyWatchLike, RawSignal, SignalCollector } from '../signal.types';

/**
 * S1 — Company in the news. Polls Google News RSS scoped to the company name.
 * Free, public. Any fetch failure yields an empty batch (circuit-safe).
 */
@Injectable()
export class NewsRssCollector implements SignalCollector {
  readonly source = 'news-rss';
  private readonly logger = new Logger(NewsRssCollector.name);
  private readonly parser = new Parser({ timeout: 10_000 });

  async collect(watch: CompanyWatchLike): Promise<RawSignal[]> {
    const since = this.sinceDate(watch.lastPolledAt?.[this.source]);
    const query = encodeURIComponent(`"${watch.companyName}"`);
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

    try {
      const feed = await this.parser.parseURL(url);
      return (feed.items || [])
        .map((item): RawSignal | null => {
          const occurredAt = item.isoDate ? new Date(item.isoDate) : new Date();
          if (since && occurredAt <= since) return null;
          return {
            source: this.source,
            companyDomain: watch.domain,
            companyName: watch.companyName,
            title: item.title || 'Untitled news item',
            summary: this.stripHtml(item.contentSnippet || item.content || ''),
            url: item.link,
            occurredAt,
            dedupKey: item.guid || item.link,
            raw: { guid: item.guid },
          };
        })
        .filter((s): s is RawSignal => s !== null)
        .slice(0, 20);
    } catch (err) {
      this.logger.warn(
        `news-rss collect failed for ${watch.domain}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private sinceDate(iso?: string): Date | null {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private stripHtml(value: string): string {
    return value
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }
}

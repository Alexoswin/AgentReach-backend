import { Injectable, Logger } from '@nestjs/common';
import { CompanyWatchLike, RawSignal, SignalCollector } from '../signal.types';

type AtsProvider = {
  id: string;
  jobsUrl: (slug: string) => string;
  boardUrl: (slug: string) => string;
  /** Extract job titles from the provider's JSON payload; null = board not found. */
  parseTitles: (payload: any) => string[] | null;
};

// Each provider exposes a free public JSON endpoint for a company's job board.
// A 404 (or malformed payload) means "this company is not on this ATS", so we
// try the next provider — companies only ever live on one of them.
const PROVIDERS: AtsProvider[] = [
  {
    id: 'greenhouse',
    jobsUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    boardUrl: (slug) => `https://boards.greenhouse.io/${slug}`,
    parseTitles: (payload) =>
      Array.isArray(payload?.jobs)
        ? payload.jobs.map((j: any) => String(j?.title || '')).filter(Boolean)
        : null,
  },
  {
    id: 'lever',
    jobsUrl: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    boardUrl: (slug) => `https://jobs.lever.co/${slug}`,
    parseTitles: (payload) =>
      Array.isArray(payload)
        ? payload.map((j: any) => String(j?.text || '')).filter(Boolean)
        : null,
  },
  {
    id: 'ashby',
    jobsUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    boardUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    parseTitles: (payload) =>
      Array.isArray(payload?.jobs)
        ? payload.jobs.map((j: any) => String(j?.title || '')).filter(Boolean)
        : null,
  },
];

/**
 * S3 — Hiring surge. Probes the public job-board APIs of the major ATS
 * platforms (Greenhouse, Lever, Ashby) using slugs derived from the company
 * name and domain, and emits a single hiring-surge signal when a board with a
 * meaningful number of open roles is found.
 */
@Injectable()
export class JobBoardCollector implements SignalCollector {
  readonly source = 'job-board';
  private readonly logger = new Logger(JobBoardCollector.name);
  private readonly SURGE_THRESHOLD = 5;

  async collect(watch: CompanyWatchLike): Promise<RawSignal[]> {
    const slugs = this.slugCandidates(watch);
    if (slugs.length === 0) return [];

    for (const slug of slugs) {
      for (const provider of PROVIDERS) {
        const titles = await this.fetchTitles(provider, slug, watch.domain);
        if (titles === null) continue; // board not found on this provider
        if (titles.length < this.SURGE_THRESHOLD) return []; // found but quiet

        const sampleRoles = titles.slice(0, 5).join(', ');
        return [
          {
            source: this.source,
            companyDomain: watch.domain,
            companyName: watch.companyName,
            title: `${watch.companyName} is hiring — ${titles.length} open roles`,
            summary: `Open roles include: ${sampleRoles}.`,
            url: provider.boardUrl(slug),
            occurredAt: new Date(),
            suggestedType: 'hiring-surge',
            // Role counts drift between polls; keying dedup on the board (not
            // the count in the title) yields one surge signal per dedup window
            // instead of a new signal every time the count changes.
            dedupKey: `job-board:${provider.id}:${slug}`,
            raw: { roleCount: titles.length, provider: provider.id, slug },
          },
        ];
      }
    }
    return [];
  }

  private async fetchTitles(
    provider: AtsProvider,
    slug: string,
    domain: string,
  ): Promise<string[] | null> {
    try {
      const res = await fetch(provider.jobsUrl(slug), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return provider.parseTitles(await res.json());
    } catch (err) {
      this.logger.warn(
        `job-board (${provider.id}) collect failed for ${domain}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Candidate board slugs: from the company name and the email domain. */
  private slugCandidates(watch: CompanyWatchLike): string[] {
    const fromName = this.slugify(watch.companyName);
    const fromDomain = this.slugify(watch.domain?.split('.')[0] || '');
    return [...new Set([fromName, fromDomain].filter(Boolean))];
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|corp|co|the)\b/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }
}

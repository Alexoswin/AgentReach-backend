/** Canonical signal taxonomy (see plan §3). */
export const SIGNAL_TYPES = [
  'funding',
  'hiring-surge',
  'company-news',
  'product-launch',
  'job-change',
  'website-change',
  'manual',
  'news-other',
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export type Confidence = 'high' | 'medium' | 'low';

/** A raw, pre-normalization item emitted by a collector. */
export interface RawSignal {
  source: string;
  companyDomain?: string;
  companyName?: string;
  title: string;
  summary?: string;
  url?: string;
  occurredAt?: Date;
  /** Collector's best-guess type; the classifier may override it. */
  suggestedType?: SignalType;
  /**
   * Stable per-event identity for dedup (e.g. an EDGAR accession id or RSS
   * guid). Without it the hash falls back to url/title, which collapses
   * distinct events that share presentation text.
   */
  dedupKey?: string;
  raw?: Record<string, any>;
}

/** How a signal was linked to a contact — shown in the review queue. */
export type MatchReason = 'email-domain' | 'company-name';

export const MATCH_REASON_LABELS: Record<string, string> = {
  'email-domain': 'Work email domain matches the company',
  'company-name': 'Company name matches (fuzzy)',
};

export interface CompanyWatchLike {
  id: string;
  companyName: string;
  domain: string;
  sourcesEnabled: string[];
  lastPolledAt: Record<string, string>;
  status: string;
}

export interface SignalCollector {
  readonly source: string;
  collect(watch: CompanyWatchLike): Promise<RawSignal[]>;
}

/** Human-friendly labels for UI + templates. */
export const SIGNAL_TYPE_LABELS: Record<string, string> = {
  funding: 'Funding round',
  'hiring-surge': 'Hiring surge',
  'company-news': 'Company news',
  'product-launch': 'Product launch',
  'job-change': 'Job change',
  'website-change': 'Website change',
  manual: 'Manual signal',
  'news-other': 'General news',
};

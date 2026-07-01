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
  raw?: Record<string, any>;
}

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

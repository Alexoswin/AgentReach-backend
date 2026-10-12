import { ProspectProfile } from './icp';

export type Verdict = 'yes' | 'no' | 'unknown';

export type Criterion = {
  key: string;
  label: string;
  verdict: Verdict;
  evidence: string;
  url: string;
};

const CRITERIA = [
  { key: 'industry', label: 'Industry', weight: 25 },
  { key: 'size', label: 'Company size', weight: 20 },
  { key: 'location', label: 'Location', weight: 15 },
  { key: 'signals', label: 'Buying signals', weight: 25 },
  { key: 'keywords', label: 'Keywords', weight: 15 },
] as const;

export function applicableCriteria(profile: ProspectProfile) {
  const present: Record<string, boolean> = {
    industry: profile.industries.length > 0,
    size:
      profile.companySize.min !== undefined ||
      profile.companySize.max !== undefined,
    location: profile.locations.length > 0,
    signals: profile.signals.length > 0,
    keywords: profile.keywords.length > 0,
  };
  const applicable = CRITERIA.filter((criterion) => present[criterion.key]);
  return applicable.length > 0 ? applicable : [CRITERIA[0]];
}

export function scoreCriteria(criteria: Criterion[]) {
  let earned = 0;
  let possible = 0;
  for (const criterion of criteria) {
    const weight = CRITERIA.find((item) => item.key === criterion.key)?.weight;
    if (!weight) continue;
    possible += weight;
    if (criterion.verdict === 'yes') earned += weight;
  }
  return possible > 0 ? Math.round((earned / possible) * 100) : 0;
}

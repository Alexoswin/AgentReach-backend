import { GeminiJson } from './gemini-json';

export type ProspectProfile = {
  summary: string;
  industries: string[];
  keywords: string[];
  companySize: { min?: number; max?: number };
  locations: string[];
  jobTitles: string[];
  signals: string[];
  exclusions: string[];
  exampleDomains: string[];
};

const MAX_LIST_ITEMS = 15;
const MAX_ITEM_LENGTH = 80;

function toList(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (text) seen.add(text.slice(0, MAX_ITEM_LENGTH));
  }
  return [...seen].slice(0, MAX_LIST_ITEMS);
}

function toCount(value: unknown) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0
    ? Math.round(number)
    : undefined;
}

export function normalizeProfile(raw: unknown): ProspectProfile {
  const source =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const size =
    source.companySize && typeof source.companySize === 'object'
      ? (source.companySize as Record<string, unknown>)
      : {};
  const min = toCount(size.min);
  const max = toCount(size.max);
  return {
    summary:
      typeof source.summary === 'string' ? source.summary.trim().slice(0, 300) : '',
    industries: toList(source.industries),
    keywords: toList(source.keywords),
    companySize: {
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    },
    locations: toList(source.locations),
    jobTitles: toList(source.jobTitles),
    signals: toList(source.signals),
    exclusions: toList(source.exclusions),
    exampleDomains: toList(source.exampleDomains).slice(0, 3),
  };
}

export async function buildProfile(
  generate: GeminiJson,
  description: string,
  exampleDomains: string[],
) {
  const prompt = [
    "You turn a sales user's description of their ideal customer into a structured search profile.",
    'Return JSON only with these keys:',
    '  summary: one sentence restating the ideal customer',
    '  industries: string[] of industries',
    "  keywords: string[] of words a matching company's website would use",
    '  companySize: { "min": number|null, "max": number|null } employees',
    '  locations: string[] of countries or cities',
    '  jobTitles: string[] of the people to contact',
    '  signals: string[] chosen from "hiring", "funding", "expansion", "product launch"',
    '  exclusions: string[] of industries or company names to avoid',
    'Use only what the description implies. Leave a list empty rather than guessing.',
    '',
    `Description: ${description}`,
    exampleDomains.length
      ? `Example customers: ${exampleDomains.join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const profile = normalizeProfile(await generate(prompt));
  return { ...profile, exampleDomains };
}

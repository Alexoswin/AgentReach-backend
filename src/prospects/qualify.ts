import { GeminiJson } from './gemini-json';
import { ProspectProfile } from './icp';
import { applicableCriteria, Criterion, Verdict } from './scoring';
import { SiteContent } from './site-reader';
import {
  evidenceInText,
  extractEmails,
  normalizeText,
  RawPerson,
  verifyPerson,
  VerifiedPerson,
} from './verify';

export type Analysis = {
  summary: string;
  excluded: boolean;
  criteria: Criterion[];
  people: VerifiedPerson[];
};

const VERDICTS: Verdict[] = ['yes', 'no', 'unknown'];

export async function analyzeCompany(
  generate: GeminiJson,
  profile: ProspectProfile,
  company: { name: string; domain: string },
  site: SiteContent,
): Promise<Analysis> {
  const applicable = applicableCriteria(profile);
  const pageUrls = site.pages.map((page) => page.url);
  const pageText = site.pages
    .map((page) => `--- PAGE: ${page.url} ---\n${page.text}`)
    .join('\n\n');

  const prompt = [
    'You check whether a company matches an ideal customer profile, using ONLY the website text below.',
    'Return JSON only with these keys:',
    '  summary: one sentence about what the company does',
    '  excluded: true if the company matches an exclusion',
    `  criteria: an object with keys ${applicable.map((item) => `"${item.key}"`).join(', ')}, each { "verdict": "yes"|"no"|"unknown", "evidence": string, "url": string }`,
    '  people: array of { "firstName", "lastName", "jobTitle", "email", "url", "relevant" } for people named on the pages',
    'Rules:',
    '- "evidence" must be copied word for word from the page text, at most 160 characters. Use "unknown" with empty evidence when the text does not say.',
    '- "url" is the PAGE the evidence or person came from.',
    '- Never invent people or email addresses. "email" must appear exactly in the text, otherwise leave it empty.',
    '- "relevant" is true when the person\'s title matches one of the target job titles or is clearly equivalent.',
    `- Criteria: industry = ${profile.industries.join(', ') || 'n/a'}; size = ${JSON.stringify(profile.companySize)} employees; location = ${profile.locations.join(', ') || 'n/a'}; signals = ${profile.signals.join(', ') || 'n/a'}; keywords = ${profile.keywords.join(', ') || 'n/a'}.`,
    `- Target job titles: ${profile.jobTitles.join(', ') || 'any senior role'}.`,
    `- Exclusions: ${profile.exclusions.join(', ') || 'none'}.`,
    '',
    `Company: ${company.name} (${company.domain})`,
    pageText,
  ].join('\n');

  const raw = (await generate(prompt)) as Record<string, any>;
  const normalizedPage = normalizeText(pageText);

  const criteria: Criterion[] = applicable.map((item) => {
    const entry = raw?.criteria?.[item.key] || {};
    const claimed: Verdict = VERDICTS.includes(entry.verdict)
      ? entry.verdict
      : 'unknown';
    const evidence =
      typeof entry.evidence === 'string' ? entry.evidence.trim() : '';
    const supported =
      claimed === 'unknown' || evidenceInText(evidence, normalizedPage);
    const url = pageUrls.includes(entry.url) ? entry.url : pageUrls[0] || '';
    return {
      key: item.key,
      label: item.label,
      verdict: supported ? claimed : 'unknown',
      evidence: supported ? evidence.slice(0, 160) : '',
      url,
    };
  });

  const pageEmails = new Set<string>([
    ...site.emails,
    ...extractEmails(pageText),
  ]);
  const people: VerifiedPerson[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw?.people) ? raw.people : []) {
    const person = verifyPerson(item as RawPerson, {
      normalizedPage,
      pageEmails: [...pageEmails],
      companyDomain: company.domain,
      fallbackUrl: pageUrls[0] || '',
      pageUrls,
    });
    if (!person) continue;
    const key = `${person.firstName} ${person.lastName}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(person);
  }

  return {
    summary:
      typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, 240) : '',
    excluded: raw?.excluded === true,
    criteria,
    people,
  };
}

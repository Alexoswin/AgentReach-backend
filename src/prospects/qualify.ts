import { GeminiJson } from './gemini-json';
import { ProspectProfile } from './icp';
import { applicableCriteria, Criterion, Verdict } from './scoring';
import { SiteContent } from './site-reader';
import {
  domainMatches,
  evidenceInText,
  extractEmails,
  mailboxRole,
  normalizeText,
  RawPerson,
  verifyContacts,
  verifyPerson,
  VerifiedPerson,
} from './verify';

const MAX_COMPANY_EMAILS = 6;
const MAX_COMPANY_PHONES = 5;

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
  options: { peopleOnly?: boolean } = {},
): Promise<Analysis> {
  const applicable = options.peopleOnly ? [] : applicableCriteria(profile);
  const pageUrls = site.pages.map((page) => page.url);
  const pageText = site.pages
    .map((page) => `--- PAGE: ${page.url} ---\n${page.text}`)
    .join('\n\n');

  const targetTitles = `Target job titles: ${profile.jobTitles.join(', ') || 'any senior role'}.`;
  const header = [`Company: ${company.name} (${company.domain})`, pageText];
  const prompt = options.peopleOnly
    ? [
        'You list the people named on a company website, using ONLY the website text below.',
        'Return JSON only with these keys:',
        '  summary: one sentence about what the company does',
        '  people: array of { "firstName", "lastName", "jobTitle", "email", "phone", "linkedinUrl", "url", "relevant" } for every person named with a role on the pages',
        'Rules:',
        '- "url" is the PAGE the person came from.',
        '- Never invent people, email addresses or phone numbers. "email", "phone" and "linkedinUrl" must appear exactly in the text, otherwise leave them empty.',
        "- Only give a person a phone or LinkedIn profile that is listed with that person. Never give a person the company's general phone number.",
        `- "relevant" is true when the person's title matches one of the target job titles or is clearly equivalent. ${targetTitles}`,
        '',
        ...header,
      ].join('\n')
    : [
        'You check whether a company matches an ideal customer profile, using ONLY the website text below.',
        'Return JSON only with these keys:',
        '  summary: one sentence about what the company does',
        '  excluded: true if the company matches an exclusion',
        `  criteria: an object with keys ${applicable.map((item) => `"${item.key}"`).join(', ')}, each { "verdict": "yes"|"no"|"unknown", "evidence": string, "url": string }`,
        '  people: array of { "firstName", "lastName", "jobTitle", "email", "phone", "linkedinUrl", "url", "relevant" } for people named on the pages',
        'Rules:',
        '- "evidence" must be copied word for word from the page text, at most 160 characters. Use "unknown" with empty evidence when the text does not say.',
        '- "url" is the PAGE the evidence or person came from.',
        '- Never invent people, email addresses or phone numbers. "email", "phone" and "linkedinUrl" must appear exactly in the text, otherwise leave them empty.',
        "- Only give a person a phone or LinkedIn profile that is listed with that person. Never give a person the company's general phone number.",
        `- "relevant" is true when the person's title matches one of the target job titles or is clearly equivalent. ${targetTitles}`,
        `- Criteria: industry = ${profile.industries.join(', ') || 'n/a'}; size = ${JSON.stringify(profile.companySize)} employees; location = ${profile.locations.join(', ') || 'n/a'}; signals = ${profile.signals.join(', ') || 'n/a'}; keywords = ${profile.keywords.join(', ') || 'n/a'}.`,
        `- Exclusions: ${profile.exclusions.join(', ') || 'none'}.`,
        '',
        ...header,
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
  const claims: RawPerson[] = [];
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
    claims.push(item as RawPerson);
  }

  return {
    summary:
      typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, 240) : '',
    excluded: raw?.excluded === true,
    criteria,
    people: people.map((person, index) => ({
      ...person,
      ...verifyContacts(person, claims[index], {
        normalizedPage,
        contacts: site.contacts || [],
        others: people.filter((other) => other !== person),
        homeUrl: pageUrls[0] || '',
      }),
    })),
  };
}

export function companyContacts(
  site: SiteContent,
  company: { domain: string },
  people: VerifiedPerson[],
) {
  const taken = new Set(
    people.flatMap((person) => [
      person.email,
      person.phone,
      person.linkedinUrl,
    ]),
  );
  const contacts = (site.contacts || []).filter(
    (item) => !taken.has(item.value),
  );
  return {
    emails: contacts
      .filter(
        (item) =>
          item.kind === 'email' &&
          domainMatches(item.value.split('@')[1], company.domain) &&
          mailboxRole(item.value),
      )
      .slice(0, MAX_COMPANY_EMAILS)
      .map((item) => ({
        value: item.value,
        label: mailboxRole(item.value),
        url: item.url,
      })),
    phones: contacts
      .filter((item) => item.kind === 'phone')
      .sort(
        (a, b) =>
          Number(b.label === 'main') - Number(a.label === 'main') ||
          b.seen.length - a.seen.length,
      )
      .slice(0, MAX_COMPANY_PHONES)
      .map((item) => ({
        value: item.value,
        type: item.type || 'phone',
        label: item.label,
        url: item.url,
      })),
    linkedinUrl:
      contacts.find(
        (item) => item.kind === 'linkedin' && item.label === 'company',
      )?.value || '',
  };
}

export function rankPeople(people: VerifiedPerson[]) {
  return [...people].sort(
    (a, b) =>
      Number(b.relevant) - Number(a.relevant) ||
      Number(Boolean(b.email)) - Number(Boolean(a.email)) ||
      Number(Boolean(b.phone)) - Number(Boolean(a.phone)),
  );
}

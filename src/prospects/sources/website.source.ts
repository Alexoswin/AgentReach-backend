import { GeminiJson } from '../gemini-json';
import { normalizeDomain } from '../site-reader';
import { CompanyCandidate, ProspectSource } from './prospect-source';

const MAX_EXCLUDED_IN_PROMPT = 30;

export class WebsiteSource implements ProspectSource {
  constructor(private readonly generate: GeminiJson) {}

  async findCompanies({
    profile,
    limit,
    exclude,
  }: Parameters<ProspectSource['findCompanies']>[0]): Promise<
    CompanyCandidate[]
  > {
    const prompt = [
      'List real companies that match this ideal customer profile.',
      'Only include companies you are confident exist, with their official website domain. If you are not sure of a domain, leave the company out.',
      `Return JSON only: {"companies":[{"name":"","domain":""}]} with at most ${limit} companies.`,
      `Profile: ${JSON.stringify({
        summary: profile.summary,
        industries: profile.industries,
        keywords: profile.keywords,
        companySize: profile.companySize,
        locations: profile.locations,
        signals: profile.signals,
      })}`,
      profile.exampleDomains.length
        ? `Companies similar to: ${profile.exampleDomains.join(', ')}`
        : '',
      profile.exclusions.length
        ? `Avoid: ${profile.exclusions.join(', ')}`
        : '',
      exclude.size
        ? `Do not include: ${[...exclude].slice(0, MAX_EXCLUDED_IN_PROMPT).join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const raw = (await this.generate(prompt)) as { companies?: unknown };
    const list = Array.isArray(raw?.companies) ? raw.companies : [];
    const seen = new Set<string>();
    const candidates: CompanyCandidate[] = [];
    for (const item of list) {
      const entry = item as { name?: unknown; domain?: unknown };
      const domain = normalizeDomain(entry?.domain);
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      if (!domain || !name || exclude.has(domain) || seen.has(domain)) continue;
      seen.add(domain);
      candidates.push({ name: name.slice(0, 120), domain });
    }
    return candidates.slice(0, limit);
  }
}

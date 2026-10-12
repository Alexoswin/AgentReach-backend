import { GeminiJson } from '../gemini-json';
import { normalizeDomain } from '../site-reader';
import { CompanyCandidate } from './prospect-source';

export async function resolveCompanies(
  generate: GeminiJson,
  targets: string[],
) {
  const candidates: CompanyCandidate[] = [];
  const names: string[] = [];
  for (const target of targets) {
    const domain = normalizeDomain(target);
    if (domain) candidates.push({ name: domain, domain });
    else names.push(target);
  }

  const unresolved = new Set(names.map((name) => name.toLowerCase()));
  if (names.length) {
    const raw = (await generate(
      [
        'Give the official website domain of each company. If you are not sure, leave the domain empty. Do not guess.',
        'Return JSON only: {"companies":[{"name":"","domain":""}]}',
        `Companies: ${names.join('; ')}`,
      ].join('\n'),
    )) as { companies?: unknown };
    for (const item of Array.isArray(raw?.companies) ? raw.companies : []) {
      const entry = item as { name?: unknown; domain?: unknown };
      const domain = normalizeDomain(entry?.domain);
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      const asked = names.find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
      );
      if (!domain || !asked) continue;
      candidates.push({ name: asked.slice(0, 120), domain });
      unresolved.delete(asked.toLowerCase());
    }
  }

  const seen = new Set<string>();
  return {
    candidates: candidates.filter((candidate) => {
      if (seen.has(candidate.domain)) return false;
      seen.add(candidate.domain);
      return true;
    }),
    unresolved: names.filter((name) => unresolved.has(name.toLowerCase())),
  };
}

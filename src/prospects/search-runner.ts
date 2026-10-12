import { MongoService } from '../mongo.service';
import { GeminiJson } from './gemini-json';
import { normalizeProfile, ProspectProfile } from './icp';
import { QUALIFY_CONCURRENCY, QUALIFY_THRESHOLD } from './prospect.constants';
import { analyzeCompany, rankPeople } from './qualify';
import { scoreCriteria } from './scoring';
import { normalizeDomain, SiteReader } from './site-reader';
import { ProspectSource } from './sources/prospect-source';
import { resolveCompanies } from './sources/company-lookup';
import {
  inferEmailPattern,
  PERSONAL_EMAIL_DOMAINS,
  VerifiedPerson,
} from './verify';

export type RunDeps = {
  db: Pick<
    MongoService,
    | 'prospectSearch'
    | 'prospectCompany'
    | 'prospect'
    | 'contact'
    | 'companyWatch'
  >;
  generate: GeminiJson;
  reader: Pick<SiteReader, 'readSite'>;
  createSource: (generate: GeminiJson) => ProspectSource;
};

export type RunOutcome = {
  status: 'completed' | 'paused' | 'failed' | 'cancelled';
  stage: 'find' | 'qualify' | 'done';
  note?: string;
  error?: string;
};

type Limits = { signal: AbortSignal; deadline: number };

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_REASONS = 3;
const MAX_CANDIDATES = 60;

class BudgetExceeded extends Error {}

async function excludedDomains(
  db: RunDeps['db'],
  ownerId: string,
  profile: ProspectProfile,
) {
  const domains = new Set<string>();
  const [contacts, watches] = await Promise.all([
    db.contact.findMany({ where: { ownerId }, select: { email: true } }),
    db.companyWatch.findMany({ where: { ownerId }, select: { domain: true } }),
  ]);
  for (const contact of contacts) {
    const domain = String(contact.email || '').split('@')[1];
    if (domain && !PERSONAL_EMAIL_DOMAINS.has(domain)) domains.add(domain);
  }
  for (const watch of watches) {
    if (watch.domain) domains.add(String(watch.domain));
  }
  for (const item of profile.exclusions) {
    const domain = normalizeDomain(item);
    if (domain) domains.add(domain);
  }
  return domains;
}

function matchesExclusion(
  profile: ProspectProfile,
  company: { name: string; domain: string },
) {
  const haystack = `${company.name} ${company.domain}`.toLowerCase();
  return profile.exclusions.some((item) => {
    const term = item.toLowerCase();
    return term.length >= 3 && haystack.includes(term);
  });
}

export async function runSearch(
  search: any,
  deps: RunDeps,
  limits: Limits,
): Promise<RunOutcome> {
  const { db, reader } = deps;
  const profile = normalizeProfile(search.profile);
  const callBudget = search.maxCompanies * 3 + 5;
  let calls = Number(search.counts?.geminiCalls) || 0;
  let failures = 0;

  const generate: GeminiJson = async (prompt) => {
    if (calls >= callBudget) throw new BudgetExceeded();
    calls++;
    return deps.generate(prompt);
  };
  const source = deps.createSource(generate);

  const saveProgress = async () => {
    const where = { searchId: search.id };
    const [companies, qualified, rejected, unreachable, people, withEmail] =
      await Promise.all([
        db.prospectCompany.count({ where }),
        db.prospectCompany.count({ where: { ...where, status: 'qualified' } }),
        db.prospectCompany.count({ where: { ...where, status: 'rejected' } }),
        db.prospectCompany.count({
          where: { ...where, status: 'unreachable' },
        }),
        db.prospect.count({ where }),
        db.prospect.count({ where: { ...where, emailStatus: 'published' } }),
      ]);
    await db.prospectSearch.update({
      where: { id: search.id },
      data: {
        counts: {
          companies,
          qualified,
          rejected,
          unreachable,
          people,
          withEmail,
          geminiCalls: calls,
        },
        heartbeatAt: new Date(),
      },
    });
  };

  const isCancelled = async () => {
    const current = await db.prospectSearch.findUnique({
      where: { id: search.id },
      select: { status: true },
    });
    return !current || current.status === 'cancelled';
  };

  const lookup = search.mode === 'companies';
  let note: string | undefined;

  try {
    if (search.stage === 'find') {
      let candidates;
      if (lookup) {
        const resolved = await resolveCompanies(generate, search.targets || []);
        candidates = resolved.candidates;
        if (resolved.unresolved.length) {
          note = `We could not find a website for ${resolved.unresolved.join(', ')}. Enter the domain instead, for example acme.com.`;
          await db.prospectSearch.update({
            where: { id: search.id },
            data: { note },
          });
        }
      } else {
        const exclude = await excludedDomains(db, search.ownerId, profile);
        candidates = await source.findCompanies({
          profile,
          limit: Math.min(search.maxCompanies * 2, MAX_CANDIDATES),
          exclude,
        });
      }
      for (const candidate of candidates) {
        await db.prospectCompany
          .create({
            data: {
              ownerId: search.ownerId,
              searchId: search.id,
              name: candidate.name,
              domain: candidate.domain,
              status: 'pending',
            },
          })
          .catch(() => undefined);
      }
      await db.prospectSearch.update({
        where: { id: search.id },
        data: { stage: 'qualify' },
      });
      await saveProgress();
    }

    const savePeople = async (
      company: any,
      people: VerifiedPerson[],
      score: number,
      reasons: string[],
    ) => {
      const chosen = rankPeople(people).slice(0, search.peoplePerCompany);
      const emails = chosen.flatMap((person) =>
        person.email ? [person.email] : [],
      );
      const existing = emails.length
        ? await db.contact.findMany({
            where: { ownerId: search.ownerId, email: { in: emails } },
            select: { email: true },
          })
        : [];
      const existingEmails = new Set(
        existing.map((contact: any) => String(contact.email)),
      );

      await db.prospect.deleteMany({
        where: {
          companyId: company.id,
          status: { in: ['ready', 'needs_email', 'duplicate'] },
        },
      });
      for (const person of chosen) {
        await db.prospect.create({
          data: {
            ownerId: search.ownerId,
            searchId: search.id,
            companyId: company.id,
            companyName: company.name,
            domain: company.domain,
            firstName: person.firstName,
            lastName: person.lastName,
            jobTitle: person.jobTitle,
            email: person.email || undefined,
            emailStatus: person.email ? 'published' : 'none',
            sourceUrl: person.sourceUrl,
            score,
            reasons,
            status: !person.email
              ? 'needs_email'
              : existingEmails.has(person.email)
                ? 'duplicate'
                : 'ready',
          },
        });
      }
      return chosen.length;
    };

    const processCompany = async (company: any) => {
      const reject = (status: string, reason: string, extra = {}) =>
        db.prospectCompany.update({
          where: { id: company.id },
          data: { status, reason, ...extra },
        });

      if (!lookup && matchesExclusion(profile, company)) {
        await reject('rejected', 'Matches an exclusion');
        return 'rejected';
      }
      const site = await reader.readSite(company.domain);
      if (!site.pages.length) {
        await reject(
          'unreachable',
          site.unreachableReason || 'Website unreachable',
        );
        return 'unreachable';
      }

      const analysis = await analyzeCompany(generate, profile, company, site, {
        peopleOnly: lookup,
      });
      const emailPattern = inferEmailPattern(analysis.people);

      if (lookup) {
        const saved = await savePeople(
          company,
          analysis.people,
          0,
          [analysis.summary].filter(Boolean),
        );
        await db.prospectCompany.update({
          where: { id: company.id },
          data: {
            status: 'qualified',
            reason: saved
              ? ''
              : 'No named people were found on the pages we could read. The team page may load with JavaScript or the site may not list its staff.',
            summary: analysis.summary,
            pages: site.pages.map((page) => page.url),
            emailPattern,
          },
        });
        return 'qualified';
      }

      const score = scoreCriteria(analysis.criteria);
      const verdictOf = (key: string) =>
        analysis.criteria.find((item) => item.key === key)?.verdict;
      const base = {
        summary: analysis.summary,
        criteria: analysis.criteria,
        score,
        pages: site.pages.map((page) => page.url),
      };

      let reason = '';
      if (analysis.excluded) reason = 'Matches an exclusion';
      else if (verdictOf('industry') === 'no') reason = 'Different industry';
      else if (verdictOf('location') === 'no')
        reason = 'Outside the target location';
      else if (score < QUALIFY_THRESHOLD) {
        reason = `Score ${score}% is below the ${QUALIFY_THRESHOLD}% threshold`;
      }
      if (reason) {
        await reject('rejected', reason, base);
        return 'rejected';
      }

      const reasons = [
        analysis.summary,
        ...analysis.criteria
          .filter((item) => item.verdict === 'yes' && item.evidence)
          .map((item) => `${item.label}: "${item.evidence}"`),
      ]
        .filter(Boolean)
        .slice(0, MAX_REASONS + 1);

      await savePeople(company, analysis.people, score, reasons);
      await db.prospectCompany.update({
        where: { id: company.id },
        data: { status: 'qualified', reason: '', emailPattern, ...base },
      });
      return 'qualified';
    };

    let qualified = await db.prospectCompany.count({
      where: { searchId: search.id, status: 'qualified' },
    });

    while (qualified < search.maxCompanies) {
      if (limits.signal.aborted || Date.now() > limits.deadline) {
        await saveProgress();
        return { status: 'paused', stage: 'qualify' };
      }
      if (await isCancelled()) {
        await saveProgress();
        return { status: 'cancelled', stage: 'qualify' };
      }

      const batch = await db.prospectCompany.findMany({
        where: { searchId: search.id, status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: Math.min(QUALIFY_CONCURRENCY, search.maxCompanies - qualified),
      });
      if (!batch.length) break;

      const results = await Promise.allSettled(batch.map(processCompany));
      let budgetHit = false;
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          failures = 0;
          if (result.value === 'qualified') qualified++;
          continue;
        }
        if (result.reason instanceof BudgetExceeded) {
          budgetHit = true;
          continue;
        }
        failures++;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          await saveProgress();
          return {
            status: 'failed',
            stage: 'qualify',
            error: `Analysis failed: ${result.reason?.message || 'unknown error'}`,
          };
        }
        await db.prospectCompany.update({
          where: { id: batch[index].id },
          data: { status: 'unreachable', reason: 'Could not be analyzed' },
        });
      }
      await saveProgress();
      if (budgetHit) {
        note = [note, 'Stopped at the cost limit for this search.']
          .filter(Boolean)
          .join(' ');
        break;
      }
    }

    await db.prospectCompany.deleteMany({
      where: { searchId: search.id, status: 'pending' },
    });
    await saveProgress();
    return { status: 'completed', stage: 'done', note };
  } catch (error: any) {
    await saveProgress().catch(() => undefined);
    if (error instanceof BudgetExceeded) {
      return {
        status: 'completed',
        stage: search.stage === 'find' ? 'find' : 'done',
        note: 'Stopped at the cost limit for this search.',
      };
    }
    return {
      status: 'failed',
      stage: search.stage,
      error: error?.message || 'The search failed.',
    };
  }
}

import { runSearch, RunDeps } from './search-runner';
import { WebsiteSource } from './sources/website.source';

function fakeDelegate(initial: any[] = [], uniqueDomain = false) {
  const rows = initial.map((row) => ({ ...row }));
  let tick = 0;
  const matches = (row: any, where: Record<string, any> = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'in' in value) {
        return value.in.includes(row[key]);
      }
      return row[key] === value;
    });
  return {
    rows,
    findMany: async ({ where, orderBy, take }: any = {}) => {
      let found = rows.filter((row) => matches(row, where));
      if (orderBy) {
        const [key, direction] = Object.entries(orderBy)[0] as [string, string];
        found = [...found].sort((a, b) =>
          direction === 'desc' ? b[key] - a[key] : a[key] - b[key],
        );
      }
      return (take ? found.slice(0, take) : found).map((row) => ({ ...row }));
    },
    findUnique: async ({ where }: any) => {
      const row = rows.find((item) => matches(item, where));
      return row ? { ...row } : null;
    },
    findFirst: async ({ where }: any = {}) => {
      const row = rows.find((item) => matches(item, where));
      return row ? { ...row } : null;
    },
    count: async ({ where }: any = {}) =>
      rows.filter((row) => matches(row, where)).length,
    create: async ({ data }: any) => {
      if (
        uniqueDomain &&
        rows.some(
          (row) => row.searchId === data.searchId && row.domain === data.domain,
        )
      ) {
        throw new Error('duplicate key');
      }
      const row = { id: `id-${rows.length + 1}`, createdAt: tick++, ...data };
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }: any) => {
      const row = rows.find((item) => matches(item, where));
      if (!row) return null;
      Object.assign(row, data);
      return { ...row };
    },
    deleteMany: async ({ where }: any) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) {
          rows.splice(i, 1);
          count++;
        }
      }
      return { count };
    },
  };
}

const ACME_PAGE =
  'Acme builds software for banks. 450 engineers. Offices in Pune. Priya Sharma, VP HR. priya.sharma@acme.com. Rahul Iyer, Head of Talent. Made Up, CEO.';
const NOPE_PAGE = 'Nope sells garden furniture.';

function setup(
  options: { companies?: any[]; contacts?: any[]; stage?: string } = {},
) {
  const search = {
    id: 's1',
    ownerId: 'u1',
    maxCompanies: 5,
    peoplePerCompany: 2,
    status: 'running',
    stage: options.stage || 'find',
    counts: {},
    profile: {
      industries: ['banking software'],
      companySize: { min: 200, max: 1000 },
      locations: ['India'],
      jobTitles: ['HR head'],
    },
  };
  const db = {
    prospectSearch: fakeDelegate([search]),
    prospectCompany: fakeDelegate(options.companies || [], true),
    prospect: fakeDelegate(),
    contact: fakeDelegate(options.contacts || []),
    companyWatch: fakeDelegate(),
  };
  const sites: Record<string, any> = {
    'acme.com': {
      pages: [{ url: 'https://acme.com/team', text: ACME_PAGE }],
      emails: ['priya.sharma@acme.com'],
    },
    'nope.com': {
      pages: [{ url: 'https://nope.com/', text: NOPE_PAGE }],
      emails: [],
    },
    'dead.com': {
      pages: [],
      emails: [],
      unreachableReason: 'Website unreachable',
    },
  };
  const answers: Record<string, any> = {
    'acme.com': {
      summary: 'Acme makes banking software.',
      excluded: false,
      criteria: {
        industry: {
          verdict: 'yes',
          evidence: 'Acme builds software for banks',
          url: 'https://acme.com/team',
        },
        size: {
          verdict: 'yes',
          evidence: '450 engineers',
          url: 'https://acme.com/team',
        },
        location: {
          verdict: 'yes',
          evidence: 'Offices in Pune',
          url: 'https://acme.com/team',
        },
      },
      people: [
        {
          firstName: 'Priya',
          lastName: 'Sharma',
          jobTitle: 'VP HR',
          email: 'priya.sharma@acme.com',
          url: 'https://acme.com/team',
          relevant: true,
        },
        {
          firstName: 'Rahul',
          lastName: 'Iyer',
          jobTitle: 'Head of Talent',
          email: 'rahul.iyer@acme.com',
          url: 'https://acme.com/team',
          relevant: true,
        },
        {
          firstName: 'Ghost',
          lastName: 'Writer',
          jobTitle: 'HR',
          email: 'ghost@acme.com',
          relevant: true,
        },
      ],
    },
    'nope.com': {
      summary: 'Sells furniture.',
      excluded: false,
      criteria: {
        industry: {
          verdict: 'yes',
          evidence: 'We are a leading bank',
          url: 'https://nope.com/',
        },
      },
      people: [],
    },
  };
  const generate = jest.fn(async (prompt: string) => {
    if (prompt.startsWith('List real companies')) {
      return {
        companies: [
          { name: 'Acme', domain: 'https://www.acme.com' },
          { name: 'Nope', domain: 'nope.com' },
          { name: 'Dead', domain: 'dead.com' },
          { name: 'Known', domain: 'known.com' },
          { name: 'Bad', domain: '10.0.0.1' },
        ],
      };
    }
    const domain = /Company: .* \((.+)\)/.exec(prompt)?.[1] || '';
    return answers[domain];
  });
  const deps: RunDeps = {
    db: db as any,
    generate,
    reader: {
      readSite: jest.fn(async (domain: string) => sites[domain]),
    },
    createSource: (counted) => new WebsiteSource(counted),
  };
  const run = (
    overrides: Partial<{ signal: AbortSignal; deadline: number }> = {},
  ) =>
    runSearch(search, deps, {
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      ...overrides,
    });
  return { db, deps, generate, run, search };
}

describe('runSearch', () => {
  it('finds, qualifies and verifies prospects end to end', async () => {
    const { db, run } = setup({
      contacts: [{ id: 'c1', ownerId: 'u1', email: 'someone@known.com' }],
    });
    const outcome = await run();

    expect(outcome).toMatchObject({ status: 'completed', stage: 'done' });

    const byDomain = Object.fromEntries(
      db.prospectCompany.rows.map((row) => [row.domain, row]),
    );
    expect(Object.keys(byDomain).sort()).toEqual([
      'acme.com',
      'dead.com',
      'nope.com',
    ]);
    expect(byDomain['acme.com']).toMatchObject({
      status: 'qualified',
      score: 100,
    });
    expect(byDomain['nope.com']).toMatchObject({ status: 'rejected' });
    expect(byDomain['nope.com'].criteria[0].verdict).toBe('unknown');
    expect(byDomain['dead.com']).toMatchObject({ status: 'unreachable' });

    const people = db.prospect.rows;
    expect(
      people.map((row) => `${row.firstName} ${row.lastName}`).sort(),
    ).toEqual(['Priya Sharma', 'Rahul Iyer']);
    const priya = people.find((row) => row.firstName === 'Priya');
    expect(priya).toMatchObject({
      email: 'priya.sharma@acme.com',
      emailStatus: 'published',
      status: 'ready',
    });
    const rahul = people.find((row) => row.firstName === 'Rahul');
    expect(rahul.email).toBeUndefined();
    expect(rahul.status).toBe('needs_email');

    expect(db.prospectSearch.rows[0].counts).toMatchObject({
      companies: 3,
      qualified: 1,
      rejected: 1,
      unreachable: 1,
      people: 2,
      withEmail: 1,
    });
  });

  it('marks a person who is already a contact as a duplicate', async () => {
    const { db, run } = setup({
      stage: 'qualify',
      companies: [
        {
          id: 'k1',
          ownerId: 'u1',
          searchId: 's1',
          name: 'Acme',
          domain: 'acme.com',
          status: 'pending',
        },
      ],
      contacts: [{ id: 'c1', ownerId: 'u1', email: 'priya.sharma@acme.com' }],
    });
    await run();
    const priya = db.prospect.rows.find((row) => row.firstName === 'Priya');
    expect(priya.status).toBe('duplicate');
  });

  it('pauses at the deadline and resumes without repeating work', async () => {
    const { db, deps, run } = setup();
    const paused = await run({ deadline: Date.now() - 1 });
    expect(paused).toMatchObject({ status: 'paused', stage: 'qualify' });
    expect(
      db.prospectCompany.rows.every((row) => row.status === 'pending'),
    ).toBe(true);

    const search = (await db.prospectSearch.findUnique({
      where: { id: 's1' },
    }))!;
    search.stage = 'qualify';
    const finished = await runSearch(search, deps, {
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
    });
    expect(finished.status).toBe('completed');
    const findCalls = (deps.generate as jest.Mock).mock.calls.filter(
      ([prompt]) => String(prompt).startsWith('List real companies'),
    );
    expect(findCalls).toHaveLength(1);
  });

  it('stops when the search was cancelled', async () => {
    const { db, run } = setup();
    db.prospectSearch.rows[0].status = 'cancelled';
    const outcome = await run();
    expect(outcome.status).toBe('cancelled');
    expect(db.prospect.rows).toHaveLength(0);
  });

  it('fails after repeated analysis errors', async () => {
    const { deps, run } = setup();
    const original = deps.generate as jest.Mock;
    original.mockImplementation(async (prompt: string) => {
      if (prompt.startsWith('List real companies')) {
        return {
          companies: ['a', 'b', 'c', 'd'].map((name) => ({
            name,
            domain: `${name}.com`,
          })),
        };
      }
      throw new Error('API key not valid');
    });
    (deps.reader.readSite as jest.Mock).mockResolvedValue({
      pages: [{ url: 'https://x.com/', text: 'text' }],
      emails: [],
    });
    const outcome = await run();
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('API key not valid');
  });

  it('stops at the Gemini call budget', async () => {
    const { db, run, search } = setup();
    search.counts = { geminiCalls: search.maxCompanies * 3 + 5 };
    const outcome = await run();
    expect(outcome.status).toBe('completed');
    expect(outcome.note).toMatch(/cost limit/);
    expect(db.prospectCompany.rows).toHaveLength(0);
  });
});

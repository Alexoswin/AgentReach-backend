import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProspectsService } from './prospects.service';

function makeService() {
  const prospects: any[] = [];
  const db: any = {
    prospect: {
      findMany: jest.fn(async ({ where }: any) =>
        prospects.filter(
          (row) =>
            row.ownerId === where.ownerId && where.id.in.includes(row.id),
        ),
      ),
      findUnique: jest.fn(
        async ({ where }: any) =>
          prospects.find((row) => row.id === where.id) || null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = prospects.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    contact: { findMany: jest.fn(async () => []) },
    prospectSearch: {
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: any) => ({ id: 's1', ...data })),
      findUnique: jest.fn(),
      findFirst: jest.fn(async () => null),
      update: jest.fn(),
    },
  };
  const contacts = {
    importContacts: jest.fn(async () => ({
      importedCount: 1,
      updatedCount: 0,
      skippedCount: 0,
      errors: [],
    })),
  };
  const service = new ProspectsService(
    db,
    { getRawSettings: jest.fn(async () => ({ geminiApiKey: 'key' })) } as any,
    contacts as any,
    { create: jest.fn() } as any,
  );
  return { service, db, contacts, prospects };
}

const prospect = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  ownerId: 'u1',
  firstName: 'Priya',
  lastName: 'Sharma',
  jobTitle: 'VP HR',
  email: 'priya.sharma@acme.com',
  companyName: 'Acme',
  domain: 'acme.com',
  sourceUrl: 'https://acme.com/team',
  score: 88,
  status: 'ready',
  ...overrides,
});

describe('ProspectsService', () => {
  it('imports ready prospects with their source and keeps the rest out', async () => {
    const { service, db, contacts, prospects } = makeService();
    prospects.push(
      prospect(),
      prospect({ id: 'p2', email: undefined, status: 'needs_email' }),
    );
    db.contact.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c1', email: 'priya.sharma@acme.com' }]);

    const result = await service.addToContacts('u1', {
      ids: ['p1', 'p2'],
      directoryId: 'd1',
    });

    const [dto, userId] = contacts.importContacts.mock.calls[0] as any;
    expect(userId).toBe('u1');
    expect(dto.directoryId).toBe('d1');
    expect(dto.rows).toHaveLength(1);
    expect(dto.rows[0]).toMatchObject({
      email: 'priya.sharma@acme.com',
      company: 'Acme',
      prospectSource: 'https://acme.com/team',
    });
    expect(dto.rows[0].notes).toContain('88% match');
    expect(result.added).toBe(1);
    expect(result.skipped).toEqual([
      { id: 'p2', reason: 'Needs a verified work email first' },
    ]);
    expect(prospects[0]).toMatchObject({
      status: 'added',
      contactId: 'c1',
      expireAt: null,
    });
  });

  it('carries the phone and LinkedIn profile into Contacts', async () => {
    const { service, db, contacts, prospects } = makeService();
    prospects.push(
      prospect({
        phone: '+919123456789',
        linkedinUrl: 'https://www.linkedin.com/in/priya-sharma',
      }),
    );
    db.contact.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c1', email: 'priya.sharma@acme.com' }]);

    await service.addToContacts('u1', { ids: ['p1'] });

    const [dto] = contacts.importContacts.mock.calls[0] as any;
    expect(dto.rows[0]).toMatchObject({
      phoneNumber: '+919123456789',
      linkedinUrl: 'https://www.linkedin.com/in/priya-sharma',
    });
    expect(dto.mapping).toMatchObject({
      phoneNumber: 'phoneNumber',
      linkedinUrl: 'linkedinUrl',
    });
  });

  it('flags prospects that were already contacts', async () => {
    const { service, db, prospects } = makeService();
    prospects.push(prospect());
    db.contact.findMany.mockResolvedValue([
      { id: 'c9', email: 'priya.sharma@acme.com' },
    ]);
    const result = await service.addToContacts('u1', { ids: ['p1'] });
    expect(result.duplicates).toBe(1);
    expect(prospects[0].status).toBe('duplicate');
  });

  it('only accepts a work email at the company domain', async () => {
    const { service, prospects } = makeService();
    prospects.push(
      prospect({
        email: undefined,
        status: 'needs_email',
        emailStatus: 'none',
      }),
    );
    await expect(
      service.updateProspect('u1', 'p1', { email: 'priya@gmail.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const updated = await service.updateProspect('u1', 'p1', {
      email: 'Priya@acme.com',
    });
    expect(updated).toMatchObject({ email: 'priya@acme.com', status: 'ready' });
  });

  it('creates a company lookup from names and domains', async () => {
    const { service, db } = makeService();
    await service.createSearch('u1', {
      mode: 'companies',
      companies: [' acme.com ', 'Globex Corp', 'acme.com', ''],
      profile: { jobTitles: ['Head of HR'] },
    });
    const data = db.prospectSearch.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      mode: 'companies',
      targets: ['acme.com', 'Globex Corp'],
      maxCompanies: 2,
      peoplePerCompany: 5,
      description: 'Contacts at acme.com, Globex Corp',
    });
    expect(data.profile.jobTitles).toEqual(['Head of HR']);
  });

  it('requires a company for a lookup and a description for a search', async () => {
    const { service } = makeService();
    await expect(
      service.createSearch('u1', { mode: 'companies', companies: [' '] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createSearch('u1', { description: 'short', profile: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('limits searches per day', async () => {
    const { service, db } = makeService();
    db.prospectSearch.count.mockResolvedValue(10);
    await expect(
      service.createSearch('u1', {
        description: 'HR heads at IT companies',
        profile: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to run two searches at once', async () => {
    const { service, db } = makeService();
    db.prospectSearch.findUnique.mockResolvedValue({
      id: 's1',
      ownerId: 'u1',
      status: 'paused',
    });
    db.prospectSearch.findFirst.mockResolvedValue({
      id: 's2',
      status: 'running',
      heartbeatAt: new Date(),
    });
    await expect(
      service.run('u1', 's1', new AbortController().signal),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

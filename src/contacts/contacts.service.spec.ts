import { BadRequestException } from '@nestjs/common';
import { ContactsService } from './contacts.service';

function createDelegate(records: any[] = []) {
  const matches = (item: any, where: any = {}) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === 'object' && 'in' in value
        ? (value as { in: unknown[] }).in.includes(item[key])
        : item[key] === value,
    );
  return {
    records,
    findUnique: jest.fn(
      async ({ where }) => records.find((item) => matches(item, where)) || null,
    ),
    findFirst: jest.fn(
      async ({ where }) => records.find((item) => matches(item, where)) || null,
    ),
    findMany: jest.fn(async ({ where }: any = {}) =>
      records.filter((item) => matches(item, where)),
    ),
    create: jest.fn(async ({ data }) => {
      const item = { id: `${records.length + 1}`, ...data };
      records.push(item);
      return item;
    }),
    update: jest.fn(async ({ where, data }) => {
      const index = records.findIndex((item) => matches(item, where));
      if (index < 0) return null;
      records[index] = { ...records[index], ...data };
      return records[index];
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      let count = 0;
      records.forEach((item, index) => {
        if (!matches(item, where)) return;
        records[index] = { ...item, ...data };
        count++;
      });
      return { count };
    }),
    delete: jest.fn(async ({ where }) => {
      const index = records.findIndex((item) => matches(item, where));
      return index < 0 ? null : records.splice(index, 1)[0];
    }),
  };
}

function createService() {
  const db = {
    contact: createDelegate(),
    contactDirectory: createDelegate(),
  };
  const watches = { ensureWatchesForEmails: jest.fn(async () => 0) };
  const service = new ContactsService(db as any, watches as any);
  return { service, db, watches };
}

const jane = { firstName: 'Jane', lastName: 'Doe', email: 'Jane@Acme.com' };

describe('ContactsService', () => {
  it("lists only the caller's own contacts and directories", async () => {
    const { service } = createService();
    await service.create(jane, 'user-1');
    await service.createDirectory({ name: 'Leads' }, 'user-1');

    await expect(service.findAll('user-1')).resolves.toHaveLength(1);
    await expect(service.findAll('user-2')).resolves.toEqual([]);
    await expect(service.findDirectories('user-2')).resolves.toEqual([]);
  });

  it('lets two users keep a contact with the same email', async () => {
    const { service, db, watches } = createService();
    await service.create(jane, 'user-1');
    await service.create(jane, 'user-2');

    expect(db.contact.records.map((c) => c.ownerId)).toEqual([
      'user-1',
      'user-2',
    ]);
    expect(watches.ensureWatchesForEmails).toHaveBeenLastCalledWith(
      [{ email: 'jane@acme.com', company: undefined }],
      'user-2',
    );
    await expect(service.create(jane, 'user-1')).rejects.toThrow(
      'A contact with this email already exists',
    );
  });

  it("cannot read, change or delete another user's contact", async () => {
    const { service, db } = createService();
    const contact = await service.create(jane, 'user-1');

    for (const attempt of [
      service.findOne(contact.id, 'user-2'),
      service.update(contact.id, { firstName: 'Mallory' }, 'user-2'),
      service.remove(contact.id, 'user-2'),
    ]) {
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(db.contact.records[0]).toMatchObject({
      firstName: 'Jane',
      ownerId: 'user-1',
    });
  });

  it('keeps ownership when an update body carries an ownerId', async () => {
    const { service, db } = createService();
    const contact = await service.create(jane, 'user-1');

    await service.update(
      contact.id,
      { firstName: 'Janet', ownerId: 'user-2' } as any,
      'user-1',
    );

    expect(db.contact.records[0]).toMatchObject({
      firstName: 'Janet',
      ownerId: 'user-1',
    });
  });

  it("rejects another user's directory on create and import", async () => {
    const { service } = createService();
    const directory = await service.createDirectory(
      { name: 'Leads' },
      'user-1',
    );

    await expect(
      service.create({ ...jane, directoryId: directory.id }, 'user-2'),
    ).rejects.toThrow('Directory not found');
    await expect(
      service.importContacts(
        {
          rows: [{ email: 'a@b.com', first: 'A' }],
          mapping: { email: 'email', firstName: 'first' },
          directoryId: directory.id,
        } as any,
        'user-2',
      ),
    ).rejects.toThrow('Directory not found');
  });

  it("imports into the caller's account without touching other users", async () => {
    const { service, db } = createService();
    await service.create(jane, 'user-1');

    const result = await service.importContacts(
      {
        rows: [{ email: 'jane@acme.com', first: 'Imported' }],
        mapping: { email: 'email', firstName: 'first' },
        duplicateStrategy: 'OVERWRITE',
      } as any,
      'user-2',
    );

    expect(result).toMatchObject({ importedCount: 1, updatedCount: 0 });
    expect(db.contact.records).toEqual([
      expect.objectContaining({ ownerId: 'user-1', firstName: 'Jane' }),
      expect.objectContaining({ ownerId: 'user-2', firstName: 'Imported' }),
    ]);
  });
});

import { ContactsService } from './contacts.service';

describe('ContactsService.findAll pagination', () => {
  const build = () => {
    const findMany = jest.fn(async (..._args: any[]) => [{ id: 'c1' }]);
    const count = jest.fn(async () => 120);
    const service = new ContactsService(
      { contact: { findMany, count } } as any,
      {} as any,
    );
    return { service, findMany, count };
  };

  it('returns the full array when no page or limit is sent', async () => {
    const { service, findMany, count } = build();
    const result = await service.findAll('u1');
    expect(result).toEqual([{ id: 'c1' }]);
    expect(count).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0][0]).not.toHaveProperty('take');
  });

  it('returns an envelope and queries skip/take for a page', async () => {
    const { service, findMany } = build();
    const result: any = await service.findAll('u1', { page: 3, limit: 50 });
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 100, take: 50 });
    expect(result).toMatchObject({
      total: 120,
      page: 3,
      limit: 50,
      totalPages: 3,
    });
  });

  it('filters unassigned contacts and escapes the search term', async () => {
    const { service, findMany } = build();
    await service.findAll('u1', {
      page: 1,
      limit: 10,
      directoryId: 'uncategorized',
      search: 'a.b(',
    });
    const where = (findMany.mock.calls[0] as any)[0].where;
    expect(where.directoryId).toBeNull();
    expect(where.ownerId).toBe('u1');
    expect(where.$or[0].firstName.$regex).toBe('a\\.b\\(');
  });
});

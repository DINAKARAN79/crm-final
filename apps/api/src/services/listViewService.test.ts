import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  savedViews: vi.fn(),
  preference: vi.fn(),
  pins: vi.fn(),
  recents: vi.fn(),
  users: vi.fn(),
  leadInterest: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    savedListView: { findMany: mocks.savedViews },
    listViewPreference: { findUnique: mocks.preference },
    listViewPin: { findMany: mocks.pins },
    listViewRecent: { findMany: mocks.recents },
    user: { findMany: mocks.users },
    fieldDefinition: { findFirst: mocks.leadInterest },
  },
}));

import { listViewCatalog } from './listViewService';

describe('Lead list-view picklist configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.savedViews.mockResolvedValue([]);
    mocks.preference.mockResolvedValue(null);
    mocks.pins.mockResolvedValue([]);
    mocks.recents.mockResolvedValue([]);
    mocks.users.mockResolvedValue([]);
    mocks.leadInterest.mockResolvedValue({
      picklistValues: [
        { value: 'HOT', label: 'Hot' },
        { value: 'WARM', label: 'Warm' },
      ],
    });
  });

  it('loads active Lead Interest options for the signed-in tenant', async () => {
    const catalog = await listViewCatalog(
      { id: 'user-a', tenantId: 'tenant-a', isAdmin: false },
      'LEAD',
    );

    expect(mocks.leadInterest).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: 'tenant-a',
        name: 'leadInterest',
        object: { is: expect.objectContaining({ tenantId: 'tenant-a' }) },
      }),
    }));
    expect(catalog.fields.find((field) => field.key === 'leadInterest')?.options).toEqual([
      { value: 'HOT', label: 'Hot' },
      { value: 'WARM', label: 'Warm' },
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findObject: vi.fn(),
  findFields: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    objectDefinition: { findFirst: mocks.findObject },
    fieldDefinition: { findMany: mocks.findFields },
  },
}));

import { getLeadPicklistOptions, validateLeadPicklists } from './leadPicklists';

describe('Lead picklist configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads configured fields for the authenticated tenant only', async () => {
    mocks.findObject.mockResolvedValue({ id: 'lead-object' });
    mocks.findFields.mockResolvedValue([
      { name: 'source', required: false, picklistValues: [{ value: 'WEBSITE' }] },
      { name: 'firstCampaign', required: false, picklistValues: [{ value: 'SUMMER' }] },
      { name: 'lastCampaign', required: false, picklistValues: [{ value: 'FOLLOW_UP' }] },
      { name: 'leadInterest', required: true, picklistValues: [{ value: 'HOT' }] },
    ]);

    const options = await getLeadPicklistOptions('tenant-a');

    expect(mocks.findObject).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', name: { equals: 'Lead', mode: 'insensitive' } },
      select: { id: true },
    });
    expect(mocks.findFields).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'tenant-a', objectId: 'lead-object' }),
    }));
    expect(options.get('firstCampaign')?.has('SUMMER')).toBe(true);
    expect(options.get('leadInterest')?.has('HOT')).toBe(true);
    expect(options.requiredFields.has('leadInterest')).toBe(true);
  });

  it('accepts empty optional picklists and rejects values not configured for the tenant', () => {
    const options = new Map([
      ['source', new Set(['WEBSITE'])],
      ['firstCampaign', new Set(['SUMMER'])],
      ['lastCampaign', new Set(['FOLLOW_UP'])],
      ['leadInterest', new Set(['HOT'])],
    ]) as Awaited<ReturnType<typeof getLeadPicklistOptions>>;
    options.requiredFields = new Set(['leadInterest']);

    expect(validateLeadPicklists({ source: 'WEBSITE', firstCampaign: '' }, options)).toBeNull();
    expect(validateLeadPicklists({ leadInterest: 'COLD' }, options)).toEqual({
      field: 'leadInterest',
      message: 'Select a configured value for Lead Interest.',
    });
    expect(validateLeadPicklists({}, options, { validateRequired: true })).toEqual({
      field: 'leadInterest',
      message: 'Lead Interest is required.',
    });
    expect(validateLeadPicklists({}, options, { validateRequired: true, partial: true })).toBeNull();
    expect(validateLeadPicklists({ leadInterest: '' }, options, { validateRequired: true, partial: true })).toEqual({
      field: 'leadInterest',
      message: 'Lead Interest is required.',
    });
  });
});

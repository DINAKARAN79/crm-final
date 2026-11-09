import { describe, expect, it } from 'vitest';
import { parseFilterLogic } from '@dct-crm/shared';
import { compileListFilters, publicFields, systemViewsFor, validateFilterSet } from './listViewCatalog';

const noon = new Date('2026-10-28T06:30:00.000Z');

describe('list view catalog', () => {
  it('exposes Lead Interest as a configurable picklist filter', () => {
    const field = publicFields('LEAD').find((item) => item.key === 'leadInterest');
    expect(field).toMatchObject({
      label: 'Lead Interest',
      kind: 'string',
      operators: expect.arrayContaining(['equals']),
    });
  });

  it('keeps each module’s views separate', () => {
    const leads = systemViewsFor('LEAD').map((view) => view.name);
    const followUps = systemViewsFor('FOLLOW_UP').map((view) => view.name);
    expect(leads).toContain('My Leads');
    expect(leads).not.toContain('My Missed Follow-ups');
    expect(followUps).toContain('All Follow-ups');
    expect(followUps.every((name) => !leads.includes(name) || name.startsWith('Recently Viewed'))).toBe(true);
    expect(systemViewsFor('UNIT').map((view) => view.name)).toContain('On-Hold Units');
    expect(systemViewsFor('MIS_APPROVAL').map((view) => view.name)).toContain('Pending Approvals');
  });

  it('rejects a filter field from another module', () => {
    const result = validateFilterSet('LEAD', {
      logic: 'AND',
      rules: [{ field: 'dueDate', operator: 'equals', value: '2026-10-28' }],
    });
    expect(result.ok).toBe(false);
  });

  it('filters my leads by the signed-in user and today’s IST day', () => {
    const filters = validateFilterSet('LEAD', {
      logic: 'AND',
      rules: [
        { field: 'ownerId', operator: 'equals', value: '$currentUser' },
        { field: 'createdAt', operator: 'equals', value: '$today' },
      ],
    });
    expect(filters.ok).toBe(true);
    if (!filters.ok) return;
    expect(compileListFilters('LEAD', filters.filters, { userId: 'user-123', now: noon })).toEqual({
      AND: [
        { ownerId: 'user-123' },
        { createdAt: { gte: new Date('2026-10-27T18:30:00.000Z'), lt: new Date('2026-10-28T18:30:00.000Z') } },
      ],
    });
  });

  it('uses booked status for converted leads and excludes booked and lost from open leads', () => {
    const converted = systemViewsFor('LEAD').find((view) => view.name === 'Converted Leads');
    expect(compileListFilters('LEAD', converted!.filters, { userId: 'user-123' })).toEqual({ status: 'BOOKED' });
    const open = systemViewsFor('LEAD').find((view) => view.name === 'Open Leads');
    expect(compileListFilters('LEAD', open!.filters, { userId: 'user-123', presets: open!.preset ? [open!.preset] : [] })).toEqual({
      status: { notIn: ['BOOKED', 'LOST'] },
    });
  });

  it('includes the whole selected day for a date equals filter', () => {
    const filters = validateFilterSet('SITE_VISIT', {
      logic: 'AND',
      rules: [{ field: 'scheduledAt', operator: 'equals', value: '2026-10-16' }],
    });
    expect(filters.ok).toBe(true);
    if (!filters.ok) return;
    expect(compileListFilters('SITE_VISIT', filters.filters, { userId: 'user-123' })).toEqual({
      scheduledAt: { gte: new Date('2026-10-15T18:30:00.000Z'), lt: new Date('2026-10-16T18:30:00.000Z') },
    });
  });

  it('uses the tenant timezone for date filters', () => {
    const filters = validateFilterSet('SITE_VISIT', {
      logic: 'AND',
      rules: [{ field: 'scheduledAt', operator: 'equals', value: '2026-10-28' }],
    });
    expect(filters.ok).toBe(true);
    if (!filters.ok) return;
    expect(compileListFilters('SITE_VISIT', filters.filters, {
      userId: 'user-123',
      timeZone: 'America/New_York',
    })).toEqual({
      scheduledAt: { gte: new Date('2026-10-28T04:00:00.000Z'), lt: new Date('2026-10-29T04:00:00.000Z') },
    });
  });

  it('compiles custom lead logic and an owner filter without raw input', () => {
    const filters = validateFilterSet('LEAD', {
      version: 2,
      ownerFilter: 'MINE',
      ownerUserIds: [],
      filterLogic: '1 and (2 or 3)',
      rules: [
        { id: 1, field: 'status', operator: 'equals', value: 'NEW' },
        { id: 2, field: 'source', operator: 'equals', value: 'WEBSITE' },
        { id: 3, field: 'company', operator: 'contains', value: 'Acme' },
      ],
    });
    expect(filters.ok).toBe(true);
    if (!filters.ok) return;
    expect(filters.filters.filterLogic).toBe('1 AND (2 OR 3)');
    expect(compileListFilters('LEAD', filters.filters, { userId: 'user-123', now: noon })).toEqual({
      AND: [
        { ownerId: 'user-123' },
        {
          AND: [
            { status: 'NEW' },
            {
              OR: [
                { source: 'WEBSITE' },
                { company: { contains: 'Acme', mode: 'insensitive' } },
              ],
            },
          ],
        },
      ],
    });
  });

  it('treats a lead view without custom logic as AND', () => {
    const filters = validateFilterSet('LEAD', {
      version: 2,
      ownerFilter: 'ALL',
      filterLogic: null,
      rules: [
        { id: 1, field: 'status', operator: 'equals', value: 'NEW' },
        { id: 2, field: 'email', operator: 'contains', value: 'acme.com' },
      ],
    });
    expect(filters.ok).toBe(true);
    if (!filters.ok) return;
    expect(filters.filters.filterLogic).toBeNull();
    expect(compileListFilters('LEAD', filters.filters, { userId: 'user-123' })).toEqual({
      AND: [
        { status: 'NEW' },
        { email: { contains: 'acme.com', mode: 'insensitive' } },
      ],
    });
  });

  it('rejects filter logic that skips, repeats, or invents a row', () => {
    const base = {
      version: 2,
      ownerFilter: 'ALL',
      rules: [
        { id: 1, field: 'status', operator: 'equals', value: 'NEW' },
        { id: 2, field: 'source', operator: 'equals', value: 'WEBSITE' },
      ],
    };
    expect(validateFilterSet('LEAD', { ...base, filterLogic: '1 AND 1' }).ok).toBe(false);
    expect(validateFilterSet('LEAD', { ...base, filterLogic: '1 OR 3' }).ok).toBe(false);
    expect(validateFilterSet('LEAD', { ...base, filterLogic: '1 AND' }).ok).toBe(false);
    expect(validateFilterSet('LEAD', { ...base, filterLogic: '(1 OR 2' }).ok).toBe(false);
    expect(validateFilterSet('LEAD', { ...base, filterLogic: '1 AND drop table' }).ok).toBe(false);
    expect(parseFilterLogic('1 AND (2 OR 3)', [1, 2, 3]).ok).toBe(true);
  });
});

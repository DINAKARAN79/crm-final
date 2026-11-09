import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  siteVisitFindMany: vi.fn(),
  siteVisitUpdateMany: vi.fn(),
  auditLogCreate: vi.fn(),
  tenantFindMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

const tagging = vi.hoisted(() => ({
  tagLeadSiteVisitEvents: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    siteVisit: { findMany: database.siteVisitFindMany },
    tenant: { findMany: database.tenantFindMany, findUnique: database.tenantFindUnique },
    $transaction: database.transaction,
  },
}));

vi.mock('./leadEventTagging', () => tagging);

import {
  crmDayRange,
  executeSiteVisitMissedJob,
  missedJobDecision,
  normalizeOverdueSiteVisits,
} from './siteVisitMissedJob';

const sixPm = new Date('2026-10-17T12:30:00.000Z');
const beforeSixPm = new Date('2026-10-17T12:29:00.000Z');

describe('site visit missed job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        siteVisit: { updateMany: database.siteVisitUpdateMany },
        auditLog: { create: database.auditLogCreate },
      }),
    );
    database.siteVisitFindMany.mockResolvedValue([]);
    database.siteVisitUpdateMany.mockResolvedValue({ count: 1 });
    database.tenantFindMany.mockResolvedValue([{ id: 'tenant-1' }]);
    database.tenantFindUnique.mockResolvedValue({ timezone: 'Asia/Kolkata' });
  });

  it('keeps a scheduled visit unchanged before 6 PM even when its appointment time has passed', async () => {
    const updated = await normalizeOverdueSiteVisits('tenant-1', beforeSixPm);

    expect(updated).toBe(0);
    expect(database.siteVisitFindMany).not.toHaveBeenCalled();
    expect(database.siteVisitUpdateMany).not.toHaveBeenCalled();
  });

  it('uses the tenant-local day and cutoff for site visits', () => {
    const instant = new Date('2026-07-02T01:00:00.000Z');
    const range = crmDayRange(instant, 'America/Los_Angeles');
    expect(range).toEqual({
      dateKey: '2026-07-01',
      start: new Date('2026-07-01T07:00:00.000Z'),
      end: new Date('2026-07-02T07:00:00.000Z'),
    });
    expect(missedJobDecision(instant, null, 'America/Los_Angeles')).toEqual({ run: true, dateKey: '2026-07-01' });
  });

  it('marks incomplete visits scheduled for the current day as missed at 6 PM', async () => {
    const today = new Date('2026-10-17T04:30:00.000Z');
    database.siteVisitFindMany.mockResolvedValue([
      { id: 'visit-today', leadId: 'lead-1', scheduledAt: today },
    ]);

    const updated = await normalizeOverdueSiteVisits('tenant-1', sixPm);

    const { start, end } = crmDayRange(sixPm);
    expect(updated).toBe(1);
    expect(database.siteVisitFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: 'tenant-1',
        status: 'SCHEDULED',
        scheduledAt: { gte: start, lt: end },
      },
    }));
    expect(start.toISOString()).toBe('2026-10-16T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-10-17T18:30:00.000Z');
    expect(database.siteVisitUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'visit-today', tenantId: 'tenant-1', status: 'SCHEDULED' },
      data: { status: 'MISSED', missedAt: expect.any(Date) },
    }));
    expect(database.auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'SITE_VISIT_MISSED',
        objectType: 'SiteVisit',
        objectId: 'visit-today',
        newValues: expect.objectContaining({ status: 'MISSED' }),
      }),
    }));
  });

  it('does not change a visit that was completed before the update', async () => {
    database.siteVisitFindMany.mockResolvedValue([
      { id: 'visit-completed', leadId: 'lead-1', scheduledAt: new Date('2026-10-17T04:30:00.000Z') },
    ]);
    database.siteVisitUpdateMany.mockResolvedValue({ count: 0 });

    const updated = await normalizeOverdueSiteVisits('tenant-1', sixPm);

    expect(updated).toBe(0);
    expect(database.siteVisitUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'SCHEDULED' }),
    }));
    expect(database.auditLogCreate).not.toHaveBeenCalled();
    expect(tagging.tagLeadSiteVisitEvents).not.toHaveBeenCalled();
  });

  it('does not select visits scheduled on another date', async () => {
    await normalizeOverdueSiteVisits('tenant-1', sixPm);

    const { start, end } = crmDayRange(sixPm);
    const yesterday = new Date('2026-10-16T04:30:00.000Z');
    const tomorrow = new Date('2026-10-18T04:30:00.000Z');
    expect(yesterday.getTime()).toBeLessThan(start.getTime());
    expect(tomorrow.getTime()).toBeGreaterThanOrEqual(end.getTime());
    expect(database.siteVisitFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        scheduledAt: { gte: start, lt: end },
      }),
    }));
  });

  it('does not record another missed update when the trigger runs again', async () => {
    const mark = vi.fn().mockResolvedValue(undefined);
    const first = await executeSiteVisitMissedJob({ now: sixPm, mark });
    const second = await executeSiteVisitMissedJob({
      now: new Date('2026-10-17T13:00:00.000Z'),
      lastCompletedDate: first.lastCompletedDate,
      mark,
    });

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(missedJobDecision(sixPm, first.dateKey).run).toBe(false);
  });

  it('retries after an error instead of treating the day as finished', async () => {
    const mark = vi.fn().mockRejectedValue(new Error('database unavailable'));

    await expect(executeSiteVisitMissedJob({ now: sixPm, mark })).rejects.toThrow('database unavailable');
    expect(missedJobDecision(sixPm, null).run).toBe(true);
  });
});

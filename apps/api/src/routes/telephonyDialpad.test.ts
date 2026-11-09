import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
  userId: 'user-test',
  impersonating: false,
  permitted: true,
  settings: {} as Record<string, unknown> | null,
  lead: {} as Record<string, unknown> | null,
  followUp: null as Record<string, unknown> | null,
  duplicate: null as Record<string, unknown> | null,
  createCall: vi.fn(),
  findExistingCall: vi.fn(),
  updateCall: vi.fn(),
  createAudit: vi.fn(),
  hasPermission: vi.fn(),
  canAccessLead: vi.fn(),
  normalizeLeadPhone: vi.fn(),
  applyStatus: vi.fn(),
  appendNote: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authenticate: (req: Request, _res: ExpressResponse, next: NextFunction) => {
    Object.assign(req, {
      user: { id: routeMocks.userId, tenantId: 'session-tenant', isAdmin: false, isSuperAdmin: false },
      tenantId: 'session-tenant',
      impersonation: routeMocks.impersonating ? {} : undefined,
    });
    next();
  },
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    telephonySetting: { findUnique: vi.fn(() => Promise.resolve(routeMocks.settings)) },
    lead: { findFirst: vi.fn(() => Promise.resolve(routeMocks.lead)) },
    followUp: { findFirst: vi.fn(() => Promise.resolve(routeMocks.followUp)) },
    callDetail: {
      findFirst: vi.fn(() => Promise.resolve(routeMocks.duplicate)),
      create: routeMocks.createCall,
    },
    auditLog: { create: routeMocks.createAudit },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      callDetail: {
        create: routeMocks.createCall,
        findFirst: routeMocks.findExistingCall,
        update: routeMocks.updateCall,
      },
      auditLog: { create: routeMocks.createAudit },
    })),
  },
}));

vi.mock('../services/effectivePermissions', () => ({
  EffectivePermissionService: {
    hasPermission: routeMocks.hasPermission,
    isTelephonyPermissionConfigured: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock('../services/recordAccess', () => ({
  canAccessLead: routeMocks.canAccessLead,
}));
vi.mock('../services/leadDuplicateDetection', () => ({
  normalizeLeadPhone: routeMocks.normalizeLeadPhone,
}));
vi.mock('../services/callLogStatus', () => ({
  applyCallLogStatusRule: routeMocks.applyStatus,
}));
vi.mock('../services/leadNotes', () => ({
  appendLeadProcessNote: routeMocks.appendNote,
}));

import telephonyDialpadRouter from './telephonyDialpad';
import { prisma } from '@dct-crm/db';

const servers: Server[] = [];

async function post(path: string, body: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use('/api/telephony', telephonyDialpadRouter);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/api/telephony/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  routeMocks.userId = `user-${Math.random()}`;
  routeMocks.impersonating = false;
  routeMocks.permitted = true;
  routeMocks.settings = {
    isActive: true,
    dialpadUrl: 'https://bizcall.cxteletech.com/embed/dialpad',
    autoDialOnClick: false,
    theme: 'DARK',
    duplicateGuardSeconds: 10,
    callsPerMinute: 10,
    blockDnc: false,
    dncNumbers: '',
  };
  routeMocks.lead = {
    id: `lead-${Math.random()}`,
    tenantId: 'session-tenant',
    ownerId: routeMocks.userId,
    creatorId: routeMocks.userId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    company: null,
    phone: '+14155552671',
    mobile: null,
    secondaryPhone: null,
    countryCode: null,
    secondaryCountryCode: null,
    leadNumber: 'L-1',
    status: 'NEW',
  };
  routeMocks.followUp = null;
  routeMocks.duplicate = null;
  routeMocks.hasPermission.mockReset().mockResolvedValue(true);
  routeMocks.canAccessLead.mockReset().mockResolvedValue(true);
  routeMocks.normalizeLeadPhone.mockReset().mockImplementation((number: string) => number ? { e164: number } : null);
  routeMocks.createCall.mockReset().mockResolvedValue({ id: 'call-detail-1' });
  routeMocks.findExistingCall.mockReset().mockResolvedValue(null);
  routeMocks.updateCall.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
  routeMocks.createAudit.mockReset().mockResolvedValue({});
  routeMocks.applyStatus.mockReset().mockResolvedValue({ changed: true, status: 'INCOMING' });
  routeMocks.appendNote.mockReset().mockResolvedValue(undefined);
  vi.mocked(prisma.callDetail.findFirst).mockClear();
});

afterEach(async () => {
  routeMocks.impersonating = false;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('POST /api/telephony/dialpad-call-started', () => {
  it('creates one Call Detail and returns only a server-built, encoded dialpad URL', async () => {
    const response = await post('dialpad-call-started', {
      leadId: (routeMocks.lead as { id: string }).id,
      phoneField: 'phone',
      tenantId: 'attacker-tenant',
      userId: 'attacker-user',
    });

    describe('POST /api/telephony/dialpad-event disposition persistence', () => {
      it('persists call notes and disposition idempotently against the authenticated lead and call', async () => {
        const lead = routeMocks.lead as { id: string };
        let savedCall: Record<string, unknown> = {
          id: 'call-detail-1',
          tenantId: 'session-tenant',
          createdById: routeMocks.userId,
          leadId: lead.id,
          callTo: '+14155552671',
          status: 'Ended',
          source: 'dialpad',
          providerCallId: 'provider-call-1',
          disposition: null,
          notes: null,
        };
        routeMocks.findExistingCall.mockImplementation(async () => savedCall);
        routeMocks.updateCall.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          savedCall = { ...savedCall, ...data };
          return savedCall;
        });

        const event = {
          event: 'BIZCALL_DISPOSITION_SUBMITTED',
          leadId: lead.id,
          callDetailId: 'call-detail-1',
          callUuid: 'provider-call-1',
          disposition: 'Interested',
          notes: 'Call me tomorrow',
        };
        const first = await post('dialpad-event', event);
        const firstBody = await first.json() as { data: Record<string, unknown> };
        const second = await post('dialpad-event', event);

        expect(first.status).toBe(200);
        expect(firstBody.data).toMatchObject({
          callDetailId: 'call-detail-1',
          leadId: lead.id,
          disposition: 'Interested',
          notes: 'Call me tomorrow',
        });
        expect(second.status).toBe(200);
        expect(savedCall).toMatchObject({ disposition: 'Interested', notes: 'Call me tomorrow' });
        expect(routeMocks.findExistingCall).toHaveBeenCalledWith({
          where: {
            id: 'call-detail-1',
            tenantId: 'session-tenant',
            createdById: routeMocks.userId,
            leadId: lead.id,
          },
        });
        expect(routeMocks.appendNote).toHaveBeenCalledOnce();
        expect(routeMocks.appendNote).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
          tenantId: 'session-tenant',
          leadId: lead.id,
          userId: routeMocks.userId,
          content: 'Call disposition saved: Interested\nNotes: Call me tomorrow',
        }));
        expect(routeMocks.createAudit).toHaveBeenCalledOnce();
      });

      it('does not attach a disposition to a different lead call', async () => {
        routeMocks.lead = null;
        routeMocks.findExistingCall.mockResolvedValue(null);
        const response = await post('dialpad-event', {
          event: 'BIZCALL_DISPOSITION_SUBMITTED',
          leadId: 'other-lead',
          callDetailId: 'call-detail-1',
          disposition: 'Interested',
          notes: 'Not this lead',
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'LEAD_NOT_FOUND' });
        expect(routeMocks.appendNote).not.toHaveBeenCalled();
      });
    });
    const body = await response.json() as { data: Record<string, string> };
    const data = body.data as Record<string, string>;
    const url = new URL(data.dialpadUrl);

    expect(response.status).toBe(201);
    expect(Object.keys(data).sort()).toEqual(['callDetailId', 'dialpadUrl', 'leadName', 'number', 'recordId', 'tenantId'].sort());
    expect(data.tenantId).toBe('session-tenant');
    expect(data.number).toBe('+14155552671');
    expect(url.search).toContain('number=%2B14155552671');
    expect(url.searchParams.get('userId')).toBe(routeMocks.userId);
    expect(url.searchParams.get('autocall')).toBe('false');
    expect(url.searchParams.get('theme')).toBe('dark');
    expect(routeMocks.createCall).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: 'session-tenant',
        callTo: '+14155552671',
        callType: 'OUTBOUND',
        status: 'Initiated',
        source: 'dialpad',
      }),
    }));
    expect(routeMocks.applyStatus).toHaveBeenCalledOnce();
  });

  it('omits the REST click-to-call route', async () => {
    const response = await post('click-to-call', { leadId: 'lead-1' });
    expect(response.status).toBe(404);
  });

  it.each([
    ['permission denied', () => routeMocks.hasPermission.mockResolvedValue(false), 'NO_PERMISSION', 403],
    ['impersonation', () => { routeMocks.impersonating = true; }, 'IMPERSONATION_DISABLED', 403],
    ['telephony inactive', () => { routeMocks.settings = { ...routeMocks.settings, isActive: false }; }, 'TELEPHONY_INACTIVE', 409],
    ['invalid number', () => routeMocks.normalizeLeadPhone.mockReturnValue(null), 'INVALID_PHONE', 422],
    ['DNC number', () => {
      routeMocks.settings = { ...routeMocks.settings, blockDnc: true, dncNumbers: '+14155552671' };
    }, 'DO_NOT_CALL', 409],
    ['hidden lead', () => routeMocks.canAccessLead.mockResolvedValue(false), 'LEAD_NOT_FOUND', 404],
  ])('refuses a click when %s', async (_label, arrange, code, status) => {
    arrange();
    const response = await post('dialpad-call-started', { leadId: (routeMocks.lead as { id: string }).id });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, code });
    expect(routeMocks.createCall).not.toHaveBeenCalled();
  });

  it('rejects a repeated click inside the duplicate window', async () => {
    const leadId = (routeMocks.lead as { id: string }).id;
    expect((await post('dialpad-call-started', { leadId })).status).toBe(201);
    expect((await post('dialpad-call-started', { leadId })).status).toBe(409);
    expect(routeMocks.createCall).toHaveBeenCalledOnce();
  });

  it('uses the setting to enable auto-dial and validates linked follow-ups', async () => {
    routeMocks.settings = { ...routeMocks.settings, autoDialOnClick: true };
    routeMocks.followUp = { id: 'followup-1' };
    const response = await post('dialpad-call-started', {
      leadId: (routeMocks.lead as { id: string }).id,
      taskId: 'followup-1',
    });
    const body = await response.json() as { data: { dialpadUrl: string } };
    expect(response.status).toBe(201);
    expect(new URL(body.data.dialpadUrl).searchParams.get('autocall')).toBe('true');
  });

  it('blocks an unlinked follow-up and invalid configured dialpad URL', async () => {
    const leadId = (routeMocks.lead as { id: string }).id;
    expect((await post('dialpad-call-started', { leadId, taskId: 'foreign-followup' })).status).toBe(404);
    routeMocks.settings = { ...routeMocks.settings, dialpadUrl: 'http://bizcall.cxteletech.com/embed/dialpad' };
    const invalidUrl = await post('dialpad-call-started', { leadId });
    expect(invalidUrl.status).toBe(503);
    expect(await invalidUrl.json()).toMatchObject({ code: 'INVALID_DIALPAD_URL' });
    expect(routeMocks.createCall).not.toHaveBeenCalled();
  });

  it('enforces the per-user calls-per-minute limit', async () => {
    routeMocks.settings = { ...routeMocks.settings, callsPerMinute: 1 };
    const firstLead = routeMocks.lead as { id: string };
    expect((await post('dialpad-call-started', { leadId: firstLead.id })).status).toBe(201);
    routeMocks.lead = { ...firstLead, id: 'another-lead' };
    const limited = await post('dialpad-call-started', { leadId: 'another-lead' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(routeMocks.createCall).toHaveBeenCalledOnce();
  });

  it('rejects direct-number requests so identity and lead data cannot come from the browser', async () => {
    const response = await post('dialpad-call-started', { number: '+14155552671' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  findMany: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    telephonySetting: {
      findUnique: database.findUnique,
      upsert: database.upsert,
    },
    callDetail: { findMany: database.findMany },
  },
}));

vi.mock('../middleware/audit', () => ({ auditLog: database.auditLog }));

import { getTelephonySettings, listRecentDialpadCalls, saveTelephonySettings, telephonySettingsSchema } from './telephonySettings';

const legacySecrets = {
  clickToCallUrl: 'https://bizcall.cxteletech.com/api/integration/click2call',
  authHeaderName: 'X-API-KEY',
  encryptedCredentials: 'encrypted-private-key',
  keyLast4: '1234',
  encryptedExtraHeaders: 'encrypted-headers',
  callMethod: 'SERVER_API',
};

const existingRow = () => ({
  id: 'setting-1',
  tenantId: 'tenant-1',
  ...legacySecrets,
  isActive: false,
  dialpadUrl: 'https://bizcall.cxteletech.com/embed/dialpad',
  dialpadMode: 'DOCKED',
  defaultDockState: 'COLLAPSED',
  theme: 'CRM',
  productionOrigin: null,
  duplicateGuardSeconds: 10,
  callsPerMinute: 10,
  maskNumbers: false,
  sendTenantIdInDial: true,
  autoDialOnClick: false,
  blockDnc: false,
  dncNumbers: '',
});

function input(overrides: Record<string, unknown> = {}) {
  return telephonySettingsSchema.parse(overrides);
}

beforeEach(() => {
  vi.clearAllMocks();
  database.findUnique.mockResolvedValue(existingRow());
  database.upsert.mockImplementation(async ({ create, update }) => ({
    ...existingRow(),
    ...create,
    ...update,
    id: 'setting-1',
  }));
  database.findMany.mockResolvedValue([]);
  database.auditLog.mockResolvedValue(undefined);
});

describe('dialpad-only telephony settings', () => {
  it('defaults auto-dial off and does not expose legacy REST credentials', async () => {
    expect(input()).toMatchObject({ autoDialOnClick: false, sendTenantIdInDial: true });
    const settings = await getTelephonySettings('tenant-1');
    expect(settings).toMatchObject({ autoDialOnClick: false, status: 'inactive' });
    expect(JSON.stringify(settings)).not.toContain('encrypted-private-key');
    expect(JSON.stringify(settings)).not.toContain('clickToCallUrl');
  });

  it('saves dialpad settings without reading, changing, or returning legacy secret columns', async () => {
    const settings = await saveTelephonySettings('tenant-1', 'admin-1', input({
      isActive: true,
      dialpadUrl: 'https://bizcall.cxteletech.com/embed/dialpad',
      dialpadMode: 'NEW_TAB',
      defaultDockState: 'EXPANDED',
      theme: 'DARK',
      autoDialOnClick: false,
      blockDnc: true,
      dncNumbers: '+14155552671',
    }));

    const update = database.upsert.mock.calls[0][0].update;
    expect(update).toMatchObject({
      isActive: true,
      dialpadMode: 'NEW_TAB',
      autoDialOnClick: false,
      blockDnc: true,
      dncNumbers: '+14155552671',
    });
    for (const key of Object.keys(legacySecrets)) expect(update).not.toHaveProperty(key);
    expect(settings).toMatchObject({ isActive: true, status: 'active', dialpadMode: 'NEW_TAB' });
    expect(JSON.stringify(settings)).not.toContain('encrypted-private-key');
    expect(JSON.stringify(database.auditLog.mock.calls)).not.toContain('encrypted-private-key');
  });

  it('rejects invalid URLs and DNC numbers', async () => {
    await expect(saveTelephonySettings('tenant-1', 'admin-1', input({
      dialpadUrl: 'http://bizcall.cxteletech.com/embed/dialpad',
    }))).rejects.toThrow('The dialpad URL must use HTTPS.');
    await expect(saveTelephonySettings('tenant-1', 'admin-1', input({ dncNumbers: '5551234' })))
      .rejects.toThrow(/E\.164/);
    expect(database.upsert).not.toHaveBeenCalled();
  });

  it('returns recent dialpad calls from Call Details with masked numbers', async () => {
    database.findMany.mockResolvedValue([{
      id: 'call-1',
      createdById: 'user-1',
      leadId: 'lead-1',
      callTo: '+14155552671',
      status: 'Initiated',
      startAt: new Date('2026-11-05T12:00:00Z'),
    }]);
    await expect(listRecentDialpadCalls('tenant-1')).resolves.toEqual([expect.objectContaining({
      id: 'call-1',
      userId: 'user-1',
      leadId: 'lead-1',
      maskedNumber: '+14*****2671',
      step: 'Initiated',
    })]);
  });
});

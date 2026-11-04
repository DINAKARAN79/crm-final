import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    telephonySetting: {
      findUnique: database.findUnique,
      upsert: database.upsert,
    },
  },
}));

vi.mock('../middleware/audit', () => ({ auditLog: database.auditLog }));

import { publicTelephonySettings, saveTelephonySettings, telephonySettingsSchema } from './telephonySettings';
import { decryptTelephonyToken, encryptTelephonyToken } from './telephonyCredentials';

const existingRow = () => ({
  id: 'setting-1',
  tenantId: 'tenant-1',
  clickToCallUrl: 'https://bizcall.cxteletech.com/api/integration/click2call',
  authHeaderName: 'X-API-KEY',
  callerId: null,
  useBearerPrefix: false,
  noAuthRequired: false,
  allowTestUrl: false,
  callIdFieldPath: 'originateUuid',
  isActive: false,
  encryptedCredentials: encryptTelephonyToken('bc_live_existing1234'),
  keyLast4: '1234',
  encryptedExtraHeaders: null,
  dialpadUrl: 'https://bizcall.cxteletech.com/embed/dialpad',
  dialpadMode: 'DOCKED',
  callMethod: 'SERVER_API',
  defaultDockState: 'COLLAPSED',
  theme: 'CRM',
  productionOrigin: null,
  duplicateGuardSeconds: 10,
  callsPerMinute: 10,
  maskNumbers: false,
  sendTenantIdInDial: true,
  autoDialOnClick: true,
  blockDnc: false,
  dncNumbers: '',
});

function input(overrides: Record<string, unknown> = {}) {
  return telephonySettingsSchema.parse({
    clickToCallUrl: 'https://bizcall.cxteletech.com/api/integration/click2call',
    authHeaderName: 'X-API-KEY',
    isActive: true,
    ...overrides,
  });
}

beforeEach(() => {
  process.env.API_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 9).toString('base64');
  vi.clearAllMocks();
  database.findUnique.mockResolvedValue(existingRow());
  database.upsert.mockImplementation(async ({ create, update }) => ({
    ...create,
    ...update,
    id: 'setting-1',
  }));
  database.auditLog.mockResolvedValue(undefined);
});

describe('saveTelephonySettings Bizcall key behavior', () => {
  it('defaults dialpad auto-dial and tenant context on', () => {
    expect(input()).toMatchObject({ autoDialOnClick: true, sendTenantIdInDial: true });
    expect(publicTelephonySettings(null)).toMatchObject({ autoDialOnClick: true, sendTenantIdInDial: true });
  });

  it('does not return an api_key query parameter from legacy settings', () => {
    const settings = publicTelephonySettings({
      ...existingRow(),
      clickToCallUrl: 'https://bizcall.cxteletech.com/api/integration/click2call?api_key=bc_live_sensitive&mode=test',
    });
    expect(settings.clickToCallUrl).toBe('https://bizcall.cxteletech.com/api/integration/click2call?mode=test');
    expect(JSON.stringify(settings)).not.toContain('bc_live_sensitive');
  });

  it('reports a missing key before inactive status', () => {
    const settings = publicTelephonySettings({
      ...existingRow(),
      isActive: false,
      encryptedCredentials: null,
    });
    expect(settings.statusLabel).toBe('Key missing');
  });

  it('keeps the existing encrypted key when the input is empty', async () => {
    const saved = await saveTelephonySettings('tenant-1', 'admin-1', input({ authToken: '' }));
    const data = database.upsert.mock.calls[0][0].update;

    expect(decryptTelephonyToken(data.encryptedCredentials)).toBe('bc_live_existing1234');
    expect(saved).toMatchObject({ hasKey: true, keyLastFour: '1234' });
    expect(JSON.stringify(saved)).not.toContain('bc_live_existing1234');
    expect(database.auditLog.mock.calls[0][6]).toMatchObject({ hasKey: true });
  });

  it('replaces the encrypted key with a trimmed new value', async () => {
    const saved = await saveTelephonySettings(
      'tenant-1',
      'admin-1',
      input({ authToken: '  bc_live_replacement5678  ', callerId: '  +15551234567  ' }),
    );
    const data = database.upsert.mock.calls[0][0].update;

    expect(decryptTelephonyToken(data.encryptedCredentials)).toBe('bc_live_replacement5678');
    expect(data.encryptedCredentials).not.toContain('bc_live_replacement5678');
    expect(data.callerId).toBe('+15551234567');
    expect(saved).toMatchObject({ hasKey: true, keyLastFour: '5678', callerId: '+15551234567' });
    expect(JSON.stringify(saved)).not.toContain('bc_live_replacement5678');
    expect(database.auditLog.mock.calls[0][6]).not.toContain('bc_live_replacement5678');
  });

  it('requires a saved or submitted key when Active is enabled', async () => {
    database.findUnique.mockResolvedValue({ ...existingRow(), encryptedCredentials: null });
    await expect(saveTelephonySettings('tenant-1', 'admin-1', input({ authToken: '' })))
      .rejects.toThrow('Enter the Bizcall API key before turning telephony on.');
    expect(database.upsert).not.toHaveBeenCalled();
  });

  it('validates DNC numbers as E.164 and applies validated dialpad settings', async () => {
    await expect(saveTelephonySettings(
      'tenant-1',
      'admin-1',
      input({ dncNumbers: '5551234' }),
    )).rejects.toThrow(/E\.164/);
    const newTabDialpad = telephonySettingsSchema.safeParse({
      clickToCallUrl: 'https://bizcall.cxteletech.com/api/integration/click2call',
      dialpadMode: 'NEW_TAB',
      callMethod: 'DIALPAD_MESSAGE',
    });
    expect(newTabDialpad.success).toBe(true);
    await saveTelephonySettings(
      'tenant-1',
      'admin-1',
      input({
        dialpadUrl: 'https://bizcall.cxteletech.com/embed/dialpad',
        dialpadMode: 'NEW_TAB',
        callMethod: 'SERVER_API',
        defaultDockState: 'EXPANDED',
        theme: 'DARK',
        duplicateGuardSeconds: 20,
        callsPerMinute: 8,
        maskNumbers: true,
        sendTenantIdInDial: false,
        autoDialOnClick: false,
        blockDnc: true,
        dncNumbers: '+14155552671',
        productionOrigin: 'https://crm.example.com',
      }),
    );
    expect(database.upsert.mock.calls[0][0].update).toMatchObject({
      dialpadMode: 'NEW_TAB',
      callMethod: 'SERVER_API',
      defaultDockState: 'EXPANDED',
      theme: 'DARK',
      duplicateGuardSeconds: 20,
      callsPerMinute: 8,
      maskNumbers: true,
      sendTenantIdInDial: false,
      autoDialOnClick: false,
      blockDnc: true,
      dncNumbers: '+14155552671',
      productionOrigin: 'https://crm.example.com',
    });
    expect(JSON.stringify(database.auditLog.mock.calls)).not.toContain('+14155552671');
  });
});

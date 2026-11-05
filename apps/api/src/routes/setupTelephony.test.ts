import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const telephony = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  listLogs: vi.fn(),
  findSettings: vi.fn(),
  findUser: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    telephonySetting: { findUnique: telephony.findSettings },
    user: { findMany: vi.fn(), findFirst: telephony.findUser },
    lead: { findMany: vi.fn() },
  },
}));

vi.mock('../middleware/auth', () => ({
  authenticate: (req: Request, _res: ExpressResponse, next: NextFunction) => {
    const role = req.headers['x-test-role'];
    const isAdmin = role === 'admin';
    const isSuperAdmin = role === 'superadmin';
    const tenantId = isSuperAdmin && typeof req.query.tenantId === 'string'
      ? req.query.tenantId
      : 'tenant-1';
    Object.assign(req, {
      user: { id: 'test-user', tenantId, isAdmin, isSuperAdmin },
      tenantId,
    });
    next();
  },
}));

vi.mock('../../services/telephonySettings', () => ({
  getTelephonySettings: telephony.getSettings,
  listRecentDialpadCalls: telephony.listLogs,
  saveTelephonySettings: telephony.saveSettings,
  telephonySettingsSchema: {
    parse: (value: unknown) => value,
  },
}));

import telephonySetupRouter from './setup/telephony';

const servers: Server[] = [];

async function request(path: string, method = 'GET', role?: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/setup/telephony', telephonySetupRouter);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/api/setup/telephony${path}`, {
    method,
    headers: {
      ...(role ? { 'x-test-role': role } : {}),
      ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method !== 'GET' ? { body: '{}' } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  telephony.getSettings.mockResolvedValue({ hasKey: true, keyLastFour: '1234' });
  telephony.saveSettings.mockResolvedValue({ hasKey: true, keyLastFour: '1234' });
  telephony.findSettings.mockResolvedValue({
    isActive: true,
    dialpadUrl: 'https://bizcall.cxteletech.com/embed/dialpad',
    autoDialOnClick: false,
    theme: 'CRM',
  });
  telephony.findUser.mockResolvedValue({ phone: '+14155552671', firstName: 'Ada', lastName: 'Lovelace' });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('telephony settings authorization', () => {
  it('returns 403 for non-admin users on settings and own-number dialpad routes', async () => {
    const settings = await request('', 'GET', 'member');
    const update = await request('', 'PUT', 'member');
    const open = await request('/open-dialpad-with-my-number', 'POST', 'member');

    expect(settings.status).toBe(403);
    expect(update.status).toBe(403);
    expect(open.status).toBe(403);
    expect(telephony.getSettings).not.toHaveBeenCalled();
    expect(telephony.saveSettings).not.toHaveBeenCalled();
    expect(telephony.findUser).not.toHaveBeenCalled();
  });

  it('opens the admin phone only through the server-built URL without a REST call', async () => {
    const response = await request('/open-dialpad-with-my-number', 'POST', 'admin');
    const body = await response.json() as { data: { dialpadUrl: string; apiKey?: string } };
    const dialpadUrl = new URL(body.data.dialpadUrl);

    expect(response.status).toBe(200);
    expect(dialpadUrl.searchParams.get('userId')).toBe('test-user');
    expect(dialpadUrl.searchParams.get('number')).toBe('+14155552671');
    expect(dialpadUrl.searchParams.get('autocall')).toBe('false');
    expect(body.data).not.toHaveProperty('apiKey');
  });
});

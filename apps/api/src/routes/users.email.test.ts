import express from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  tenantFindUnique: vi.fn(),
  auditLogCreate: vi.fn(),
}));
const sessions = vi.hoisted(() => ({ endAllUserSessions: vi.fn() }));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    user: { findFirst: database.userFindFirst, update: database.userUpdate },
    tenant: { findUnique: database.tenantFindUnique },
    auditLog: { create: database.auditLogCreate },
  },
}));

vi.mock('../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { id: 'admin-1', tenantId: 'tenant-1' };
    req.tenantId = 'tenant-1';
    next();
  },
}));

vi.mock('../middleware/authorization', () => ({
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../services/userPresence', () => ({
  endAllUserSessions: sessions.endAllUserSessions,
  liveOnlineUserIds: vi.fn(),
  rejectManagedUserFields: vi.fn(),
}));

import { userRoutes as usersRouter } from './users';

const servers: Server[] = [];

async function updateUser(body: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/users/user-1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  database.userFindFirst.mockResolvedValue({
    id: 'user-1',
    tenantId: 'tenant-1',
    email: 'old@example.com',
    phone: '+14155550123',
    profileId: null,
  });
  database.tenantFindUnique.mockResolvedValue({ country: 'US' });
  database.userUpdate.mockImplementation(async ({ data }: any) => ({
    id: 'user-1',
    email: data.email || 'old@example.com',
    firstName: 'Sam',
    lastName: '',
    phone: '+14155550123',
  }));
  database.auditLogCreate.mockResolvedValue({});
  sessions.endAllUserSessions.mockResolvedValue(undefined);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('PUT /users/:id email changes', () => {
  it('normalizes, audits, and revokes sessions after an email change without changing the user ID', async () => {
    database.userFindFirst
      .mockResolvedValueOnce({ id: 'user-1', tenantId: 'tenant-1', email: 'old@example.com', phone: '+14155550123', profileId: null })
      .mockResolvedValueOnce(null);

    const response = await updateUser({ email: '  Sam@Example.COM  ' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { id: 'user-1', email: 'sam@example.com' },
    });
    expect(database.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' },
      data: expect.objectContaining({ email: 'sam@example.com' }),
    }));
    expect(sessions.endAllUserSessions).toHaveBeenCalledWith('user-1', 'tenant-1', 'REVOKED');
    expect(database.auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        objectId: 'user-1',
        oldValues: expect.objectContaining({ email: 'old@example.com' }),
        newValues: expect.objectContaining({ email: 'sam@example.com' }),
      }),
    }));
  });

  it('returns a tenant-scoped conflict without updating or revoking sessions', async () => {
    database.userFindFirst
      .mockResolvedValueOnce({ id: 'user-1', tenantId: 'tenant-1', email: 'old@example.com', phone: '+14155550123', profileId: null })
      .mockResolvedValueOnce({ id: 'other-user' });

    const response = await updateUser({ email: 'TAKEN@example.com' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, error: 'This email is already being used in this company.' });
    expect(database.userUpdate).not.toHaveBeenCalled();
    expect(sessions.endAllUserSessions).not.toHaveBeenCalled();
  });

  it('maps a concurrent tenant email unique-constraint conflict to 409', async () => {
    database.userFindFirst
      .mockResolvedValueOnce({ id: 'user-1', tenantId: 'tenant-1', email: 'old@example.com', phone: '+14155550123', profileId: null })
      .mockResolvedValueOnce(null);
    database.userUpdate.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['tenantId', 'email'] },
    });

    const response = await updateUser({ email: 'taken@example.com' });

    expect(response.status).toBe(409);
    expect(sessions.endAllUserSessions).not.toHaveBeenCalled();
  });
});

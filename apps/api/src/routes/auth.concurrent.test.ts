import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';

process.env.JWT_SECRET = 'auth-concurrency-test-secret';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';

type SessionRow = {
  id: string;
  userId: string;
  tenantId: string;
  endedAt: Date | null;
  endReason: string | null;
  isImpersonation: boolean;
  refreshTokenHash: string;
  refreshTokenExpiresAt: Date;
  sessionTokenSecret: string;
};

const state = vi.hoisted(() => ({
  sessions: new Map<string, SessionRow>(),
  loginDatabaseError: null as string | null,
  users: new Map<string, {
    id: string;
    email: string;
    tenantId: string;
    isActive: boolean;
    isSuperAdmin: boolean;
    passwordHash: string;
    tenant: { isActive: boolean; companyStartDate: null; companyExpiryDate: null };
    profile: null;
    roles: [];
  }>(),
}));

function hashSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

vi.mock('@dct-crm/db', () => ({
  prisma: {
    user: {
      findMany: async () => {
        if (state.loginDatabaseError) {
          throw Object.assign(new Error('database connection unavailable'), {
            code: state.loginDatabaseError,
          });
        }
        return [...state.users.values()];
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.users.get(where.id) || null,
    },
    userSession: {
      findUnique: async ({ where }: { where: { sessionTokenHash: string } }) =>
        state.sessions.get(where.sessionTokenHash) || null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; refreshTokenHash: string };
        data: { refreshTokenHash: string; refreshTokenExpiresAt: Date };
      }) => {
        const row = [...state.sessions.values()].find((session) => session.id === where.id);
        if (!row || row.refreshTokenHash !== where.refreshTokenHash) return { count: 0 };
        state.sessions.delete(hashSecretForTest(row.id));
        row.refreshTokenHash = data.refreshTokenHash;
        row.refreshTokenExpiresAt = data.refreshTokenExpiresAt;
        state.sessions.set(hashSecret(row.sessionTokenSecret), row);
        return { count: 1 };
      },
    },
  },
}));

function hashSecretForTest(sessionId: string) {
  const row = [...state.sessions.values()].find((session) => session.id === sessionId);
  return row ? hashSecret(row.sessionTokenSecret) : '';
}

vi.mock('bcryptjs', () => ({
  default: {
    compare: async (password: string, passwordHash: string) => passwordHash === `hash:${password}`,
  },
}));

vi.mock('../services/userPresence', () => ({
  allowHeartbeat: () => true,
  endSessionById: vi.fn(),
  endSessionBySecret: async (secret: string, reason: string) => {
    const row = state.sessions.get(hashSecret(secret));
    if (row) {
      row.endedAt = new Date();
      row.endReason = reason;
    }
  },
  getPresenceSettings: async () => ({ idleTimeoutSeconds: 120, heartbeatIntervalSeconds: 30 }),
  hashSessionSecret: hashSecret,
  isSessionOnline: () => true,
  maskIp: (ip: string | null) => ip,
  newSessionSecret: () => randomBytes(32).toString('base64url'),
  openUserSession: async ({
    userId,
    tenantId,
    sessionSecret,
    refreshTokenSecret,
    refreshTokenExpiresAt,
  }: {
    userId: string;
    tenantId: string;
    sessionSecret: string;
    refreshTokenSecret: string;
    refreshTokenExpiresAt: Date;
  }) => {
    const row = {
      id: randomBytes(16).toString('hex'),
      userId,
      tenantId,
      endedAt: null,
      endReason: null,
      isImpersonation: false,
      refreshTokenHash: hashSecret(refreshTokenSecret),
      refreshTokenExpiresAt,
      sessionTokenSecret: sessionSecret,
    };
    state.sessions.set(hashSecret(sessionSecret), row);
  },
  markSessionStale: vi.fn(),
  sessionIsAccepted: async (secret: string) => {
    const row = state.sessions.get(hashSecret(secret));
    return Boolean(row && (!row.endedAt || row.endReason === 'IDLE_TIMEOUT'));
  },
  touchUserSession: async () => ({ blocked: false }),
  REFRESH_TOKEN_TTL_MS: 30 * 24 * 60 * 60 * 1000,
}));

vi.mock('../services/impersonation', () => ({
  ImpersonationError: class extends Error {
    status = 403;
    code = 'IMPERSONATION_ERROR';
  },
  assertImpersonationRequestAllowed: vi.fn(),
  endImpersonation: vi.fn(),
  impersonationExpirySeconds: () => 3600,
  installResponseRedaction: vi.fn(),
  loadImpersonation: async () => null,
}));

vi.mock('../services/effectivePermissions', () => ({
  EffectivePermissionService: { getEffectivePermissions: async () => [] },
}));

vi.mock('../middleware/audit', () => ({ auditLog: vi.fn() }));
vi.mock('../services/apiKeys', () => ({ requestIp: () => '127.0.0.1' }));
vi.mock('@dct-crm/shared', () => ({ loginSchema: { parse: (value: unknown) => value } }));

import { authenticate, type AuthRequest } from '../middleware/auth';
import { authRoutes } from './auth';
import { refreshCookieName } from '../services/sessionTokens';

const servers: Server[] = [];

function listen(app: express.Express) {
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return address.port;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.get('/api/private/one', authenticate, (req, res) => res.json({ userId: (req as AuthRequest).user?.id }));
  app.get('/api/private/two', authenticate, (req, res) => res.json({ userId: (req as AuthRequest).user?.id }));
  return app;
}

function tokenForUser(userId: string, email: string, tenantId: string, sessionSecret: string, expired: boolean) {
  return jwt.sign(
    { id: userId, email, tenantId, isSuperAdmin: false, sid: sessionSecret, loginAt: Date.now() },
    process.env.JWT_SECRET!,
    { expiresIn: expired ? -1 : '15m' },
  );
}

function cookiePair(response: Response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Expected refresh cookie');
  return setCookie.split(';', 1)[0];
}

beforeEach(() => {
  state.sessions.clear();
  state.users.clear();
  state.loginDatabaseError = null;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('concurrent independent authentication sessions', () => {
  it('recovers login immediately after a temporary database pool failure', async () => {
    const port = listen(createApp());
    const user = {
      id: 'database-recovery-user',
      email: 'database-recovery-user@example.test',
      tenantId: 'database-recovery-tenant',
      password: 'recovery-password',
    };
    state.users.set(user.id, {
      ...user,
      isActive: true,
      isSuperAdmin: false,
      passwordHash: `hash:${user.password}`,
      tenant: { isActive: true, companyStartDate: null, companyExpiryDate: null },
      profile: null,
      roles: [],
    });

    state.loginDatabaseError = 'P2024';
    const unavailable = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      success: false,
      error: 'Authentication service temporarily unavailable. Please try again.',
    });

    state.loginDatabaseError = null;
    const recovered = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    expect(recovered.status).toBe(200);
    expect(state.sessions.size).toBe(1);
  });

  it.each([10, 20, 50, 100])('keeps %i simultaneous user sessions isolated', async (userCount) => {
    const port = listen(createApp());
    const baseUrl = `http://127.0.0.1:${port}`;
    const users = Array.from({ length: userCount }, (_, index) => {
      const id = `concurrent-user-${userCount}-${index}`;
      const email = `${id}@example.test`;
      const tenantId = `tenant-${id}`;
      state.users.set(id, {
        id,
        email,
        tenantId,
        isActive: true,
        isSuperAdmin: false,
        passwordHash: `hash:password-${index}`,
        tenant: { isActive: true, companyStartDate: null, companyExpiryDate: null },
        profile: null,
        roles: [],
      });
      return { id, email, tenantId, password: `password-${index}` };
    });

    const logins = await Promise.all(users.map(async (user) => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
      const body = await response.json() as { data: { token: string } };
      expect(response.status).toBe(200);
      return { ...user, token: body.data.token, cookie: cookiePair(response) };
    }));
    expect(state.sessions.size).toBe(userCount);

    const initialRequests = await Promise.all(logins.flatMap((session) =>
      ['/api/private/one', '/api/private/two'].map(async (path) => {
        const response = await fetch(`${baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${session.token}` },
        });
        return { response, expectedUserId: session.id };
      }),
    ));
    for (const { response, expectedUserId } of initialRequests) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ userId: expectedUserId });
    }

    const refreshedSessions = await Promise.all(logins.map(async (session) => {
      const decoded = jwt.decode(session.token) as { sid: string };
      const expiredToken = tokenForUser(session.id, session.email, session.tenantId, decoded.sid, true);
      const response = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${expiredToken}`, Cookie: session.cookie },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { token: string } };
      return { ...session, token: body.data.token, cookie: cookiePair(response) };
    }));

    expect(new Set(refreshedSessions.map(({ cookie }) => cookie.split('=', 1)[0])).size).toBe(userCount);
    const postRefreshRequests = await Promise.all(refreshedSessions.map(async (session) => {
      const response = await fetch(`${baseUrl}/api/private/one`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      return { response, expectedUserId: session.id };
    }));
    for (const { response, expectedUserId } of postRefreshRequests) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ userId: expectedUserId });
    }

    const logouts = await Promise.all(refreshedSessions.map((session) =>
      fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}` },
      }),
    ));
    for (const [index, response] of logouts.entries()) {
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain(
        `${refreshedSessions[index].cookie.split('=', 1)[0]}=`,
      );
      expect(response.headers.get('set-cookie')).toMatch(/expires=.*1970/i);
    }

    const afterLogout = await Promise.all(refreshedSessions.map((session) =>
      fetch(`${baseUrl}/api/private/one`, {
        headers: { Authorization: `Bearer ${session.token}` },
      }),
    ));
    expect(afterLogout.every((response) => response.status === 401)).toBe(true);
  }, 30000);
});

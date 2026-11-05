import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';

process.env.JWT_SECRET = 'auth-refresh-test-secret';

const state = vi.hoisted(() => ({
  sessionSecret: 'session-secret-for-refresh-test',
  refreshToken: 'refresh-token-for-refresh-test',
  refreshHash: '',
  refreshExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  failLookup: false,
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    userSession: {
      findUnique: async () => {
        if (state.failLookup) throw new Error('database connection unavailable');
        return {
          id: 'session-row',
          userId: 'user-1',
          tenantId: 'tenant-1',
          endedAt: null,
          endReason: null,
          isImpersonation: false,
          refreshTokenHash: state.refreshHash,
          refreshTokenExpiresAt: state.refreshExpiresAt,
        };
      },
      updateMany: async ({ where, data }: { where: { refreshTokenHash: string }; data: { refreshTokenHash: string; refreshTokenExpiresAt: Date } }) => {
        if (where.refreshTokenHash !== state.refreshHash) return { count: 0 };
        state.refreshHash = data.refreshTokenHash;
        state.refreshExpiresAt = data.refreshTokenExpiresAt;
        return { count: 1 };
      },
    },
    user: {
      findUnique: async () => ({
        id: 'user-1',
        email: 'user@example.test',
        tenantId: 'tenant-1',
        isActive: true,
        isSuperAdmin: false,
        tenant: { isActive: true, companyStartDate: null, companyExpiryDate: null },
      }),
    },
  },
}));

vi.mock('../services/userPresence', () => ({
  allowHeartbeat: () => true,
  endSessionById: vi.fn(),
  endSessionBySecret: vi.fn(),
  getPresenceSettings: vi.fn(async () => ({ idleTimeoutSeconds: 120, heartbeatIntervalSeconds: 30 })),
  hashSessionSecret: (secret: string) => createHash('sha256').update(secret).digest('hex'),
  isSessionOnline: () => true,
  maskIp: (ip: string | null) => ip,
  newSessionSecret: () => randomBytes(32).toString('base64url'),
  openUserSession: vi.fn(),
  markSessionStale: vi.fn(),
  touchUserSession: vi.fn(async () => ({ blocked: false })),
  REFRESH_TOKEN_TTL_MS: 30 * 24 * 60 * 60 * 1000,
}));

vi.mock('../services/impersonation', () => ({
  endImpersonation: vi.fn(),
  impersonationExpirySeconds: () => 3600,
  loadImpersonation: vi.fn(async () => null),
}));

vi.mock('../services/effectivePermissions', () => ({
  EffectivePermissionService: { getEffectivePermissions: vi.fn(async () => []) },
}));

vi.mock('../middleware/audit', () => ({ auditLog: vi.fn() }));
vi.mock('../services/apiKeys', () => ({ requestIp: () => '127.0.0.1' }));
vi.mock('@dct-crm/shared', () => ({ loginSchema: { parse: (value: unknown) => value } }));

import { authRoutes } from './auth';
import { hashSessionSecret } from '../services/userPresence';
import { refreshCookieName } from '../services/sessionTokens';

const servers: Server[] = [];

function listen(app: express.Express) {
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return address.port;
}

function createToken() {
  return jwt.sign({
    id: 'user-1',
    email: 'user@example.test',
    tenantId: 'tenant-1',
    isSuperAdmin: false,
    sid: state.sessionSecret,
    loginAt: Date.now(),
  }, process.env.JWT_SECRET!, { expiresIn: -1 });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  return app;
}

beforeEach(() => {
  state.refreshHash = hashSessionSecret(state.refreshToken);
  state.refreshExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  state.failLookup = false;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('session refresh', () => {
  it('rotates a database-backed refresh token even after the access token expires', async () => {
    const port = listen(createApp());
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createToken()}`,
        Cookie: `${refreshCookieName(state.sessionSecret)}=${state.refreshToken}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { token: string } };
    expect(jwt.verify(body.data.token, process.env.JWT_SECRET!)).toMatchObject({
      id: 'user-1',
      tenantId: 'tenant-1',
      sid: state.sessionSecret,
    });
    expect(state.refreshHash).not.toBe(hashSessionSecret(state.refreshToken));
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Path=/api');
  });

  it('rejects a refresh token after rotation', async () => {
    const port = listen(createApp());
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createToken()}`,
        Cookie: `${refreshCookieName(state.sessionSecret)}=${state.refreshToken}`,
      },
    });

    expect(response.status).toBe(200);
    const replay = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createToken()}`,
        Cookie: `${refreshCookieName(state.sessionSecret)}=${state.refreshToken}`,
      },
    });
    expect(replay.status).toBe(401);
  });

  it('does not turn a database outage into an invalid-session response', async () => {
    state.failLookup = true;
    const port = listen(createApp());
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createToken()}`,
        Cookie: `${refreshCookieName(state.sessionSecret)}=${state.refreshToken}`,
      },
    });

    expect(response.status).toBe(503);
  });
});

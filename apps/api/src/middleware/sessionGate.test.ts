import express from 'express';
import type { Server } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'session-gate-test-secret';

const state = vi.hoisted(() => ({
  endedAt: null as Date | null,
  endReason: null as string | null,
  lookups: 0,
  failUserLookup: false,
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    user: {
      findUnique: async () => {
        if (state.failUserLookup) throw new Error('database connection unavailable');
        return {
          id: 'user-1',
          email: 'admin@example.test',
          tenantId: 'tenant-1',
          isActive: true,
          isSuperAdmin: false,
          profileId: 'profile-1',
          profile: { id: 'profile-1', name: 'Admin', isAdmin: true },
          tenant: { isActive: true, companyStartDate: null, companyExpiryDate: null },
        };
      },
    },
    userSession: {
      findUnique: async () => {
        state.lookups += 1;
        return { endedAt: state.endedAt, endReason: state.endReason };
      },
    },
    tenant: { findUnique: async () => ({ id: 'tenant-1' }) },
  },
}));

import { authenticate, generateToken } from './auth';
import { resetPresenceGuards } from '../services/userPresence';

const servers: Server[] = [];

function listen(app: express.Express) {
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('authenticate session gate', () => {
  afterEach(() => {
    resetPresenceGuards();
    state.endedAt = null;
    state.endReason = null;
    state.lookups = 0;
    state.failUserLookup = false;
  });

  afterEach(() => {
    for (const server of servers) server.close();
    servers.splice(0, servers.length);
  });

  it('rejects an ended session on the next request and caches a live session', async () => {
    const app = express();
    app.get('/ping', authenticate, (_req, res) => res.json({ ok: true }));
    const port = listen(app);
    const token = generateToken({
      id: 'user-1',
      email: 'admin@example.test',
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      sessionId: 'browser-secret',
    });
    const headers = { Authorization: `Bearer ${token}` };
    expect(createHash('sha256').update('browser-secret').digest('hex')).toHaveLength(64);

    const open = await fetch(`http://127.0.0.1:${port}/ping`, { headers });
    expect(open.status).toBe(200);
    const cached = await fetch(`http://127.0.0.1:${port}/ping`, { headers });
    expect(cached.status).toBe(200);
    expect(state.lookups).toBe(1);

    state.endedAt = new Date();
    state.endReason = 'ADMIN_FORCED';
    resetPresenceGuards();
    const ended = await fetch(`http://127.0.0.1:${port}/ping`, { headers });
    expect(ended.status).toBe(401);
    expect(await ended.json()).toMatchObject({ error: 'Session ended' });
  });

  it('returns a dependency error instead of misclassifying database failures as authentication failures', async () => {
    const app = express();
    app.get('/ping', authenticate, (_req, res) => res.json({ ok: true }));
    const port = listen(app);
    const token = generateToken({
      id: 'user-1',
      email: 'admin@example.test',
      tenantId: 'tenant-1',
      isSuperAdmin: false,
    });
    state.failUserLookup = true;

    const response = await fetch(`http://127.0.0.1:${port}/ping`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Authentication service temporarily unavailable',
    });
  });
});

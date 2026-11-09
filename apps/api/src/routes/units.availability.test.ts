import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  unitFindMany: vi.fn(),
  unitCount: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    unit: {
      findMany: database.unitFindMany,
      count: database.unitCount,
    },
  },
}));

vi.mock('../middleware/auth', () => ({
  authenticate: (req: Request, _res: ExpressResponse, next: NextFunction) => {
    Object.assign(req, { user: { id: 'sales-a', tenantId: 'tenant-a', isSuperAdmin: false } });
    next();
  },
}));

vi.mock('../middleware/authorization', () => ({
  authorize: () => (_req: Request, _res: ExpressResponse, next: NextFunction) => next(),
}));

vi.mock('../middleware/audit', () => ({ auditLog: vi.fn() }));

import unitsRouter, { unitSchema, updateUnitSchema } from './units';

const servers: Server[] = [];

async function listUnits(query = '') {
  const app = express();
  app.use('/api/units', unitsRouter);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/api/units${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  database.unitFindMany.mockResolvedValue([]);
  database.unitCount.mockResolvedValue(0);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('unit inventory availability', () => {
  it('only accepts selectable unit statuses for manual changes', () => {
    const createInput = { projectId: 'project-a', number: 'A-101', type: 'Plot', price: 0 };
    expect(unitSchema.safeParse({ ...createInput, status: 'AVAILABLE' }).success).toBe(true);
    expect(unitSchema.safeParse({ ...createInput, status: 'RESERVED' }).success).toBe(true);
    expect(updateUnitSchema.safeParse({ status: 'BOOKED' }).success).toBe(true);
    expect(updateUnitSchema.safeParse({ status: 'SOLD' }).success).toBe(false);
    expect(updateUnitSchema.safeParse({ status: 'HOLD' }).success).toBe(false);
    expect(updateUnitSchema.safeParse({ status: 'BLOCKED' }).success).toBe(false);
  });

  it('filters available inventory from the unit status only', async () => {
    const response = await listUnits('?status=AVAILABLE');

    expect(response.status).toBe(200);
    expect(database.unitFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'AVAILABLE',
      }),
    }));
  });

  it('returns unit inventory without deriving status from transaction records', async () => {
    database.unitFindMany.mockResolvedValue([{
      id: 'unit-a',
      status: 'AVAILABLE',
      project: { id: 'project-a', name: 'Project A' },
    }]);
    database.unitCount.mockResolvedValue(1);

    const response = await listUnits();
    const body = await response.json() as { data: Array<{ id: string; status: string }> };

    expect(body.data).toEqual([expect.objectContaining({ id: 'unit-a', status: 'AVAILABLE' })]);
    expect(database.unitFindMany.mock.calls[0]?.[0]).not.toHaveProperty('include.bookings');
  });
});

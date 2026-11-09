import express from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findEnquiry: vi.fn(),
  updateEnquiry: vi.fn(),
  canAccessLead: vi.fn(),
  getLeadPicklistOptions: vi.fn(),
  getEnquiryById: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    enquiry: { findFirst: mocks.findEnquiry, update: mocks.updateEnquiry },
    $transaction: (callback: (tx: any) => unknown) => callback({
      enquiry: { update: mocks.updateEnquiry },
      auditLog: { create: vi.fn() },
    }),
  },
}));
vi.mock('../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-a', tenantId: 'tenant-a', isAdmin: false, isSuperAdmin: false };
    req.tenantId = 'tenant-a';
    next();
  },
}));
vi.mock('../middleware/authorization', () => ({
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../services/recordAccess', () => ({
  canAccessLead: mocks.canAccessLead,
}));
vi.mock('../services/enquiryService', () => ({
  getEnquiryById: mocks.getEnquiryById,
}));
vi.mock('../services/enquiryFieldMap', () => ({
  applyEnquiryAttributePatch: vi.fn(),
  ENQUIRY_ATTRIBUTE_KEYS: [],
}));
vi.mock('../services/enquiryBackfill', () => ({
  backfillEnquiryAttributes: vi.fn(),
}));
vi.mock('../services/leadPicklists', () => ({
  getLeadPicklistOptions: mocks.getLeadPicklistOptions,
}));

import enquiriesRoutes from './enquiries';

const servers: Server[] = [];

async function updateEnquiry(source: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/enquiries', enquiriesRoutes);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/api/enquiries/enquiry-a`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findEnquiry.mockResolvedValue({
    id: 'enquiry-a',
    tenantId: 'tenant-a',
    source: 'REFERRAL',
    leadId: 'lead-a',
    attributes: {},
    lead: { id: 'lead-a', tenantId: 'tenant-a', ownerId: 'user-a', creatorId: 'user-a' },
  });
  mocks.updateEnquiry.mockResolvedValue({ id: 'enquiry-a', source: 'WEBSITE' });
  mocks.canAccessLead.mockResolvedValue(true);
  mocks.getLeadPicklistOptions.mockResolvedValue(new Map([['source', new Set(['WEBSITE'])]]));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('PUT /api/enquiries/:id source', () => {
  it('accepts only a source configured for the matched tenant', async () => {
    const response = await updateEnquiry('OTHER');

    expect(response.status).toBe(400);
    expect(mocks.getLeadPicklistOptions).toHaveBeenCalledWith('tenant-a');
    expect(mocks.updateEnquiry).not.toHaveBeenCalled();
  });

  it('updates when the source is configured for the tenant', async () => {
    const response = await updateEnquiry('WEBSITE');

    expect(response.status).toBe(200);
    expect(mocks.updateEnquiry).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'enquiry-a' },
      data: expect.objectContaining({ source: 'WEBSITE', updatedById: 'user-a' }),
    }));
  });
});

import express from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  leadCreate: vi.fn(),
  leadUpdate: vi.fn(),
  leadFindFirst: vi.fn(),
  leadFindMany: vi.fn(),
  leadCount: vi.fn(),
  leadFindUnique: vi.fn(),
  projectFindFirst: vi.fn(),
  objectDefinitionFindFirst: vi.fn(),
  objectDefinitionCreate: vi.fn(),
  fieldDefinitionFindMany: vi.fn(),
  fieldDefinitionFindFirst: vi.fn(),
  fieldDefinitionAggregate: vi.fn(),
  fieldDefinitionCreate: vi.fn(),
  picklistValueFindMany: vi.fn(),
  picklistValueCreateMany: vi.fn(),
  leadStatusSettingFindUnique: vi.fn(),
  pageLayoutFindFirst: vi.fn(),
  pageLayoutCreate: vi.fn(),
  pageLayoutUpdate: vi.fn(),
  auditLogCreate: vi.fn(),
  auditLogFindFirst: vi.fn(),
  sequenceUpsert: vi.fn(),
  transaction: vi.fn(),
}));

const rrQueue = vi.hoisted(() => ({
  assignLeadInTransaction: vi.fn(),
  findApplicableRRQueue: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    lead: {
      create: database.leadCreate,
      update: database.leadUpdate,
      findFirst: database.leadFindFirst,
      findMany: database.leadFindMany,
      count: database.leadCount,
      findUnique: database.leadFindUnique,
    },
    objectDefinition: {
      findFirst: database.objectDefinitionFindFirst,
      create: database.objectDefinitionCreate,
    },
    fieldDefinition: {
      findMany: database.fieldDefinitionFindMany,
      findFirst: database.fieldDefinitionFindFirst,
      aggregate: database.fieldDefinitionAggregate,
      create: database.fieldDefinitionCreate,
    },
    picklistValue: {
      findMany: database.picklistValueFindMany,
      createMany: database.picklistValueCreateMany,
    },
    leadStatusSetting: { findUnique: database.leadStatusSettingFindUnique },
    pageLayout: {
      findFirst: database.pageLayoutFindFirst,
      create: database.pageLayoutCreate,
      update: database.pageLayoutUpdate,
    },
    auditLog: { findFirst: database.auditLogFindFirst },
    project: { findFirst: database.projectFindFirst },
    $transaction: database.transaction,
  },
}));

vi.mock('../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = {
      id: 'svc-a',
      tenantId: 'tenant-a',
      isSuperAdmin: false,
      profileName: 'SVC',
    };
    req.tenantId = 'tenant-a';
    next();
  },
}));

vi.mock('../middleware/authorization', () => ({
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../services/leadPicklists', () => ({
  getLeadPicklistOptions: vi.fn().mockResolvedValue(new Map([
    ['source', new Set(['WEBSITE'])],
  ])),
  validateLeadPicklists: vi.fn().mockReturnValue(null),
}));

vi.mock('../services/workflow', () => ({
  canTransitionStatus: () => true,
  canScheduleSiteVisit: () => true,
  canonicalProfileName: (name: string) => name,
  isValidStatus: () => true,
}));

vi.mock('../services/ownerHistory', () => ({
  createOwnerHistory: vi.fn(),
  getOwnerHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/recordAccess', () => ({
  canAccessLead: vi.fn().mockResolvedValue(true),
  getLeadRecordScope: vi.fn(),
  leadScopeClause: vi.fn(),
}));

vi.mock('../services/leadWorkflowExtras', () => ({
  getNextSiteVisitNumber: vi.fn(),
  normalizeOverdueFollowUps: vi.fn(),
  normalizeOverdueSiteVisits: vi.fn(),
}));
vi.mock('../services/leadStatusSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/leadStatusSettings')>();
  return {
    ...actual,
    decorateLeadStatus: vi.fn((_tenantId: string, lead: unknown) => lead),
    decorateLeads: vi.fn((leads: unknown[]) => leads),
  };
});
vi.mock('../services/tenantTimezone', () => ({
  getTenantTimezone: vi.fn().mockResolvedValue('UTC'),
}));

vi.mock('../services/rrQueue', () => ({
  findApplicableRRQueue: rrQueue.findApplicableRRQueue,
  assignLeadToProjectRoundRobinInTransaction: rrQueue.assignLeadInTransaction,
  hasLeadAssignmentRelevantChanges: vi.fn(),
  isLeadEligibleForAutoAssignment: () => true,
  RoundRobinAssignmentService: {
    assignLeadInTransaction: rrQueue.assignLeadInTransaction,
  },
}));

vi.mock('../services/leadOwnerChange', () => ({
  changeLeadOwner: vi.fn(),
  getEligibleLeadOwners: vi.fn(),
}));
vi.mock('../services/leadNotes', () => ({
  appendLeadProcessNote: vi.fn().mockResolvedValue(undefined),
}));

import { leadRoutes as leadsRouter } from './leads';

const servers: Server[] = [];

async function scheduleSiteVisit(body: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use('/api/leads', leadsRouter);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/api/leads/lead-a/schedule-site-visit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function pushLeadToSVC(body: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use('/api/leads', leadsRouter);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/api/leads/lead-a/push-to-svc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function updateLead(body: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use('/api/leads', leadsRouter);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/api/leads/lead-a`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getLead(identifier: string) {
  const app = express();
  app.use('/api/leads', leadsRouter);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/api/leads/${encodeURIComponent(identifier)}`);
}

async function getLeadList() {
  const app = express();
  app.use('/api/leads', leadsRouter);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/api/leads?page=1&limit=20`);
}

beforeEach(() => {
  vi.clearAllMocks();
  database.leadFindFirst.mockResolvedValue({
    id: 'lead-a',
    tenantId: 'tenant-a',
    ownerId: 'svc-a',
    creatorId: null,
    status: 'PROSPECT',
    owner: { id: 'svc-a', firstName: 'SVC', lastName: 'User' },
  });
  database.projectFindFirst.mockResolvedValue(null);
  database.objectDefinitionFindFirst.mockResolvedValue(null);
  database.objectDefinitionCreate.mockResolvedValue({ id: 'lead-object-a' });
  database.fieldDefinitionFindMany.mockResolvedValue([]);
  database.fieldDefinitionFindFirst.mockResolvedValue(null);
  database.fieldDefinitionAggregate.mockResolvedValue({ _max: { displayOrder: 10 } });
  database.fieldDefinitionCreate.mockImplementation(({ data }: { data: { name: string; fieldType: string } }) => ({
    id: `field-${data.name}`,
    fieldType: data.fieldType,
    isActive: true,
    visible: true,
    editable: true,
  }));
  database.picklistValueFindMany.mockResolvedValue([]);
  database.picklistValueCreateMany.mockResolvedValue({ count: 1 });
  database.leadStatusSettingFindUnique.mockResolvedValue(null);
  database.pageLayoutFindFirst.mockResolvedValue(null);
  database.pageLayoutCreate.mockResolvedValue({ id: 'lead-layout-a' });
  database.pageLayoutUpdate.mockResolvedValue({});
  database.auditLogCreate.mockResolvedValue({});
  database.auditLogFindFirst.mockResolvedValue(null);
  database.leadFindMany.mockResolvedValue([]);
  database.leadCount.mockResolvedValue(1);
  rrQueue.assignLeadInTransaction.mockResolvedValue({ assignedUserId: 'svc-member-a' });
  database.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      lead: {
        create: database.leadCreate,
        update: database.leadUpdate,
        findFirst: database.leadFindFirst,
        findMany: database.leadFindMany,
        findUnique: database.leadFindUnique,
        findUniqueOrThrow: database.leadFindUnique,
      },
      objectDefinition: {
        findFirst: database.objectDefinitionFindFirst,
        create: database.objectDefinitionCreate,
      },
      fieldDefinition: {
        findMany: database.fieldDefinitionFindMany,
        findFirst: database.fieldDefinitionFindFirst,
        aggregate: database.fieldDefinitionAggregate,
        create: database.fieldDefinitionCreate,
      },
      picklistValue: {
        findMany: database.picklistValueFindMany,
        createMany: database.picklistValueCreateMany,
      },
      pageLayout: {
        findFirst: database.pageLayoutFindFirst,
        create: database.pageLayoutCreate,
        update: database.pageLayoutUpdate,
      },
      sequence: { upsert: database.sequenceUpsert },
      auditLog: { create: database.auditLogCreate, findFirst: database.auditLogFindFirst },
      project: { findFirst: database.projectFindFirst },
      enquiry: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'enquiry-1' }),
      },
      tenant: { findUnique: vi.fn().mockResolvedValue(null) },
      siteVisit: { create: vi.fn() },
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
    }),
  );
  database.sequenceUpsert.mockResolvedValue({ nextValue: 1 });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('GET /api/leads/:id', () => {
  it('resolves a public Lead Number and returns the canonical lead record', async () => {
    const storedLead = {
      id: 'lead-a',
      leadNumber: 'LN000001',
      tenantId: 'tenant-a',
      ownerId: 'svc-a',
      creatorId: null,
      status: 'PROSPECT',
      siteVisits: [],
      auditLogs: [],
    };
    database.leadFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.leadNumber === 'LN000001' ? storedLead : null,
    );

    const response = await getLead('LN000001');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { id: 'lead-a', leadNumber: 'LN000001' },
    });
    expect(database.leadFindFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { id: 'LN000001', tenantId: 'tenant-a' } }),
    );
    expect(database.leadFindFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { leadNumber: 'LN000001', tenantId: 'tenant-a' } }),
    );
  });
});

describe('GET /api/leads', () => {
  it('selects only available list fields when newer Lead columns are not migrated yet', async () => {
    database.leadFindMany.mockResolvedValue([{
      id: 'lead-a',
      tenantId: 'tenant-a',
      ownerId: 'svc-a',
      leadNumber: 'LN000001',
      firstName: 'Test',
      lastName: 'Lead',
      company: null,
      email: null,
      phone: '9876543210',
      countryCode: '91',
      source: 'WEBSITE',
      leadInterest: null,
      status: 'PROSPECT',
      rating: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      owner: null,
      project: null,
      bookings: [],
      _count: { siteVisits: 0, activities: 0 },
    }]);

    const response = await getLeadList();
    const query = database.leadFindMany.mock.calls[0][0];

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [{ id: 'lead-a', leadNumber: 'LN000001' }],
      pagination: { total: 1 },
    });
    expect(query.select).toBeDefined();
    expect(query.select.bookedBy).toBeUndefined();
    expect(query.include).toBeUndefined();
  });
});

describe('POST /api/leads/:id/push-to-svc request validation', () => {
  it.each([
    [{ reason: '   ' }, 'Reason/note is required for status change'],
    [{ reason: 42 }, 'Expected string, received number'],
    [{ reason: 'x'.repeat(2001) }, 'Reason/note must be 2000 characters or fewer'],
  ])('rejects an invalid SVC push note: %j', async (body, expectedError) => {
    const response = await pushLeadToSVC(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: expectedError });
    expect(database.leadFindFirst).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('creates missing Prospect Lead fields and saves the submitted details during SVC assignment', async () => {
    database.leadFindFirst.mockResolvedValueOnce({
      id: 'lead-a',
      tenantId: 'tenant-a',
      ownerId: 'crm-a',
      creatorId: 'crm-a',
      status: 'INCOMING',
      projectId: 'old-project',
      customFields: { existingField: 'keep me' },
      owner: { id: 'crm-a', firstName: 'CRM', lastName: 'User' },
    });
    database.projectFindFirst.mockResolvedValueOnce({ id: 'project-a' });
    database.leadFindUnique.mockResolvedValueOnce({ id: 'lead-a', status: 'PROSPECT' });
    database.fieldDefinitionFindMany.mockResolvedValueOnce([
      { name: 'firstName', displayOrder: 1 },
      { name: 'company', displayOrder: 2 },
    ]);
    const details = {
      callSummaryRemarks: 'Customer is interested in a family home',
      minimumBudget: '50 lakhs',
      maximumBudget: '1 crore',
      bedroomPreference: ['3 BHK', '4 BHK'],
      propertyType: ['Apartment', 'Villa'],
      possession: 'Within 6 Months',
      reasonToBuy: 'Self Use',
    };

    const response = await pushLeadToSVC({
      reason: details.callSummaryRemarks,
      projectId: 'project-a',
      prospectDetails: details,
    });

    expect(response.status).toBe(200);
    expect(rrQueue.assignLeadInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      projectId: 'project-a',
      userType: 'SVC',
    }));
    expect(database.fieldDefinitionCreate).toHaveBeenCalledTimes(7);
    expect(database.picklistValueCreateMany).toHaveBeenCalledTimes(6);
    expect(database.pageLayoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'Default Lead Layout',
        isDefault: true,
        sections: expect.arrayContaining([
          expect.objectContaining({
            name: 'Lead Information',
            fields: expect.arrayContaining(['firstName', 'company']),
          }),
          expect.objectContaining({
            name: 'Prospect Information',
            fields: expect.arrayContaining([
              'svc_call_summary_remarks',
              'svc_minimum_budget',
              'svc_maximum_budget',
              'svc_bedroom_preference',
              'svc_property_type',
              'svc_possession',
              'svc_reason_to_buy',
            ]),
          }),
        ]),
      }),
    }));
    expect(database.leadUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'project-a',
        status: 'PROSPECT',
        customFields: expect.objectContaining({
          existingField: 'keep me',
          svc_call_summary_remarks: details.callSummaryRemarks,
          svc_minimum_budget: details.minimumBudget,
          svc_maximum_budget: details.maximumBudget,
          svc_bedroom_preference: details.bedroomPreference,
          svc_property_type: details.propertyType,
          svc_possession: details.possession,
          svc_reason_to_buy: details.reasonToBuy,
        }),
      }),
    }));
  });

  it('adds unconfigured visible Lead fields to an existing default layout', async () => {
    database.leadFindFirst.mockResolvedValueOnce({
      id: 'lead-a',
      tenantId: 'tenant-a',
      ownerId: 'crm-a',
      creatorId: 'crm-a',
      status: 'INCOMING',
      owner: { id: 'crm-a', firstName: 'CRM', lastName: 'User' },
    });
    database.projectFindFirst.mockResolvedValueOnce({ id: 'project-a' });
    database.leadFindUnique.mockResolvedValueOnce({ id: 'lead-a', status: 'PROSPECT' });
    database.fieldDefinitionFindMany.mockResolvedValueOnce([
      { name: 'firstName', displayOrder: 1 },
      { name: 'company', displayOrder: 2 },
    ]);
    database.pageLayoutFindFirst.mockResolvedValueOnce({
      id: 'lead-layout-a',
      sections: [{ name: 'Lead Information', fields: [] }, { name: 'Details', fields: [] }],
    });

    const response = await pushLeadToSVC({
      reason: 'Interested in a family home',
      projectId: 'project-a',
      prospectDetails: {
        callSummaryRemarks: 'Interested in a family home',
        minimumBudget: '50 lakhs',
        maximumBudget: '1 crore',
        bedroomPreference: ['3 BHK'],
        propertyType: ['Apartment'],
      },
    });

    expect(response.status).toBe(200);
    expect(database.pageLayoutUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'lead-layout-a' },
      data: {
        sections: expect.arrayContaining([
          expect.objectContaining({
            name: 'Lead Information',
            fields: expect.arrayContaining(['firstName', 'company']),
          }),
          expect.objectContaining({
            name: 'Prospect Information',
            fields: expect.arrayContaining(['svc_call_summary_remarks', 'svc_minimum_budget']),
          }),
        ]),
      },
    }));
  });

  it('rejects a project that does not belong to the Lead tenant', async () => {
    database.leadFindFirst.mockResolvedValueOnce({
      id: 'lead-a',
      tenantId: 'tenant-a',
      status: 'INCOMING',
      projectId: null,
      owner: null,
    });
    database.projectFindFirst.mockResolvedValueOnce(null);

    const response = await pushLeadToSVC({
      reason: 'Qualified',
      projectId: 'project-other-tenant',
      prospectDetails: {
        callSummaryRemarks: 'Qualified',
        minimumBudget: '50 lakhs',
        maximumBudget: '1 crore',
        bedroomPreference: ['3 BHK'],
        propertyType: ['Apartment'],
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: 'Project must belong to this company' });
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

describe('PUT /api/leads/:id owner protection', () => {
  it('rejects owner changes through the generic edit route', async () => {
    const response = await updateLead({ ownerId: 'other-user' });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Use the lead assignment action to change the owner.',
    });
    expect(database.leadUpdate).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/leads/:id/schedule-site-visit project validation', () => {
  it('rejects a project outside the authenticated tenant before assignment or creation', async () => {
    const response = await scheduleSiteVisit({
      projectId: 'project-from-tenant-b',
      scheduledAt: '2027-06-15T09:00:00.000Z',
      visitType: 'Site Visit',
      rating: null,
      transport: null,
      callSummaryRemarks: '',
      minimumBudget: '20 lakhs',
      maximumBudget: '30 lakhs',
      propertyType: ['Apartment'],
      bedroomPreference: ['3 BHK'],
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ success: false, error: 'Project not found' });
    expect(database.projectFindFirst).toHaveBeenCalledWith({
      where: { id: 'project-from-tenant-b', tenantId: 'tenant-a', isActive: true },
      select: { id: true },
    });
  });

  it('rejects a past visit time before creating a site visit', async () => {
    database.projectFindFirst.mockResolvedValueOnce({ id: 'project-a' });
    const response = await scheduleSiteVisit({
      projectId: 'project-a',
      scheduledAt: '2020-01-01T09:00:00.000Z',
      visitType: 'Site Visit',
      rating: 'Hot',
      transport: 'Self',
      callSummaryRemarks: '',
      minimumBudget: '20 lakhs',
      maximumBudget: '30 lakhs',
      propertyType: ['Apartment'],
      bedroomPreference: [],
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, error: 'Site visit can only be scheduled for a future date and time.' });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed visit dates before starting a transaction', async () => {
    const response = await scheduleSiteVisit({
      projectId: 'project-a',
      notes: 'Customer requested a visit',
      scheduledAt: 'not-a-date',
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, error: 'Visit date/time is required' });
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/leads Round Robin assignment', () => {
  it('creates the lead when a matching queue has no eligible Sales user and reports the pending assignment', async () => {
    const createdLead = {
      id: 'lead-new',
      leadNumber: 'LN000001',
      firstName: 'New',
      lastName: 'Customer',
      company: 'Example',
      source: 'WEBSITE',
      projectId: 'project-a',
      project: { id: 'project-a', name: 'Project A' },
      owner: { id: 'admin-a', firstName: 'Admin', lastName: 'User' },
    };
    database.leadCreate.mockResolvedValue(createdLead);
    database.leadFindUnique.mockResolvedValue(createdLead);
    database.projectFindFirst.mockResolvedValue({ id: 'project-a' });
    rrQueue.findApplicableRRQueue.mockResolvedValue({ id: 'queue-a' });
    rrQueue.assignLeadInTransaction.mockRejectedValue(new Error('NO_ELIGIBLE_USER'));

    const app = express();
    app.use(express.json());
    app.use('/api/leads', leadsRouter);
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lastName: 'Customer',
        company: 'Example',
        phone: '9876543210',
        source: 'WEBSITE',
        projectId: 'project-a',
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(database.leadCreate).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      success: true,
      data: {
        id: 'lead-new',
        assignmentWarning: expect.stringContaining('no eligible Sales user'),
      },
    });
  });

  it('rejects a direct status-bar update without writing the lead', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/leads', leadsRouter);
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/leads/lead-a/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statusId: '3', note: 'Clicked the status bar' }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      success: false,
      error: 'Lead status cannot be changed from the status bar.',
    });
    expect(database.leadUpdate).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
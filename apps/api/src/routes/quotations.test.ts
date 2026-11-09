import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quotationScheduleAmounts } from '@dct-crm/shared';

const database = vi.hoisted(() => ({
  leadFindFirst: vi.fn(),
  siteVisitFindFirst: vi.fn(),
  projectFindFirst: vi.fn(),
  unitFindFirst: vi.fn(),
  quotationFindMany: vi.fn(),
  sequenceUpsert: vi.fn(),
  quotationCreate: vi.fn(),
  unitUpdate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@dct-crm/db', () => ({
  prisma: {
    lead: { findFirst: database.leadFindFirst },
    siteVisit: { findFirst: database.siteVisitFindFirst },
    project: { findFirst: database.projectFindFirst },
    unit: { findFirst: database.unitFindFirst, update: database.unitUpdate },
    quotation: { findMany: database.quotationFindMany },
    $transaction: database.transaction,
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
vi.mock('../services/recordAccess', () => ({ canAccessLead: vi.fn(async () => true) }));

import quotationsRouter from './quotations';

const servers: Server[] = [];
const tx = {
  sequence: { upsert: database.sequenceUpsert },
  unit: { findFirst: database.unitFindFirst },
  quotation: { create: database.quotationCreate },
};

const paymentPlan = {
  name: 'Construction-linked custom plan',
  installments: [
    { milestone: 'On confirmation', percentage: 10, dueDays: 0 },
    { milestone: 'On foundation', percentage: 25, dueDays: 60 },
    { milestone: 'On possession', percentage: 65, dueDays: 365 },
  ],
};

const quotationInput = {
  siteVisitId: 'visit-a',
  projectId: 'project-a',
  unitId: 'unit-a',
  pricePerSqFt: 1000,
  plcAmount: 25000,
  discountPercent: 1,
  paymentPlan,
};

async function createQuotation(input: Record<string, unknown> = quotationInput) {
  const app = express();
  app.use(express.json());
  app.use('/api/quotations', quotationsRouter);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return fetch(`http://127.0.0.1:${address.port}/api/quotations/lead/lead-a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  database.leadFindFirst.mockResolvedValue({
    id: 'lead-a',
    tenantId: 'tenant-a',
    ownerId: 'sales-a',
    creatorId: 'sales-a',
    firstName: 'Asha',
    lastName: 'Sharma',
    company: 'Asha Sharma',
    mobile: '9999999999',
    email: 'asha@example.com',
  });
  database.siteVisitFindFirst.mockResolvedValue({ id: 'visit-a' });
  database.projectFindFirst.mockResolvedValue({ id: 'project-a', name: 'North Tower' });
  database.unitFindFirst.mockResolvedValue({
    id: 'unit-a',
    number: 'A-101',
    type: '2BHK',
    area: 1000,
    price: 1000000,
    status: 'AVAILABLE',
  });
  database.sequenceUpsert.mockResolvedValue({ nextValue: 2 });
  database.quotationCreate.mockImplementation(({ data }) => Promise.resolve({
    id: 'quotation-a',
    quotationNumber: data.quotationNumber,
    ...data,
  }));
  database.transaction.mockImplementation((callback) => callback(tx));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('POST /api/quotations/lead/:leadId', () => {
  it('saves custom installment plans and leaves unit availability unchanged', async () => {
    const response = await createQuotation();
    const body = await response.json();

    expect(response.status).toBe(201);
    const amounts = quotationScheduleAmounts(1015000, [10, 25, 65]);
    const savedPlan = {
      name: paymentPlan.name,
      installments: paymentPlan.installments.map((installment, index) => ({ ...installment, amount: amounts[index] })),
    };
    expect(body).toMatchObject({
      success: true,
      data: {
        quotationNumber: expect.stringMatching(/^QT-\d{4}-000002$/),
        discountAmount: 10000,
        totalPrice: 1015000,
        paymentPlanName: paymentPlan.name,
        paymentPlan: savedPlan,
      },
    });
    expect(database.quotationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        discountAmount: 10000,
        totalPrice: 1015000,
        paymentPlan: savedPlan,
      }),
    }));
    expect(database.unitUpdate).not.toHaveBeenCalled();
  });

  it('saves a day-based custom plan and recalculates each installment amount', async () => {
    const dayPlan = {
      name: 'Day linked plan',
      installments: [
        { milestone: 'Booking', percentage: 10, dueDays: 0 },
        { milestone: 'Agreement', percentage: 40, dueDays: 60 },
        { milestone: 'Possession', percentage: 50, dueDays: 365 },
      ],
    };
    const response = await createQuotation({ ...quotationInput, paymentPlan: dayPlan });
    expect(response.status).toBe(201);
    const amounts = quotationScheduleAmounts(1015000, [10, 40, 50]);
    expect(database.quotationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        paymentPlan: {
          name: 'Day linked plan',
          installments: [
            { milestone: 'Booking', percentage: 10, dueDays: 0, amount: amounts[0] },
            { milestone: 'Agreement', percentage: 40, dueDays: 60, amount: amounts[1] },
            { milestone: 'Possession', percentage: 50, dueDays: 365, amount: amounts[2] },
          ],
        },
      }),
    }));
  });

  it('rejects month-based installment input for new quotations', async () => {
    const response = await createQuotation({
      ...quotationInput,
      paymentPlan: {
        name: 'Month based plan',
        installments: [
          { milestone: 'Booking', percentage: 10, dueMonths: 0 },
          { milestone: 'Registration', percentage: 90, dueMonths: 1 },
        ],
      },
    });

    expect(response.status).toBe(400);
    expect(database.quotationCreate).not.toHaveBeenCalled();
  });

  it('rejects day offsets outside the supported range', async () => {
    const response = await createQuotation({
      ...quotationInput,
      paymentPlan: {
        name: 'Out of range plan',
        installments: [
          { milestone: 'Booking', percentage: 10, dueDays: 0 },
          { milestone: 'Registration', percentage: 90, dueDays: 3651 },
        ],
      },
    });

    expect(response.status).toBe(400);
    expect(database.quotationCreate).not.toHaveBeenCalled();
  });

  it.each([null, 'not-an-email'])('requires a valid lead email before creating a quotation (%s)', async (email) => {
    database.leadFindFirst.mockResolvedValue({
      id: 'lead-a',
      tenantId: 'tenant-a',
      ownerId: 'sales-a',
      creatorId: 'sales-a',
      firstName: 'Asha',
      lastName: 'Sharma',
      mobile: '9999999999',
      email,
    });

    const response = await createQuotation();

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'A valid email address is required on the lead before creating a quotation',
    });
    expect(database.quotationCreate).not.toHaveBeenCalled();
  });

  it('rejects a percentage discount that would make the quotation total negative', async () => {
    const response = await createQuotation({ ...quotationInput, discountPercent: 103 });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Quotation total cannot be negative' });
    expect(database.quotationCreate).not.toHaveBeenCalled();
  });

  it('calculates the percentage discount from the unit base price, not PLC charges', async () => {
    const response = await createQuotation({ ...quotationInput, discountPercent: 10 });

    expect(response.status).toBe(201);
    expect(database.quotationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ discountAmount: 100000, totalPrice: 925000 }),
    }));
  });

  it('allows a 100 percent discount when the resulting quotation total is zero', async () => {
    database.unitFindFirst.mockResolvedValue({
      id: 'unit-a',
      number: 'A-101',
      type: '2BHK',
      area: 1000,
      price: 1000000,
      status: 'AVAILABLE',
    });

    const response = await createQuotation({
      ...quotationInput,
      pricePerSqFt: 0.01,
      plcAmount: 0,
      discountPercent: 100,
    });

    expect(response.status).toBe(201);
    expect(database.quotationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ discountAmount: 10, totalPrice: 0 }),
    }));
  });

  it('rejects duplicate milestone names and totals above 100 percent', async () => {
    const duplicate = await createQuotation({
      ...quotationInput,
      paymentPlan: {
        name: 'Duplicate plan',
        installments: [
          { milestone: 'Booking', percentage: 40, dueDays: 0 },
          { milestone: 'booking', percentage: 60, dueDays: 60 },
        ],
      },
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: 'Milestone names must be unique' });

    const overTotal = await createQuotation({
      ...quotationInput,
      paymentPlan: {
        name: 'Over total',
        installments: [
          { milestone: 'Booking', percentage: 20, dueDays: 0 },
          { milestone: 'Registration', percentage: 90, dueDays: 150 },
        ],
      },
    });
    expect(overTotal.status).toBe(400);
    expect(await overTotal.json()).toMatchObject({
      error: 'Total installment percentage must equal 100%. Current total: 110%.',
    });
    expect(database.quotationCreate).not.toHaveBeenCalled();
  });

  it('rejects custom payment plans whose installments do not total 100 percent', async () => {
    const response = await createQuotation({
      ...quotationInput,
      paymentPlan: {
        ...paymentPlan,
        installments: paymentPlan.installments.map((installment, index) =>
          index === 2 ? { ...installment, percentage: 55 } : installment
        ),
      },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, error: 'Total installment percentage must equal 100%. Current total: 90%.' });
    expect(database.leadFindFirst).not.toHaveBeenCalled();
    expect(database.quotationCreate).not.toHaveBeenCalled();
  });

  it('rejects a unit that is not available without creating a quotation', async () => {
    database.unitFindFirst.mockResolvedValue({
      id: 'unit-a',
      number: 'A-101',
      type: '2BHK',
      area: 1000,
      price: 1000000,
      status: 'RESERVED',
    });

    const response = await createQuotation();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ success: false });
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

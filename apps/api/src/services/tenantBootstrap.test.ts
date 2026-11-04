import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { bootstrapTenant } from './tenantBootstrap';

describe('bootstrapTenant', () => {
  const adminProfile = { id: 'admin-profile' };
  const standardProfile = { id: 'standard-profile' };
  const adminRole = { id: 'admin-role' };
  const seededObjects: Array<{ id: string; label: string; name: string }> = [];
  const tx = {
    permission: {
      createMany: vi.fn().mockResolvedValue({ count: 20 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn(async ({ where }: { where: { name: { in: string[] } } }) =>
        where.name.in.map((name) => ({ id: `permission-${name}`, name })),
      ),
    },
    userProfilePermission: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    objectDefinition: {
      createMany: vi.fn().mockImplementation(({ data }) => {
        seededObjects.push(...data.map((object: { name: string; label: string }, index: number) => ({
          ...object,
          id: `object-${index}`,
        })));
        return Promise.resolve({ count: data.length });
      }),
      findMany: vi.fn(async () => seededObjects),
      findFirst: vi.fn(async ({ where }: { where: { name: string } }) =>
        seededObjects.find((object) => object.name === where.name) ?? null,
      ),
    },
    fieldDefinition: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn(async ({ where }: { where?: { name?: string } }) => (
        where?.name === 'bookingStage' ? { id: 'stage-field', required: true } : null
      )),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({
        name: 'New Tenant',
        email: 'new@example.com',
        phone: null,
        website: null,
        address: null,
        city: null,
        state: null,
        country: null,
        postalCode: null,
      }),
    },
    company: {
      upsert: vi.fn().mockResolvedValue({ id: 'tenant-company' }),
    },
    customRecord: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'companies-api-record' }),
    },
    picklistValue: { createMany: vi.fn().mockResolvedValue({ count: 6 }) },
    pageLayout: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ id: 'existing-layout' }),
      createMany: vi.fn().mockResolvedValue({ count: 10 }),
      create: vi.fn().mockResolvedValue({ id: 'user-layout' }),
    },
    profile: {
      upsert: vi.fn()
        .mockResolvedValueOnce(adminProfile)
        .mockResolvedValueOnce(standardProfile),
      findMany: vi.fn().mockResolvedValue([adminProfile]),
    },
    role: {
      upsert: vi.fn().mockResolvedValue(adminRole),
      findFirst: vi.fn().mockResolvedValue(adminRole),
    },
    profileObjectPermission: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 10 }),
    },
    objectPermission: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 10 }),
    },
    sequence: { createMany: vi.fn().mockResolvedValue({ count: 4 }) },
  } as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    vi.clearAllMocks();
    seededObjects.length = 0;
    vi.mocked(tx.profile.upsert)
      .mockResolvedValueOnce(adminProfile as never)
      .mockResolvedValueOnce(standardProfile as never);
    vi.mocked(tx.role.upsert).mockResolvedValue(adminRole as never);
  });

  it('bootstraps supported CRM objects and excludes removed workflow permissions', async () => {
    const result = await bootstrapTenant(tx, 'new-tenant', 'creator');

    expect(result).toEqual({
      adminProfileId: 'admin-profile',
      adminRoleId: 'admin-role',
    });
    expect(tx.profile.upsert).toHaveBeenCalledTimes(2);
    expect(tx.role.upsert).toHaveBeenCalledTimes(1);

    const permissionData = vi.mocked(tx.permission.createMany).mock.calls[0]?.[0]?.data ?? [];
    const permissionNames = (Array.isArray(permissionData) ? permissionData : [permissionData]).map(({ name }) => name);
    expect(permissionNames).toEqual(expect.arrayContaining([
      'FULL_SYSTEM_ACCESS',
      'LEAD_READ',
      'PROJECT_READ',
      'ENQUIRY_READ',
      'ENQUIRY_CREATE',
      'TELEPHONY_CALL',
    ]));
    const adminGrants = vi.mocked(tx.userProfilePermission.createMany).mock.calls[0]?.[0]?.data ?? [];
    expect(adminGrants).toEqual(expect.arrayContaining([
      { profileId: 'admin-profile', permissionId: 'permission-ENQUIRY_READ' },
    ]));
    const standardGrants = vi.mocked(tx.userProfilePermission.createMany).mock.calls[1]?.[0]?.data ?? [];
    expect(standardGrants).not.toEqual(expect.arrayContaining([
      { profileId: 'standard-profile', permissionId: 'permission-ENQUIRY_READ' },
    ]));
    expect(permissionNames).not.toEqual(expect.arrayContaining([
      'OPPORTUNITY_READ',
      'QUOTATION_READ',
      'BOOKING_READ',
      'PAYMENT_READ',
      'RECEIPT_READ',
    ]));

    const objectData = vi.mocked(tx.objectDefinition.createMany).mock.calls[0]?.[0]?.data ?? [];
    const objectNames = (Array.isArray(objectData) ? objectData : [objectData]).map(({ name }) => name);
    expect(objectNames).toEqual([
      'Lead',
      'Enquiry',
      'SiteVisit',
      'Project',
      'Unit',
      'Booking',
      'Company',
      'CompaniesAPI',
      'FollowUp',
      'Activity',
      'CallDetail',
      'User',
    ]);
    expect(tx.fieldDefinition.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'new-tenant', objectId: 'object-5' },
      data: { isCustomField: true, isStandardField: false },
    });
    expect(tx.sequence.createMany).toHaveBeenCalledWith({
      data: ['LEAD', 'SITE_VISIT', 'FOLLOW_UP', 'ENQUIRY'].map((type) => ({
        tenantId: 'new-tenant',
        type,
        nextValue: 1,
      })),
      skipDuplicates: true,
    });
    expect(tx.fieldDefinition.createMany).toHaveBeenCalledWith({
      data: [{
        tenantId: 'new-tenant',
        objectId: expect.any(String),
        name: 'companyId',
        label: 'Company',
        fieldType: 'lookup',
        lookupObject: 'Company',
        required: true,
        editable: true,
        isCustomField: true,
        isStandardField: false,
        searchable: true,
        sortable: true,
        filterable: true,
        displayOrder: 0,
        createdBy: 'creator',
      }],
      skipDuplicates: true,
    });
    expect(tx.company.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId_normalizedName: { tenantId: 'new-tenant', normalizedName: 'new tenant' },
      },
      create: expect.objectContaining({ tenantId: 'new-tenant', name: 'New Tenant' }),
    }));
    expect(tx.customRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'new-tenant',
        objectId: 'object-7',
        recordNumber: 'tenant-company',
        data: { companyId: 'tenant-company' },
        createdBy: 'creator',
        updatedBy: 'creator',
      }),
    });

    const seededFields = vi.mocked(tx.fieldDefinition.createMany).mock.calls.flatMap((call) => {
      const data = call[0]?.data ?? [];
      return Array.isArray(data) ? data : [data];
    });
    const leadFirstName = seededFields.find((field) => field.name === 'firstName' && field.label === 'First Name');
    const leadId = seededFields.find((field) => field.name === 'id' && field.label === 'Lead ID');
    const bookingAmount = seededFields.find((field) => field.name === 'bookingAmount');
    expect(leadFirstName).toMatchObject({
      editable: true,
      isCustomField: true,
      isStandardField: false,
      isSystemField: false,
    });
    expect(leadId).toMatchObject({
      editable: true,
      isCustomField: true,
      isStandardField: false,
      isSystemField: false,
    });
    expect(bookingAmount).toMatchObject({
      editable: false,
      isCustomField: true,
      isStandardField: false,
    });
  });
});

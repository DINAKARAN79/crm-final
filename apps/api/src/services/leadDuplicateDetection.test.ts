import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  acquireLeadDuplicateLocks,
  duplicateLeadFields,
  duplicateLeadMessage,
  findLeadDuplicates,
  findLeadDuplicatesBatch,
  leadDuplicateContactKeys,
  normalizeLeadEmail,
  normalizeLeadPhone,
  validateLeadContactInput,
} from './leadDuplicateDetection';

function mockDatabase(leads: Array<Record<string, unknown>>) {
  return {
    fieldDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue(leads.map((lead) => ({ id: lead.id }))),
    lead: { findMany: vi.fn().mockResolvedValue(leads) },
  };
}

describe('lead contact normalization', () => {
  it('normalizes country-code and formatting differences to the same complete number', () => {
    expect(normalizeLeadPhone('+91 (987) 654-3210', '91')?.e164).toBe('+919876543210');
    expect(normalizeLeadPhone('98765 43210', '+91')?.e164).toBe('+919876543210');
    expect(normalizeLeadPhone('0091-9876543210')?.e164).toBe('+919876543210');
  });

  it('does not collapse different international calling codes to the same number', () => {
    expect(normalizeLeadPhone('+44 2071234567', '44')?.e164)
      .not.toBe(normalizeLeadPhone('+1 2071234567', '1')?.e164);
  });

  it('normalizes email addresses case-insensitively after trimming', () => {
    expect(normalizeLeadEmail('  SALES@Example.COM ')).toBe('sales@example.com');
  });

  it('creates tenant-comparison keys from formatted phones and case-insensitive emails', () => {
    expect(leadDuplicateContactKeys({
      phones: [{ field: 'phone', value: '+91 (987) 654-3210', countryCode: '91' }],
      emails: [{ field: 'email', value: ' SALES@Example.COM ' }],
    })).toEqual(['PHONE:+919876543210', 'EMAIL:sales@example.com']);
  });

  it('returns field-specific validation errors for malformed contacts and calling codes', () => {
    expect(validateLeadContactInput({
      phones: [
        { field: 'phone', value: 'call me 123', countryCode: '000' },
        { field: 'secondaryPhone', value: '(123)', countryCode: '91' },
      ],
      emails: [{ field: 'secondaryEmail', value: 'not-an-email' }],
    })).toEqual([
      { field: 'countryCode', message: 'Enter a valid country calling code (1 to 3 digits).' },
      { field: 'secondaryPhone', message: 'Secondary phone must contain 7 to 12 national digits and use a valid phone format.' },
      { field: 'secondaryEmail', message: 'Enter a valid email address.' },
    ]);
  });
});

describe('duplicate contact responses', () => {
  it('reports both duplicate contact fields without exposing a lead record', () => {
    const matches = [{
      lead: {
        id: 'private-lead-id',
        leadNumber: 'LN000001',
        firstName: 'Private',
        lastName: 'Person',
        company: 'Private Company',
        status: 'NEW',
        ownerId: 'private-owner',
        projectId: null,
        createdAt: new Date(),
      },
      matchedFields: ['phone', 'email'],
      ambiguous: false,
      evidence: [
        { contactKey: 'PHONE:+919876543210', field: 'phone', ambiguous: false },
        { contactKey: 'EMAIL:sales@example.com', field: 'email', ambiguous: false },
      ],
    }];

    expect(duplicateLeadFields(matches)).toEqual(['phone', 'email']);
    expect(duplicateLeadMessage(duplicateLeadFields(matches)))
      .toBe('This phone number and email already exist in your tenant.');
    expect(JSON.stringify({ code: 'DUPLICATE_LEAD', fields: duplicateLeadFields(matches) }))
      .not.toContain('private-lead-id');
  });
});

describe('findLeadDuplicates', () => {
  it('finds primary phone against a matching secondary phone on a related source', async () => {
    const database = mockDatabase([{
      id: 'lead-1',
      leadNumber: 'LN000001',
      firstName: 'Asha',
      lastName: 'Rao',
      company: 'Asha Rao',
      status: 'NEW',
      ownerId: 'owner-1',
      projectId: 'project-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      phone: '+919876543210',
      mobile: null,
      secondaryPhone: null,
      tertiaryPhone: null,
      countryCode: '+91',
      secondaryCountryCode: null,
      tertiaryCountryCode: null,
      email: null,
      secondaryEmail: null,
      alternateEmail: null,
      customFields: {},
      enquiries: [{
        phone: null,
        secondaryPhone: '98765-43210',
        tertiaryPhone: null,
        countryCode: null,
        secondaryCountryCode: '+91',
        tertiaryCountryCode: null,
        email: null,
        secondaryEmail: null,
      }],
    }]);

    const result = await findLeadDuplicates(database as unknown as Prisma.TransactionClient, 'tenant-1', {
      phones: [{ field: 'phone', value: '9876543210', countryCode: '+91' }],
      emails: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].lead.id).toBe('lead-1');
    expect(result[0].matchedFields).toContain('phone:enquiry.secondaryPhone');
  });

  it('matches phone numbers across arbitrary Lead phone slots', async () => {
    const database = mockDatabase([{
      id: 'lead-2',
      leadNumber: 'LN000002',
      firstName: 'Mira',
      lastName: 'Das',
      company: 'Mira Das',
      status: 'NEW',
      ownerId: null,
      projectId: null,
      createdAt: new Date('2026-01-02T00:00:00Z'),
      phone: '+919000000001',
      mobile: null,
      secondaryPhone: null,
      tertiaryPhone: '+919123456789',
      countryCode: '+91',
      secondaryCountryCode: null,
      tertiaryCountryCode: '+91',
      email: null,
      secondaryEmail: null,
      alternateEmail: null,
      customFields: {},
      enquiries: [],
    }]);

    const result = await findLeadDuplicates(database as unknown as Prisma.TransactionClient, 'tenant-1', {
      phones: [{ field: 'secondaryPhone', value: '(912) 345-6789', countryCode: '+91' }],
      emails: [],
    });

    expect(result[0].matchedFields).toContain('secondaryPhone:tertiaryPhone');
  });

  it('matches either incoming email to either stored email regardless of case', async () => {
    const database = mockDatabase([{
      id: 'lead-3',
      leadNumber: 'LN000003',
      firstName: 'Dev',
      lastName: 'Singh',
      company: 'Dev Singh',
      status: 'NEW',
      ownerId: null,
      projectId: null,
      createdAt: new Date('2026-01-03T00:00:00Z'),
      phone: null,
      mobile: null,
      secondaryPhone: null,
      tertiaryPhone: null,
      countryCode: null,
      secondaryCountryCode: null,
      tertiaryCountryCode: null,
      email: '  Dev@Example.com ',
      secondaryEmail: null,
      alternateEmail: null,
      customFields: {},
      enquiries: [],
    }]);

    const result = await findLeadDuplicates(database as unknown as Prisma.TransactionClient, 'tenant-1', {
      phones: [],
      emails: [{ field: 'secondaryEmail', value: 'dev@example.COM' }],
    });

    expect(result[0].matchedFields).toContain('secondaryEmail:email');
  });

  it('matches incoming tertiary email against Lead and historical enquiry tertiary email', async () => {
    const database = mockDatabase([{
      id: 'lead-tertiary-email',
      leadNumber: 'LN000008',
      firstName: 'Tara',
      lastName: 'Nair',
      company: 'Tara Nair',
      status: 'NEW',
      ownerId: null,
      projectId: null,
      createdAt: new Date('2026-01-08T00:00:00Z'),
      phone: null,
      mobile: null,
      secondaryPhone: null,
      tertiaryPhone: null,
      countryCode: null,
      secondaryCountryCode: null,
      tertiaryCountryCode: null,
      email: null,
      secondaryEmail: null,
      tertiaryEmail: 'third@lead.example',
      alternateEmail: null,
      customFields: {},
      enquiries: [{
        phone: null,
        secondaryPhone: null,
        tertiaryPhone: null,
        countryCode: null,
        secondaryCountryCode: null,
        tertiaryCountryCode: null,
        email: null,
        secondaryEmail: null,
        tertiaryEmail: 'third@enquiry.example',
      }],
    }]);

    const leadEmailMatches = await findLeadDuplicates(
      database as unknown as Prisma.TransactionClient,
      'tenant-1',
      { phones: [], emails: [{ field: 'tertiaryEmail', value: 'THIRD@LEAD.EXAMPLE' }] },
    );
    const enquiryEmailMatches = await findLeadDuplicates(
      database as unknown as Prisma.TransactionClient,
      'tenant-1',
      { phones: [], emails: [{ field: 'tertiaryEmail', value: 'third@enquiry.example' }] },
    );

    expect(leadEmailMatches[0].matchedFields).toContain('tertiaryEmail:tertiaryEmail');
    expect(enquiryEmailMatches[0].matchedFields).toContain('tertiaryEmail:enquiry.tertiaryEmail');
  });

  it('does not report candidates whose stored international phone is different', async () => {
    const database = mockDatabase([{
      id: 'lead-4',
      leadNumber: 'LN000004',
      firstName: 'Sam',
      lastName: 'Lee',
      company: 'Sam Lee',
      status: 'NEW',
      ownerId: null,
      projectId: null,
      createdAt: new Date('2026-01-04T00:00:00Z'),
      phone: '+442071234567',
      mobile: null,
      secondaryPhone: null,
      tertiaryPhone: null,
      countryCode: '+44',
      secondaryCountryCode: null,
      tertiaryCountryCode: null,
      email: null,
      secondaryEmail: null,
      alternateEmail: null,
      customFields: {},
      enquiries: [],
    }]);

    const result = await findLeadDuplicates(database as unknown as Prisma.TransactionClient, 'tenant-1', {
      phones: [{ field: 'phone', value: '+1 2071234567', countryCode: '+1' }],
      emails: [],
    });

    expect(result).toEqual([]);
  });

  it('flags an unscoped legacy local phone for review instead of assuming its country code', async () => {
    const database = mockDatabase([{
      id: 'lead-5',
      leadNumber: 'LN000005',
      firstName: 'Aarav',
      lastName: 'Shah',
      company: 'Aarav Shah',
      status: 'NEW',
      ownerId: null,
      projectId: null,
      createdAt: new Date('2026-01-05T00:00:00Z'),
      phone: '9876543210',
      mobile: null,
      secondaryPhone: null,
      tertiaryPhone: null,
      countryCode: null,
      secondaryCountryCode: null,
      tertiaryCountryCode: null,
      email: null,
      secondaryEmail: null,
      alternateEmail: null,
      customFields: {},
      enquiries: [],
    }]);

    const result = await findLeadDuplicates(database as unknown as Prisma.TransactionClient, 'tenant-1', {
      phones: [{ field: 'phone', value: '9876543210', countryCode: '+91' }],
      emails: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].ambiguous).toBe(true);
    expect(result[0].matchedFields).toContain('phone:possible.phone');
  });
});

describe('findLeadDuplicatesBatch', () => {
  it('fetches candidates once and keeps each imported row matched to its own contacts', async () => {
    const database = mockDatabase([
      {
        id: 'lead-phone',
        leadNumber: 'LN000006',
        firstName: 'Phone',
        lastName: 'Match',
        company: 'Phone Match',
        status: 'NEW',
        ownerId: null,
        projectId: null,
        createdAt: new Date('2026-01-06T00:00:00Z'),
        phone: '+919876543210',
        mobile: null,
        secondaryPhone: null,
        tertiaryPhone: null,
        countryCode: '+91',
        secondaryCountryCode: null,
        tertiaryCountryCode: null,
        email: null,
        secondaryEmail: null,
        alternateEmail: null,
        customFields: {},
        enquiries: [],
      },
      {
        id: 'lead-email',
        leadNumber: 'LN000007',
        firstName: 'Email',
        lastName: 'Match',
        company: 'Email Match',
        status: 'NEW',
        ownerId: null,
        projectId: null,
        createdAt: new Date('2026-01-07T00:00:00Z'),
        phone: null,
        mobile: null,
        secondaryPhone: null,
        tertiaryPhone: null,
        countryCode: null,
        secondaryCountryCode: null,
        tertiaryCountryCode: null,
        email: 'customer@example.com',
        secondaryEmail: null,
        alternateEmail: null,
        customFields: {},
        enquiries: [],
      },
    ]);

    const results = await findLeadDuplicatesBatch(database as unknown as Prisma.TransactionClient, 'tenant-1', [
      { phones: [{ field: 'phone', value: '9876543210', countryCode: '91' }], emails: [] },
      { phones: [], emails: [{ field: 'email', value: ' CUSTOMER@example.com ' }] },
    ]);

    expect(database.$queryRaw).toHaveBeenCalledOnce();
    expect(database.lead.findMany).toHaveBeenCalledOnce();
    expect(results.map((matches) => matches.map((match) => match.lead.id))).toEqual([
      ['lead-phone'],
      ['lead-email'],
    ]);
  });
});

describe('acquireLeadDuplicateLocks', () => {
  it('uses the same phone lock key for differently formatted versions of a number', async () => {
    const firstLock = vi.fn().mockResolvedValue(1);
    const secondLock = vi.fn().mockResolvedValue(1);
    const input = (value: string) => ({
      phones: [{ field: 'phone', value, countryCode: '91' }],
      emails: [],
    });

    await acquireLeadDuplicateLocks({ $executeRaw: firstLock } as unknown as Prisma.TransactionClient, 'tenant-1', input('+91 9876543210'));
    await acquireLeadDuplicateLocks({ $executeRaw: secondLock } as unknown as Prisma.TransactionClient, 'tenant-1', input('987-654-3210'));

    expect(firstLock.mock.calls[0][0].values).toContain('LEAD_DUPLICATE:tenant-1:PHONE:+919876543210');
    expect(secondLock.mock.calls[0][0].values).toContain('LEAD_DUPLICATE:tenant-1:PHONE:+919876543210');
  });
});

import { Prisma } from '@prisma/client';
import { prisma } from '@dct-crm/db';

type Database = Prisma.TransactionClient | typeof prisma;

export interface LeadDuplicatePhone {
  field: string;
  value?: string | null;
  countryCode?: string | null;
}

export interface LeadDuplicateEmail {
  field: string;
  value?: string | null;
}

export interface LeadDuplicateInput {
  phones: LeadDuplicatePhone[];
  emails: LeadDuplicateEmail[];
}

export interface LeadDuplicateMatch {
  lead: {
    id: string;
    leadNumber: string | null;
    firstName: string | null;
    lastName: string;
    company: string;
    status: string;
    ownerId: string | null;
    projectId: string | null;
    createdAt: Date;
  };
  matchedFields: string[];
  ambiguous: boolean;
  evidence: Array<{ contactKey: string; field: string; ambiguous: boolean }>;
}

export type LeadDuplicateField = 'phone' | 'email';

export function duplicateLeadFields(matches: LeadDuplicateMatch[]): LeadDuplicateField[] {
  const fields = new Set<LeadDuplicateField>();
  for (const match of matches) {
    for (const item of match.evidence) {
      if (item.contactKey.startsWith('PHONE:')) fields.add('phone');
      if (item.contactKey.startsWith('EMAIL:')) fields.add('email');
    }
  }
  const orderedFields: LeadDuplicateField[] = ['phone', 'email'];
  return orderedFields.filter((field) => fields.has(field));
}

export function duplicateLeadMessage(fields: LeadDuplicateField[]): string {
  if (fields.includes('phone') && fields.includes('email')) {
    return 'This phone number and email already exist in your tenant.';
  }
  if (fields.includes('phone')) return 'This phone number already exists in your tenant.';
  if (fields.includes('email')) return 'This email already exists in your tenant.';
  return 'A lead with these contact details already exists in your tenant.';
}

export interface NormalizedPhone {
  e164: string;
  digits: string;
  countryCode: string | null;
  nationalNumber: string;
}

function expectedNationalLength(countryCode: string): number | null {
  return ({
    '1': 10,
    '44': 10,
    '91': 10,
    '971': 9,
    '61': 9,
    '65': 8,
  } as Record<string, number>)[countryCode] ?? null;
}

export function normalizeCountryCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\+?\d{1,3}$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return /^[1-9]\d{0,2}$/.test(digits) ? digits : null;
}

export function normalizeLeadPhone(
  value: string | null | undefined,
  countryCode?: string | null,
): NormalizedPhone | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || !/^\+?[\d().\s-]+$/.test(trimmed)) return null;

  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);

  const suppliedCode = normalizeCountryCode(countryCode);
  const isExplicitInternational = trimmed.startsWith('+') || value.trim().startsWith('00');
  let code = suppliedCode;
  let nationalNumber = digits;

  if (isExplicitInternational) {
    code = suppliedCode && digits.startsWith(suppliedCode) ? suppliedCode : null;
    if (code) nationalNumber = digits.slice(code.length);
  } else if (
    suppliedCode &&
    digits.startsWith(suppliedCode) &&
    digits.length - suppliedCode.length >= 7 &&
    digits.length !== expectedNationalLength(suppliedCode)
  ) {
    nationalNumber = digits.slice(suppliedCode.length);
  } else if (suppliedCode) {
    if (digits.startsWith('0') && digits.length > 7) digits = digits.slice(1);
    nationalNumber = digits;
  } else {
    code = null;
  }

  if (code && nationalNumber.startsWith('0') && nationalNumber.length > 7) {
    nationalNumber = nationalNumber.replace(/^0+/, '');
  }
  const canonicalDigits = code ? `${code}${nationalNumber}` : digits;
  if (nationalNumber.length < 7 || nationalNumber.length > 12 || canonicalDigits.length > 15) return null;

  return {
    e164: `+${canonicalDigits}`,
    digits: canonicalDigits,
    countryCode: code,
    nationalNumber,
  };
}

export function normalizeLeadEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase('en-US');
  return normalized || null;
}

export function leadDuplicateContactKeys(input: LeadDuplicateInput): string[] {
  return [
    ...input.phones.flatMap((phone) => {
      const normalized = normalizeLeadPhone(phone.value, phone.countryCode);
      return normalized ? [`PHONE:${normalized.e164}`] : [];
    }),
    ...input.emails.flatMap((email) => {
      const normalized = normalizeLeadEmail(email.value);
      return normalized ? [`EMAIL:${normalized}`] : [];
    }),
  ];
}

export function validateLeadContactInput(input: LeadDuplicateInput): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  for (const phone of input.phones) {
    if (!phone.value?.trim()) continue;
    if (phone.value.trim().length > 64) {
      errors.push({ field: phone.field, message: 'Phone number must be 64 characters or fewer.' });
      continue;
    }
    const codeField = phone.field === 'phone'
      ? 'countryCode'
      : phone.field === 'secondaryPhone'
        ? 'secondaryCountryCode'
        : 'tertiaryCountryCode';
    if (phone.countryCode && !normalizeCountryCode(phone.countryCode)) {
      errors.push({ field: codeField, message: 'Enter a valid country calling code (1 to 3 digits).' });
      continue;
    }
    if (!normalizeLeadPhone(phone.value, phone.countryCode)) {
      errors.push({
        field: phone.field,
        message: `${phone.field === 'phone' ? 'Primary' : phone.field === 'secondaryPhone' ? 'Secondary' : 'Tertiary'} phone must contain 7 to 12 national digits and use a valid phone format.`,
      });
    }
  }
  for (const email of input.emails) {
    const value = email.value?.trim();
    if (value && (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
      errors.push({ field: email.field, message: 'Enter a valid email address.' });
    }
  }
  return errors;
}

function phoneSearchDigits(phone: NormalizedPhone): string[] {
  const values = new Set([phone.digits]);
  if (phone.countryCode) {
    values.add(phone.nationalNumber);
    values.add(`0${phone.nationalNumber}`);
  }
  return [...values];
}

function digitsOnly(value: string | null | undefined): string {
  return value?.replace(/\D/g, '') || '';
}

function storedCountryCode(
  lead: {
    countryCode: string | null;
    secondaryCountryCode: string | null;
    tertiaryCountryCode: string | null;
    enquiries: Array<{
      phone: string | null;
      secondaryPhone: string | null;
      tertiaryPhone: string | null;
      countryCode: string | null;
      secondaryCountryCode: string | null;
      tertiaryCountryCode: string | null;
    }>;
  },
  field: string,
  value: string,
): string | null {
  const direct = field === 'phone'
    ? lead.countryCode
    : field === 'secondaryPhone'
      ? lead.secondaryCountryCode
      : field === 'tertiaryPhone'
        ? lead.tertiaryCountryCode
        : lead.countryCode;
  if (direct) return direct;

  const enquiryField = field === 'secondaryPhone'
    ? 'secondaryPhone'
    : field === 'tertiaryPhone'
      ? 'tertiaryPhone'
      : 'phone';
  const enquiryCodeField = enquiryField === 'secondaryPhone'
    ? 'secondaryCountryCode'
    : enquiryField === 'tertiaryPhone'
      ? 'tertiaryCountryCode'
      : 'countryCode';
  const matchingEnquiry = lead.enquiries.find(
    (enquiry) => digitsOnly(enquiry[enquiryField]) === digitsOnly(value) && enquiry[enquiryCodeField],
  );
  return matchingEnquiry?.[enquiryCodeField] || null;
}

export async function findLeadDuplicates(
  db: Database,
  tenantId: string,
  input: LeadDuplicateInput,
): Promise<LeadDuplicateMatch[]> {
  const incomingPhones = input.phones.flatMap((phone) => {
    const normalized = normalizeLeadPhone(phone.value, phone.countryCode);
    return normalized ? [{ ...phone, normalized }] : [];
  });
  const incomingEmails = input.emails.flatMap((email) => {
    const normalized = normalizeLeadEmail(email.value);
    return normalized ? [{ ...email, normalized }] : [];
  });
  const phoneDigits = [...new Set(incomingPhones.flatMap(({ normalized }) => phoneSearchDigits(normalized)))];
  const emailAddresses = [...new Set(incomingEmails.map(({ normalized }) => normalized))];
  if (!phoneDigits.length && !emailAddresses.length) return [];

  const phoneDefinitions = phoneDigits.length
    ? await db.fieldDefinition.findMany({
        where: {
          tenantId,
          fieldType: 'phone',
          object: { name: { equals: 'Lead', mode: 'insensitive' } },
        },
        select: { name: true },
      })
    : [];
  const phoneValues = phoneDigits.length ? Prisma.join(phoneDigits) : Prisma.sql`NULL`;
  const emailValues = emailAddresses.length ? Prisma.join(emailAddresses) : Prisma.sql`NULL`;
  const leadPhoneFields = ['phone', 'mobile', 'secondaryPhone', 'tertiaryPhone'].map(
    (field) => Prisma.sql`regexp_replace(coalesce(l.${Prisma.raw(`"${field}"`)}, ''), '[^0-9]', '', 'g') IN (${phoneValues})`,
  );
  leadPhoneFields.push(...phoneDefinitions.map(({ name }) =>
    Prisma.sql`regexp_replace(coalesce(l."customFields" ->> ${name}, ''), '[^0-9]', '', 'g') IN (${phoneValues})`,
  ));
  const enquiryPhoneFields = ['phone', 'secondaryPhone', 'tertiaryPhone'].map(
    (field) => Prisma.sql`regexp_replace(coalesce(e.${Prisma.raw(`"${field}"`)}, ''), '[^0-9]', '', 'g') IN (${phoneValues})`,
  );
  const leadEmailFields = ['email', 'secondaryEmail', 'tertiaryEmail', 'alternateEmail'].map(
    (field) => Prisma.sql`lower(btrim(coalesce(l.${Prisma.raw(`"${field}"`)}, ''))) IN (${emailValues})`,
  );
  const enquiryEmailFields = ['email', 'secondaryEmail', 'tertiaryEmail'].map(
    (field) => Prisma.sql`lower(btrim(coalesce(e.${Prisma.raw(`"${field}"`)}, ''))) IN (${emailValues})`,
  );
  const clauses: Prisma.Sql[] = [];
  if (phoneDigits.length) {
    clauses.push(Prisma.sql`(${Prisma.join(leadPhoneFields, ' OR ')})`);
    clauses.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Enquiry" e
      WHERE e."tenantId" = l."tenantId" AND e."leadId" = l."id"
        AND (${Prisma.join(enquiryPhoneFields, ' OR ')})
    )`);
  }
  if (emailAddresses.length) {
    clauses.push(Prisma.sql`(${Prisma.join(leadEmailFields, ' OR ')})`);
    clauses.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Enquiry" e
      WHERE e."tenantId" = l."tenantId" AND e."leadId" = l."id"
        AND (${Prisma.join(enquiryEmailFields, ' OR ')})
    )`);
  }
  const candidateRows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT l."id" FROM "Lead" l
    WHERE l."tenantId" = ${tenantId} AND (${Prisma.join(clauses, ' OR ')})
  `);
  if (!candidateRows.length) return [];

  const leads = await db.lead.findMany({
    where: { tenantId, id: { in: candidateRows.map((row) => row.id) } },
    select: {
      id: true,
      leadNumber: true,
      firstName: true,
      lastName: true,
      company: true,
      status: true,
      ownerId: true,
      projectId: true,
      createdAt: true,
      phone: true,
      mobile: true,
      secondaryPhone: true,
      tertiaryPhone: true,
      countryCode: true,
      secondaryCountryCode: true,
      tertiaryCountryCode: true,
      email: true,
      secondaryEmail: true,
      tertiaryEmail: true,
      alternateEmail: true,
      customFields: true,
      enquiries: {
        select: {
          phone: true,
          secondaryPhone: true,
          tertiaryPhone: true,
          countryCode: true,
          secondaryCountryCode: true,
          tertiaryCountryCode: true,
          email: true,
          secondaryEmail: true,
          tertiaryEmail: true,
        },
      },
    },
  });

  return leads.flatMap((lead) => {
    const matchedFields = new Set<string>();
    const evidence = new Map<string, { contactKey: string; field: string; ambiguous: boolean }>();
    let ambiguous = false;
    const recordMatch = (contactKey: string, field: string, isAmbiguous = false) => {
      matchedFields.add(field);
      evidence.set(`${contactKey}:${field}`, { contactKey, field, ambiguous: isAmbiguous });
    };
    const leadPhoneEntries = [
      { field: 'phone', value: lead.phone },
      { field: 'mobile', value: lead.mobile },
      { field: 'secondaryPhone', value: lead.secondaryPhone },
      { field: 'tertiaryPhone', value: lead.tertiaryPhone },
    ];
    const customFields = lead.customFields && typeof lead.customFields === 'object'
      ? lead.customFields as Record<string, unknown>
      : {};
    for (const definition of phoneDefinitions) {
      const value = customFields[definition.name];
      if (typeof value === 'string') leadPhoneEntries.push({ field: definition.name, value });
    }
    for (const existing of leadPhoneEntries) {
      if (!existing.value) continue;
      const ownCode = storedCountryCode(lead, existing.field, existing.value);
      const candidates = [normalizeLeadPhone(existing.value, ownCode)];
      const unscopedExisting = ownCode || /^\s*(?:\+|00)/.test(existing.value)
        ? null
        : normalizeLeadPhone(existing.value);
      if (unscopedExisting) {
        for (const incoming of incomingPhones) {
          if (
            incoming.normalized.countryCode &&
            incoming.normalized.nationalNumber === unscopedExisting.nationalNumber
          ) {
            ambiguous = true;
            recordMatch(
              `PHONE:${incoming.normalized.e164}`,
              `${incoming.field}:possible.${existing.field}`,
              true,
            );
          }
        }
      }
      if (candidates.some((candidate) =>
        candidate && incomingPhones.some(({ normalized }) => normalized.e164 === candidate.e164),
      )) {
        for (const incoming of incomingPhones) {
          if (candidates.some((candidate) => candidate?.e164 === incoming.normalized.e164)) {
            recordMatch(`PHONE:${incoming.normalized.e164}`, `${incoming.field}:${existing.field}`);
          }
        }
      }
    }
    for (const enquiry of lead.enquiries) {
      const sourcePhones = [
        { field: 'phone', value: enquiry.phone, countryCode: enquiry.countryCode },
        { field: 'secondaryPhone', value: enquiry.secondaryPhone, countryCode: enquiry.secondaryCountryCode || enquiry.countryCode },
        { field: 'tertiaryPhone', value: enquiry.tertiaryPhone, countryCode: enquiry.tertiaryCountryCode || enquiry.secondaryCountryCode || enquiry.countryCode },
      ];
      for (const existing of sourcePhones) {
        if (!existing.value) continue;
        const candidates = [normalizeLeadPhone(
          existing.value,
          existing.countryCode,
        )];
        const unscopedExisting = existing.countryCode || /^\s*(?:\+|00)/.test(existing.value)
          ? null
          : normalizeLeadPhone(existing.value);
        if (unscopedExisting) {
          for (const incoming of incomingPhones) {
            if (
              incoming.normalized.countryCode &&
              incoming.normalized.nationalNumber === unscopedExisting.nationalNumber
            ) {
              ambiguous = true;
              recordMatch(
                `PHONE:${incoming.normalized.e164}`,
                `${incoming.field}:possible.enquiry.${existing.field}`,
                true,
              );
            }
          }
        }
        for (const incoming of incomingPhones) {
          if (candidates.some((candidate) => candidate?.e164 === incoming.normalized.e164)) {
            recordMatch(`PHONE:${incoming.normalized.e164}`, `${incoming.field}:enquiry.${existing.field}`);
          }
        }
      }
    }

    const existingEmails = [
      { field: 'email', value: lead.email },
      { field: 'secondaryEmail', value: lead.secondaryEmail },
      { field: 'tertiaryEmail', value: lead.tertiaryEmail },
      { field: 'alternateEmail', value: lead.alternateEmail },
      ...lead.enquiries.flatMap((enquiry) => [
        { field: 'enquiry.email', value: enquiry.email },
        { field: 'enquiry.secondaryEmail', value: enquiry.secondaryEmail },
        { field: 'enquiry.tertiaryEmail', value: enquiry.tertiaryEmail },
      ]),
    ];
    for (const existing of existingEmails) {
      const normalized = normalizeLeadEmail(existing.value);
      if (!normalized) continue;
      for (const incoming of incomingEmails) {
        if (normalized === incoming.normalized) {
          recordMatch(`EMAIL:${incoming.normalized}`, `${incoming.field}:${existing.field}`);
        }
      }
    }

    return matchedFields.size
      ? [{ lead: {
          id: lead.id,
          leadNumber: lead.leadNumber,
          firstName: lead.firstName,
          lastName: lead.lastName,
          company: lead.company,
          status: lead.status,
          ownerId: lead.ownerId,
          projectId: lead.projectId,
          createdAt: lead.createdAt,
        }, matchedFields: [...matchedFields].sort(), ambiguous, evidence: [...evidence.values()] }]
      : [];
  }).sort((left, right) =>
    left.lead.createdAt.getTime() - right.lead.createdAt.getTime() ||
    left.lead.id.localeCompare(right.lead.id),
  );
}

export async function findLeadDuplicatesBatch(
  db: Database,
  tenantId: string,
  inputs: LeadDuplicateInput[],
): Promise<LeadDuplicateMatch[][]> {
  if (!inputs.length) return [];
  const combinedInput: LeadDuplicateInput = {
    phones: inputs.flatMap((input) => input.phones),
    emails: inputs.flatMap((input) => input.emails),
  };
  const combinedMatches = await findLeadDuplicates(db, tenantId, combinedInput);
  return inputs.map((input) => {
    const inputKeys = new Set(leadDuplicateContactKeys(input));
    return combinedMatches.flatMap((match) => {
      const evidence = match.evidence.filter((item) => inputKeys.has(item.contactKey));
      if (!evidence.length) return [];
      return [{
        ...match,
        matchedFields: [...new Set(evidence.map((item) => item.field))].sort(),
        ambiguous: evidence.some((item) => item.ambiguous),
        evidence,
      }];
    });
  });
}

export async function acquireLeadDuplicateLocks(
  tx: Prisma.TransactionClient,
  tenantId: string,
  input: LeadDuplicateInput,
): Promise<void> {
  const lockKeys = [
    ...input.phones.flatMap((phone) => {
      const normalized = normalizeLeadPhone(phone.value, phone.countryCode);
      return normalized ? [`PHONE:${normalized.e164}`] : [];
    }),
    ...input.emails.flatMap((email) => {
      const normalized = normalizeLeadEmail(email.value);
      return normalized ? [`EMAIL:${normalized}`] : [];
    }),
  ];
  for (const key of [...new Set(lockKeys)].sort()) {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`LEAD_DUPLICATE:${tenantId}:${key}`}, 0))
    `);
  }
}

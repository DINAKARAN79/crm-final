import { Router, Response } from 'express';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { prisma, unitFieldTags } from '@dct-crm/db';
import { leadCreateSchema, leadUpdateSchema, resolveUnitLocation } from '@dct-crm/shared';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { bulkImportRecords, listRecords } from '../services/dynamicCrud';
import { getFieldDefinitions, getObjectDefinition } from '../services/metadata';
import {
  applyScope,
  canAccessLead,
  getLeadRecordScope,
  getScopeClause,
  leadScopeClause,
} from '../services/recordAccess';
import {
  leadDuplicateInputForEnquiry,
  processLeadEnquiryBatch,
  sourceEnumValue,
  type LeadEnquiryInput,
} from '../services/enquiryProcessing';
import { moveLeadToBookedBucket } from '../services/bookedBucket';
import {
  duplicateLeadFields,
  duplicateLeadMessage,
  findLeadDuplicatesBatch,
  leadDuplicateContactKeys,
} from '../services/leadDuplicateDetection';
import { getLeadPicklistOptions, validateLeadPicklists } from '../services/leadPicklists';
import { importUserRows } from '../services/userImport';
import { ensureUserObjectOnce } from '../services/userObject';

const router = Router();
router.use(authenticate);
const MAX_IMPORT_RECORDS = 100_000;
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const LEAD_IMPORT_BATCH_SIZE = 500;
const STANDARD_IMPORT_BATCH_SIZE = 500;

const STANDARD_EXPORT_MODELS: Record<string, string> = {
  lead: 'lead',
  sitevisit: 'siteVisit',
  project: 'project',
  unit: 'unit',
  task: 'task',
  followup: 'followUp',
  activity: 'activity',
};

const STANDARD_IMPORT_CONFIG: Record<string, { model: string; hasCreator: boolean }> = Object.fromEntries(
  Object.entries(STANDARD_EXPORT_MODELS).map(([name, model]) => [name, { model, hasCreator: ['lead', 'project', 'unit', 'task', 'followUp', 'activity'].includes(model) }])
);

const LEAD_STATUSES = new Set([
  'NEW',
  'INCOMING',
  'PROSPECT',
  'SITE_VISIT_SCHEDULED',
  'SITE_VISIT_HAPPENED',
  'BOOKED',
  'LOST',
]);

function normalizeLeadStatus(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const aliases: Record<string, string> = {
    VISIT_SCHEDULED: 'SITE_VISIT_SCHEDULED',
    SITE_VISIT_BOOKED: 'SITE_VISIT_SCHEDULED',
    VISIT_HAPPENED: 'SITE_VISIT_HAPPENED',
    SITE_VISIT_COMPLETED: 'SITE_VISIT_HAPPENED',
  };
  return aliases[normalized] || normalized;
}

const LEAD_IMPORT_ASSIGNMENT_DEFAULTS: Record<string, { userType?: 'Pre Sales' | 'SVC' | 'Sales'; profileNames: string[] }> = {
  NEW: { userType: 'Pre Sales', profileNames: ['Pre Sales', 'Presales'] },
  INCOMING: { userType: 'Pre Sales', profileNames: ['Pre Sales', 'Presales'] },
  PROSPECT: { userType: 'SVC', profileNames: ['SVC'] },
  SITE_VISIT_SCHEDULED: { userType: 'SVC', profileNames: ['SVC'] },
  SITE_VISIT_HAPPENED: { userType: 'Sales', profileNames: ['Sales', 'Sales Executive'] },
  BOOKED: { profileNames: [] },
  LOST: { profileNames: [] },
};

function isImportAdministrator(req: AuthRequest): boolean {
  return Boolean(req.user?.isAdmin || req.user?.isSuperAdmin);
}

function getLeadImportAssignment(status: string, profileOverrides: Map<string, string[]>) {
  const defaults = LEAD_IMPORT_ASSIGNMENT_DEFAULTS[status] || LEAD_IMPORT_ASSIGNMENT_DEFAULTS.NEW;
  return {
    userType: defaults.userType,
    profileNames: profileOverrides.get(status) ?? defaults.profileNames,
  };
}

router.get('/import/lead-status-profiles', async (req: AuthRequest, res: Response) => {
  if (!isImportAdministrator(req)) {
    return res.status(403).json({ success: false, error: 'Administrator access is required.' });
  }
  try {
    const [savedProfiles, bookedBucketSetting] = await Promise.all([
      prisma.leadImportStatusProfile.findMany({
        where: { tenantId: req.tenantId! },
      }),
      prisma.bookedBucketSetting.findUnique({
        where: { tenantId: req.tenantId! },
        select: {
          isActive: true,
          members: {
            where: { isActive: true, user: { isActive: true, tenantId: req.tenantId! } },
            select: { id: true },
          },
        },
      }),
    ]);
    const savedByStatus = new Map(savedProfiles.map((item) => [item.status, item.profileNames]));
    const profiles = Object.entries(LEAD_IMPORT_ASSIGNMENT_DEFAULTS).map(([status, defaults]) => ({
      status,
      userType: status === 'BOOKED' ? 'BOOKED_BUCKET' : defaults.userType || 'ADMIN_FALLBACK',
      profileNames: Array.isArray(savedByStatus.get(status))
        ? (savedByStatus.get(status) as unknown[]).filter((value): value is string => typeof value === 'string')
        : defaults.profileNames,
    }));
    return res.json({
      success: true,
      data: {
        profiles,
        bookedBucket: {
          isActive: bookedBucketSetting?.isActive ?? false,
          ownerCount: bookedBucketSetting?.members.length || 0,
        },
      },
    });
  } catch (error) {
    console.error('Lead import status profile load failed:', error);
    return res.status(500).json({ success: false, error: 'Unable to load Lead import assignment profiles.' });
  }
});

router.put('/import/lead-status-profiles', async (req: AuthRequest, res: Response) => {
  if (!isImportAdministrator(req)) {
    return res.status(403).json({ success: false, error: 'Administrator access is required.' });
  }
  const bodySchema = z.object({
    profiles: z.array(z.object({
      status: z.string().refine((status) => Object.prototype.hasOwnProperty.call(LEAD_IMPORT_ASSIGNMENT_DEFAULTS, status)),
      profileNames: z.array(z.string().trim().min(1).max(80)).max(10),
    }).strict()).min(1),
  }).strict();
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Provide valid Lead statuses and up to 10 profile names per status.' });
  }
  if (new Set(parsed.data.profiles.map((profile) => profile.status)).size !== parsed.data.profiles.length) {
    return res.status(400).json({ success: false, error: 'Each Lead status can be configured only once.' });
  }
  try {
    await prisma.$transaction(parsed.data.profiles.map((profile) =>
      prisma.leadImportStatusProfile.upsert({
        where: { tenantId_status: { tenantId: req.tenantId!, status: profile.status } },
        create: {
          tenantId: req.tenantId!,
          status: profile.status,
          profileNames: profile.profileNames,
          updatedById: req.user!.id,
        },
        update: { profileNames: profile.profileNames, updatedById: req.user!.id },
      }),
    ));
    return res.json({ success: true, data: { profiles: parsed.data.profiles } });
  } catch (error) {
    console.error('Lead import status profile save failed:', error);
    return res.status(500).json({ success: false, error: 'Unable to save Lead import assignment profiles.' });
  }
});

function convertImportValue(value: string, fieldType: string) {
  if (value === '') return undefined;
  if (['number', 'integer', 'decimal', 'currency', 'percentage'].includes(fieldType)) return Number(value);
  if (fieldType === 'boolean') return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
  if (fieldType === 'date' || fieldType === 'dateTime') return new Date(value);
  return value;
}

function importValueError(value: unknown, fieldType: string, rawValue?: string): string | null {
  if (['number', 'integer', 'decimal', 'currency', 'percentage'].includes(fieldType)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a valid number.';
    if (fieldType === 'integer' && !Number.isInteger(value)) return 'Enter a whole number.';
  }
  if ((fieldType === 'date' || fieldType === 'dateTime') && (!(value instanceof Date) || Number.isNaN(value.getTime()))) {
    return 'Enter a valid date.';
  }
  if (fieldType === 'boolean' && !['true', 'false', '1', '0', 'yes', 'no'].includes((rawValue || '').trim().toLowerCase())) {
    return 'Enter a valid true/false value.';
  }
  return null;
}

const UNIT_IMPORT_STATUSES = new Set(['AVAILABLE', 'RESERVED', 'BOOKED', 'HOLD', 'SOLD', 'BLOCKED']);

const UNIT_IMPORT_COLUMNS: Record<string, string> = {
  Unit_Number__c: 'number',
  number: 'number',
  Unit_Type__c: 'type',
  type: 'type',
  Block__c: 'block',
  block: 'block',
  Floor__c: 'floor',
  floor: 'floor',
  Saleable_Area__c: 'area',
  area: 'area',
  Base_Price__c: 'price',
  Unit_Price__c: 'price',
  price: 'price',
  Status__c: 'status',
  status: 'status',
  Buildup_Area__c: 'buildupArea',
  buildupArea: 'buildupArea',
  Allowed_Discountt__c: 'allowedDiscount',
  allowedDiscount: 'allowedDiscount',
  Minimum_Booking_Amount__c: 'minimumBookingAmount',
  minimumBookingAmount: 'minimumBookingAmount',
  MSP__c: 'msp',
  msp: 'msp',
  PLC__c: 'plc',
  plc: 'plc',
  Non_PLC__c: 'nonPlc',
  nonPlc: 'nonPlc',
  Registration_Date__c: 'registrationDate',
  registrationDate: 'registrationDate',
  OwnerId: 'ownerId',
  ownerId: 'ownerId',
  Customer__c: 'customerLeadId',
  customerLeadId: 'customerLeadId',
  Bookingdate__c: 'bookingLeadId',
  bookingLeadId: 'bookingLeadId',
  Opportunity__c: 'opportunityLeadId',
  opportunityLeadId: 'opportunityLeadId',
  Name: 'unitCode',
  unitCode: 'unitCode',
  Project__c: 'project',
  Project_Name__c: 'project',
  projectId: 'project',
  Area__c: 'areaField',
};

function importNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function importText(value: unknown) {
  if (value == null) return '';
  return String(value).trim();
}

async function nextImportedUnitCode(tenantId: string) {
  const rows = await prisma.$queryRaw<Array<{ unitCode: string }>>`
    SELECT "unitCode"
    FROM "Unit"
    WHERE "tenantId" = ${tenantId}
      AND "unitCode" ~ '^U-[0-9]+$'
    ORDER BY LENGTH("unitCode") DESC, "unitCode" DESC
    LIMIT 1
  `;
  const current = rows[0]?.unitCode ? Number(rows[0].unitCode.slice(2)) : 0;
  const next = Number.isFinite(current) ? current + 1 : 1;
  return `U-${String(next).padStart(4, '0')}`;
}

async function importUnitRecords(input: {
  tenantId: string;
  userId: string;
  fields: string[];
  records: Record<string, string>[];
  fieldTypes: Map<string, string>;
}) {
  const projects = new Map<string, { id: string; name: string; projectType: string | null } | null>();
  const users = new Map<string, string | null>();
  const leads = new Map<string, string | null>();
  let importedCount = 0;
  const importErrors: { index: number; error: string }[] = [];
  const rowResults: { index: number; status: 'success' | 'failed'; error?: string }[] = [];

  const resolveProject = async (value: string) => {
    const key = value.trim().toLowerCase();
    if (projects.has(key)) return projects.get(key) ?? null;
    const project = await prisma.project.findFirst({
      where: {
        tenantId: input.tenantId,
        OR: [{ id: value.trim() }, { name: { equals: value.trim(), mode: 'insensitive' } }],
      },
      select: { id: true, name: true, projectType: true },
    });
    projects.set(key, project);
    return project;
  };

  const resolveUser = async (value: string) => {
    const key = value.trim().toLowerCase();
    if (users.has(key)) return users.get(key) ?? null;
    const user = await prisma.user.findFirst({
      where: {
        tenantId: input.tenantId,
        OR: [{ id: value.trim() }, { email: { equals: value.trim(), mode: 'insensitive' } }],
      },
      select: { id: true },
    });
    users.set(key, user?.id ?? null);
    return user?.id ?? null;
  };

  const resolveLead = async (value: string) => {
    const key = value.trim().toLowerCase();
    if (leads.has(key)) return leads.get(key) ?? null;
    const lead = await prisma.lead.findFirst({
      where: {
        tenantId: input.tenantId,
        OR: [{ id: value.trim() }, { leadNumber: { equals: value.trim(), mode: 'insensitive' } }],
      },
      select: { id: true },
    });
    leads.set(key, lead?.id ?? null);
    return lead?.id ?? null;
  };

  for (let index = 0; index < input.records.length; index += 1) {
    const row = input.records[index];
    const values: Record<string, unknown> = {};
    for (const field of input.fields) {
      const column = UNIT_IMPORT_COLUMNS[field];
      if (!column || column === 'project') continue;
      const value = convertImportValue(String(row[field] ?? ''), input.fieldTypes.get(field) || 'text');
      if (value === undefined) continue;
      values[column] = value;
    }

    const fail = (detail: string) => {
      const message = `Import failed on row ${index + 2}: ${detail}`;
      importErrors.push({ index, error: message });
      rowResults.push({ index, status: 'failed', error: message });
    };

    const projectValue = input.fields
      .filter((field) => UNIT_IMPORT_COLUMNS[field] === 'project')
      .map((field) => String(row[field] ?? '').trim())
      .find(Boolean);
    if (!projectValue) {
      fail('Project is required.');
      continue;
    }
    const project = await resolveProject(projectValue);
    if (!project) {
      fail(`Project "${projectValue}" was not found for this company.`);
      continue;
    }

    const number = importText(values.number);
    const type = importText(values.type);
    if (!number) {
      fail('Unit Number is required.');
      continue;
    }
    if (!type) {
      fail('Unit Type is required.');
      continue;
    }
    const price = importNumber(values.price);
    if (price == null || price < 0) {
      fail('Unit Price is required.');
      continue;
    }
    const floor = values.floor == null || values.floor === '' ? null : importNumber(values.floor);
    const buildupArea = values.buildupArea == null || values.buildupArea === '' ? null : importNumber(values.buildupArea);
    const minimumBookingAmount = values.minimumBookingAmount == null || values.minimumBookingAmount === '' ? null : importNumber(values.minimumBookingAmount);
    const area = values.area == null || values.area === '' ? null : importNumber(values.area);
    const areaField = values.areaField == null || values.areaField === '' ? null : importNumber(values.areaField);
    if (floor === undefined || (floor != null && !Number.isInteger(floor))) {
      fail('Floor must be a whole number.');
      continue;
    }
    if (buildupArea === undefined || (buildupArea != null && !Number.isInteger(buildupArea))) {
      fail('Buildup Area must be a whole number.');
      continue;
    }
    if (minimumBookingAmount === undefined || (minimumBookingAmount != null && !Number.isInteger(minimumBookingAmount))) {
      fail('Minimum Booking Amount must be a whole number.');
      continue;
    }
    if (area === undefined || (area != null && area < 0) || areaField === undefined || (areaField != null && areaField < 0)) {
      fail('Area must be zero or greater.');
      continue;
    }

    const status = importText(values.status).toUpperCase();
    if (status && !UNIT_IMPORT_STATUSES.has(status)) {
      fail('Status must be AVAILABLE, RESERVED, BOOKED, HOLD, SOLD, or BLOCKED.');
      continue;
    }
    const allowedDiscount = importText(values.allowedDiscount);
    if (allowedDiscount.length > 25) {
      fail('Allowed Discountt can be at most 25 characters.');
      continue;
    }
    const block = importText(values.block);
    if (block.length > 255) {
      fail('Block can be at most 255 characters.');
      continue;
    }

    const location = resolveUnitLocation({
      type,
      block,
      floor,
      projectType: project.projectType,
    });
    if (!location.ok) {
      fail(location.error);
      continue;
    }

    const ownerValue = importText(values.ownerId);
    const customerValue = importText(values.customerLeadId);
    const bookingValue = importText(values.bookingLeadId);
    const opportunityValue = importText(values.opportunityLeadId);
    const ownerId = ownerValue ? await resolveUser(ownerValue) : null;
    const customerLeadId = customerValue ? await resolveLead(customerValue) : null;
    const bookingLeadId = bookingValue ? await resolveLead(bookingValue) : null;
    const opportunityLeadId = opportunityValue ? await resolveLead(opportunityValue) : null;
    if (ownerValue && !ownerId) {
      fail(`Owner "${ownerValue}" was not found.`);
      continue;
    }
    if (customerValue && !customerLeadId) {
      fail(`Customer "${customerValue}" was not found.`);
      continue;
    }
    if (bookingValue && !bookingLeadId) {
      fail(`Opportunity "${bookingValue}" was not found.`);
      continue;
    }
    if (opportunityValue && !opportunityLeadId) {
      fail(`Opportunity "${opportunityValue}" was not found.`);
      continue;
    }

    const registrationDate = values.registrationDate instanceof Date ? values.registrationDate : null;
    if (values.registrationDate && !(registrationDate && !Number.isNaN(registrationDate.getTime()))) {
      fail('Registration Date is not a valid date.');
      continue;
    }

    const duplicate = await prisma.unit.findFirst({
      where: {
        tenantId: input.tenantId,
        projectId: project.id,
        number,
        block: location.block,
        floor: location.floor,
      },
      select: { id: true },
    });
    if (duplicate) {
      fail('Unit number already exists in this location.');
      continue;
    }

    const unitCode = importText(values.unitCode) || await nextImportedUnitCode(input.tenantId);
    try {
      await prisma.$transaction([
        prisma.unit.create({
          data: {
            tenantId: input.tenantId,
            projectId: project.id,
            unitCode,
            number,
            type: location.type,
            block: location.block,
            floor: location.floor,
            price,
            area,
            status: (status || 'AVAILABLE') as 'AVAILABLE',
            buildupArea,
            allowedDiscount: allowedDiscount || null,
            minimumBookingAmount,
            msp: importText(values.msp) || null,
            plc: importText(values.plc) || null,
            nonPlc: importText(values.nonPlc) || null,
            registrationDate,
            ownerId,
            customerLeadId,
            bookingLeadId,
            opportunityLeadId,
            createdById: input.userId,
            updatedById: input.userId,
            customFields: unitFieldTags({
              allowedDiscount: allowedDiscount || null,
              price,
              buildupArea,
              createdById: input.userId,
              customerLeadId,
              floor: location.floor,
              updatedById: input.userId,
              minimumBookingAmount,
              msp: importText(values.msp) || null,
              nonPlc: importText(values.nonPlc) || null,
              bookingLeadId,
              opportunityLeadId,
              ownerId,
              plc: importText(values.plc) || null,
              projectId: project.id,
              projectName: project.name,
              registrationDate,
              area,
              areaField,
              status: status || 'AVAILABLE',
              unitCode,
              number,
              type: location.type,
              block: location.block,
            }),
          },
        }),
        prisma.project.update({
          where: { id: project.id },
          data: { totalUnits: { increment: 1 } },
        }),
      ]);
      importedCount += 1;
      rowResults.push({ index, status: 'success' });
    } catch (error: any) {
      const detail = error?.code === 'P2002'
        ? 'Unit number already exists in this location.'
        : 'This row could not be saved.';
      fail(detail);
    }
  }

  return { importedCount, importErrors, rowResults };
}

function isAllocatedProjectField(field: { name: string; label?: string }): boolean {
  const normalizedName = field.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedLabel = field.label?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
  return [
    'project',
    'projectid',
    'projectname',
    'allocatedproject',
    'allocatedprojectid',
    'sfallocatedproject',
    'sfallocatedprojectc',
    'projectassigned',
  ].includes(normalizedName) || normalizedLabel === 'allocatedproject';
}

router.post('/import', requirePermission('DATA_IMPORT'), async (req: AuthRequest, res: Response) => {
  let leadImportJobId: string | undefined;
  let leadImportCounts: { totalRows: number; createdCount: number; linkedCount: number } | undefined;
  try {
    const { objectName, fields, csv } = req.body;
    if (typeof objectName !== 'string' || !objectName.trim()) {
      return res.status(400).json({ success: false, error: 'objectName is required' });
    }
    if (!Array.isArray(fields) || fields.length === 0 || fields.some((field) => typeof field !== 'string')) {
      return res.status(400).json({ success: false, error: 'At least one field is required' });
    }
    if (typeof csv !== 'string' || !csv.trim()) {
      return res.status(400).json({ success: false, error: 'CSV content is required' });
    }
    if (Buffer.byteLength(csv, 'utf8') > MAX_IMPORT_BYTES) {
      return res.status(413).json({ success: false, error: 'CSV imports are limited to 25 MB.' });
    }

    if (objectName.trim().toLowerCase() === 'user') await ensureUserObjectOnce(req.tenantId!);
    const object = await getObjectDefinition(req.tenantId!, objectName.trim());
    if (!object) return res.status(404).json({ success: false, error: 'Object not found' });
    const normalizedObjectName = String(object?.name || objectName.trim()).trim().toLowerCase();
    const availableFields = (await getFieldDefinitions(req.tenantId!, object.id) as Array<{ name: string; label?: string; required: boolean; isActive: boolean; isSystemField: boolean; fieldType?: string }>).filter((field) => field.isActive && !field.isSystemField);
    if (normalizedObjectName === 'lead' && !availableFields.some((field) => field.name === 'originalSubmissionId')) {
      availableFields.push({
        name: 'originalSubmissionId',
        label: 'Original Submission ID (Enquiry source-system key)',
        required: false,
        isActive: true,
        isSystemField: false,
        fieldType: 'text',
      });
    }
    if (normalizedObjectName === 'lead') {
      if (!availableFields.some((field) => field.name === 'status')) {
        availableFields.push({ name: 'status', label: 'Lead Status', required: false, isActive: true, isSystemField: false, fieldType: 'text' });
      }
      if (!availableFields.some((field) => field.name === 'ownerId')) {
        availableFields.push({ name: 'ownerId', label: 'Owner (user ID or email)', required: false, isActive: true, isSystemField: false, fieldType: 'text' });
      }
    }
    const availableNames = new Set(availableFields.map((field) => field.name));
    const invalidFields = fields.filter((field) => !availableNames.has(field));
    if (invalidFields.length > 0) {
      return res.status(400).json({ success: false, error: `Invalid fields: ${invalidFields.join(', ')}` });
    }
    const requiredFields = availableFields.filter((field) => field.required).map((field) => field.name);
    const missingRequired = requiredFields.filter((field) => !fields.includes(field));
    if (missingRequired.length > 0) {
      return res.status(400).json({ success: false, error: `Please select all required fields: ${missingRequired.join(', ')}` });
    }

    const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: 'CSV must contain at least one data row' });
    }
    if (rows.length > MAX_IMPORT_RECORDS) {
      return res.status(400).json({ success: false, error: `Import is limited to ${MAX_IMPORT_RECORDS.toLocaleString()} records per request` });
    }
    const csvFields = Object.keys(rows[0]);
    const missingCsvFields = fields.filter((field) => !csvFields.includes(field));
    if (missingCsvFields.length > 0) {
      return res.status(400).json({ success: false, error: `CSV is missing selected fields: ${missingCsvFields.join(', ')}` });
    }
    if (normalizedObjectName === 'user') {
      const userImport = await importUserRows({
        tenantId: req.tenantId!,
        actorId: req.user!.id,
        rows,
      });
      if (userImport.importedCount === 0 && userImport.importErrors.length > 0) {
        return res.status(400).json({
          success: false,
          error: userImport.importErrors[0].error,
          data: { count: 0, errors: userImport.importErrors, rowResults: userImport.rowResults },
        });
      }
      return res.status(201).json({
        success: true,
        data: { count: userImport.importedCount, errors: userImport.importErrors, rowResults: userImport.rowResults },
      });
    }

    const invalidRequiredRows = rows.map((row, index) => ({
      index,
      fields: requiredFields.filter((field) => !String(row[field] ?? '').trim()),
    })).filter(({ fields: emptyFields }) => emptyFields.length > 0);
    if (invalidRequiredRows.length > 0 && normalizedObjectName !== 'lead') {
      const errors = invalidRequiredRows.map(({ index, fields: emptyFields }) => ({
        index,
        error: `Import failed on row ${index + 2}: Empty required fields: ${emptyFields.join(', ')}`,
      }));
      const errorsByIndex = new Map(errors.map(({ index, error }) => [index, error]));
      const rowResults = rows.map((_, index) => ({
        index,
        status: 'failed' as const,
        error: errorsByIndex.get(index) || `Not imported because validation failed on row ${errors[0].index + 2}.`,
      }));
      return res.status(400).json({
        success: false,
        error: errors[0].error,
        data: { count: 0, errors, rowResults },
      });
    }

    const records = rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? ''])));
    const standardConfig = STANDARD_IMPORT_CONFIG[objectName.trim().toLowerCase()];
    if (standardConfig) {
      const delegate = (prisma as any)[standardConfig.model];
      const fieldTypes = new Map(availableFields.map((field: any) => [field.name, field.fieldType]));

      if (standardConfig.model === 'lead') {
        if (!isImportAdministrator(req)) {
          return res.status(403).json({ success: false, error: 'Administrator access is required to import Leads.' });
        }
        const leadPicklistOptions = await getLeadPicklistOptions(req.tenantId!);
        const leadFields = new Set(Object.keys(leadCreateSchema.shape));
        const enquiryFields = new Set([
          'secondaryPhone', 'tertiaryPhone', 'secondaryEmail', 'tertiaryEmail',
          'originalSubmissionId', 'countryCode',
          'secondaryCountryCode', 'tertiaryCountryCode', 'subSource', 'campaignId',
          'campaign', 'subCampaignId', 'subCampaign', 'medium', 'enquiryDescription',
          'channelPartner', 'enquiryDate',
        ]);
        const allocatedProjectFields = fields.filter((field) => {
          const definition = availableFields.find((candidate) => candidate.name === field);
          return definition && isAllocatedProjectField(definition);
        });
        const resolvedProjects = new Map<string, string>();
        const ownerCache = new Map<string, string | null>();
        const fallbackAdmin = await prisma.user.findFirst({
          where: { tenantId: req.tenantId!, isActive: true, isSuperAdmin: false, profile: { isAdmin: true } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (!fallbackAdmin) {
          return res.status(400).json({ success: false, error: 'No active System Administrator is available for lead import assignment.' });
        }
        const bookedBucketSetting = await prisma.bookedBucketSetting.findUnique({
          where: { tenantId: req.tenantId! },
          select: {
            isActive: true,
            members: {
              where: { isActive: true, user: { isActive: true, tenantId: req.tenantId! } },
              select: { userId: true },
            },
          },
        });
        const bookedBucketOwnerCount = bookedBucketSetting?.members.length || 0;
        const savedProfiles = await prisma.leadImportStatusProfile.findMany({
          where: { tenantId: req.tenantId! },
        });
        const profileOverrides = new Map<string, string[]>(
          savedProfiles.map((item) => [
            item.status,
            Array.isArray(item.profileNames)
              ? item.profileNames.filter((value: unknown): value is string => typeof value === 'string')
              : [],
          ]),
        );
        const importJob = await prisma.leadImportJob.create({
          data: {
            tenantId: req.tenantId!,
            createdById: req.user!.id,
            totalRows: records.length,
          },
          select: { id: true },
        });
        leadImportJobId = importJob.id;
        leadImportCounts = { totalRows: records.length, createdCount: 0, linkedCount: 0 };
        const resolveImportOwner = async (value: string) => {
          const normalized = value.trim().toLocaleLowerCase();
          if (!normalized) return undefined;
          if (!ownerCache.has(normalized)) {
            const user = await prisma.user.findFirst({
              where: {
                tenantId: req.tenantId!,
                isActive: true,
                OR: [{ id: value.trim() }, { email: { equals: value.trim(), mode: 'insensitive' } }],
              },
              select: { id: true },
            });
            ownerCache.set(normalized, user?.id || null);
          }
          return ownerCache.get(normalized) || null;
        };
        const inputs: Array<{ index: number; input: LeadEnquiryInput }> = [];
        const errors: { index: number; row: number; error: string; duplicateFields?: string[] }[] = [];
        const rowResults: {
          index: number;
          row: number;
          status: 'success' | 'failed';
          error?: string;
          duplicateFields?: string[];
          leadNumber?: string;
          projectName?: string;
          leadStatus?: string;
          assignedOwner?: string;
          assignmentGroup?: string;
        }[] = [];
        for (let index = 0; index < records.length; index += 1) {
          const row = records[index];
          const missingRequired = requiredFields.filter((field) => !String(row[field] ?? '').trim());
          if (missingRequired.length > 0) {
            const detail = `Empty required fields: ${missingRequired.join(', ')}`;
            const error = `Import failed on row ${index + 2}: ${detail}`;
            errors.push({ index, row: index + 2, error });
            rowResults.push({ index, row: index + 2, status: 'failed', error });
            continue;
          }
          const values: Record<string, unknown> = {};
          const customFields: Record<string, unknown> = {};
          let invalidValue: string | null = null;
          for (const field of fields) {
            if (field === 'ownerId') continue;
            const value = convertImportValue(String(row[field] ?? ''), fieldTypes.get(field) || 'text');
            if (value === undefined) continue;
            invalidValue = importValueError(value, fieldTypes.get(field) || 'text', String(row[field] ?? ''));
            if (invalidValue) break;
            if (field === 'status' && typeof value === 'string') {
              const status = normalizeLeadStatus(value);
              if (!LEAD_STATUSES.has(status)) {
                invalidValue = `Invalid Lead status "${String(row[field]).trim()}". Allowed values: ${[...LEAD_STATUSES].join(', ')}.`;
                break;
              }
              values[field] = status;
            }
            else if (leadFields.has(field)) values[field] = value;
            else if (!enquiryFields.has(field)) customFields[field] = value;
          }
          if (invalidValue) {
            const error = `Import failed on row ${index + 2}: ${invalidValue}`;
            errors.push({ index, row: index + 2, error });
            rowResults.push({ index, row: index + 2, status: 'failed', error });
            continue;
          }
          const projectValue = allocatedProjectFields
            .map((field) => String(row[field] ?? '').trim())
            .find(Boolean);
          if (projectValue) {
            let projectId = resolvedProjects.get(projectValue.toLowerCase());
            if (!projectId) {
              const project = await prisma.project.findFirst({
                where: {
                  tenantId: req.tenantId!,
                  isActive: true,
                  OR: [{ id: projectValue }, { name: { equals: projectValue, mode: 'insensitive' } }],
                },
                select: { id: true },
              });
              if (!project) {
                const error = `Import failed on row ${index + 2}: Project "${projectValue}" was not found for this company.`;
                errors.push({ index, row: index + 2, error });
                rowResults.push({ index, row: index + 2, status: 'failed', error });
                continue;
              }
              projectId = project.id;
              resolvedProjects.set(projectValue.toLowerCase(), project.id);
            }
            values.projectId = projectId;
          }
          const source = typeof values.source === 'string' ? values.source : 'OTHER';
          const phone = typeof values.phone === 'string' ? values.phone : '';
          const countryCode = String(row.countryCode || row.phoneCountryCode || '91');
          const leadResult = leadCreateSchema.safeParse({
            ...values,
            source: sourceEnumValue(source),
            phone,
            company: values.company || [values.firstName, values.lastName].filter(Boolean).join(' '),
            customFields: { ...(values.customFields as Record<string, unknown> || {}), ...customFields },
          });
          if (!leadResult.success) {
            const error = `Import failed on row ${index + 2}: ${leadResult.error.issues[0]?.message || 'Invalid Lead data'}`;
            errors.push({ index, row: index + 2, error });
            rowResults.push({ index, row: index + 2, status: 'failed', error });
            continue;
          }
          const picklistError = validateLeadPicklists(leadResult.data, leadPicklistOptions, { validateRequired: true });
          if (picklistError) {
            const error = `Import failed on row ${index + 2}: ${picklistError.message}`;
            errors.push({ index, row: index + 2, error });
            rowResults.push({ index, row: index + 2, status: 'failed', error });
            continue;
          }
          const requestedOwner = String(row.ownerId || '').trim();
          const mappedOwnerId = requestedOwner ? await resolveImportOwner(requestedOwner) : undefined;
          if (requestedOwner && !mappedOwnerId) {
            const error = `Import failed on row ${index + 2}: Mapped owner was not found or is inactive in this tenant.`;
            errors.push({ index, row: index + 2, error });
            rowResults.push({ index, row: index + 2, status: 'failed', error });
            continue;
          }
          const importedStatus = String(leadResult.data.status || 'NEW');
          const assignment = getLeadImportAssignment(importedStatus, profileOverrides);
          inputs.push({ index, input: {
            tenantId: req.tenantId!,
            userId: req.user!.id,
            profileName: req.user!.profileName,
            importAssignment: {
              status: importedStatus,
              fallbackOwnerId: fallbackAdmin.id,
              importJobId: importJob.id,
              ownerId: mappedOwnerId || undefined,
              userType: assignment.userType,
              profileNames: assignment.profileNames,
            },
            lead: leadResult.data,
            enquiry: {
              source,
              subSource: String(row.subSource || row.leadSubSource || '') || undefined,
              campaignId: String(row.campaignId || '') || undefined,
              campaign: String(row.campaign || '') || undefined,
              subCampaignId: String(row.subCampaignId || '') || undefined,
              subCampaign: String(row.subCampaign || '') || undefined,
              secondaryPhone: String(row.secondaryPhone || '') || undefined,
              tertiaryPhone: String(row.tertiaryPhone || '') || undefined,
              secondaryEmail: String(row.secondaryEmail || '') || undefined,
              tertiaryEmail: String(row.tertiaryEmail || '') || undefined,
              originalSubmissionId: String(
                row.originalSubmissionId
                || row.sourceSubmissionId
                || (req.get('Idempotency-Key') ? `${req.get('Idempotency-Key')}:${index + 1}` : ''),
              ) || undefined,
              countryCode,
              secondaryCountryCode: String(row.secondaryCountryCode || countryCode),
              tertiaryCountryCode: String(row.tertiaryCountryCode || row.secondaryCountryCode || countryCode),
              medium: String(row.medium || '') || undefined,
              description: String(row.enquiryDescription || row.description || '') || undefined,
              channelPartner: String(row.channelPartner || '') || undefined,
              enquiryDate: row.enquiryDate ? new Date(String(row.enquiryDate)) : undefined,
            },
          } });
        }
        let created = 0;
        let linkedEnquiries = 0;
        let batchConflict: 'DUPLICATE_CONFLICT' | 'LEAD_MISMATCH' | undefined;
        let batchConflictRow: number | undefined;
        const seenUploadContacts = new Set<string>();
        for (let start = 0; start < inputs.length; start += LEAD_IMPORT_BATCH_SIZE) {
          const batchInputs = inputs.slice(start, start + LEAD_IMPORT_BATCH_SIZE);
          const duplicateMatches = await findLeadDuplicatesBatch(
            prisma,
            req.tenantId!,
            batchInputs.map(({ input }) => leadDuplicateInputForEnquiry(input)),
          );
          const validRows: Array<{ index: number; input: LeadEnquiryInput }> = [];
          for (let offset = 0; offset < batchInputs.length; offset += 1) {
            const { index, input } = batchInputs[offset];
            const keys = leadDuplicateContactKeys(leadDuplicateInputForEnquiry(input));
            const duplicateFields = new Set(duplicateLeadFields(duplicateMatches[offset]));
            let uploadedDuplicate = false;
            for (const key of keys) {
              const field: 'phone' | 'email' = key.startsWith('PHONE:') ? 'phone' : 'email';
              if (seenUploadContacts.has(key)) {
                duplicateFields.add(field);
                uploadedDuplicate = true;
              }
              seenUploadContacts.add(key);
            }
            if (duplicateFields.size) {
              const orderedFields: Array<'phone' | 'email'> = ['phone', 'email'];
              const fields = orderedFields.filter((field) => duplicateFields.has(field));
              const reason = `${duplicateLeadMessage(fields)}${uploadedDuplicate ? ' Duplicate also appears in this upload.' : ''}`;
              errors.push({ index, row: index + 2, error: reason, duplicateFields: fields });
              rowResults.push({ index, row: index + 2, status: 'failed', error: reason, duplicateFields: fields });
            } else {
              validRows.push({ index, input });
            }
          }
          if (!validRows.length) continue;
          try {
            const results = await processLeadEnquiryBatch(
              validRows.map(({ input }) => input),
              { rejectDuplicates: true },
            );
            created += results.filter((result) => result.action === 'NEW_LEAD').length;
            linkedEnquiries += results.filter((result) => result.action !== 'NEW_LEAD').length;
            leadImportCounts.createdCount = created;
            leadImportCounts.linkedCount = linkedEnquiries;
            results.forEach((result, offset) => {
              const index = validRows[offset].index;
              const lead = result.lead as {
                leadNumber?: string | null;
                status?: string;
                owner?: { firstName?: string | null; lastName?: string | null } | null;
                project?: { name?: string | null } | null;
              } | null;
              const assignment = validRows[offset].input.importAssignment;
              rowResults.push({
                index,
                row: index + 2,
                status: 'success',
                leadNumber: lead?.leadNumber || undefined,
                projectName: lead?.project?.name || undefined,
                leadStatus: lead?.status || assignment?.status,
                assignedOwner: [lead?.owner?.firstName, lead?.owner?.lastName].filter(Boolean).join(' ') || undefined,
                assignmentGroup: assignment?.status.toUpperCase() === 'BOOKED'
                  ? 'Booked Bucket'
                  : assignment?.ownerId
                  ? 'Mapped owner'
                  : assignment?.userType || 'System Administrator fallback',
              });
            });
          } catch (error: any) {
            const batchRowIndex = typeof error?.rowIndex === 'number'
              ? validRows[error.rowIndex]?.index ?? validRows[0].index
              : validRows[0].index;
            const row = batchRowIndex + 2;
            const duplicateFields = Array.isArray(error?.duplicateFields)
              ? error.duplicateFields.filter((field: unknown) => field === 'phone' || field === 'email')
              : [];
            const isDuplicate = error?.code === 'DUPLICATE_LEAD' || error?.message === 'DUPLICATE_LEAD';
            if (error?.message === 'DUPLICATE_CONFLICT' || error?.message === 'LEAD_MISMATCH') {
              batchConflict = error.message;
              batchConflictRow = row;
            }
            const detail = isDuplicate
              ? duplicateLeadMessage(duplicateFields)
              : error?.message === 'DUPLICATE_CONFLICT' || error?.message === 'LEAD_MISMATCH'
                ? 'Multiple or changed duplicate matches require review.'
                : error?.validationErrors?.[0]?.message || error?.message || 'Invalid row';
            const message = `Import stopped at row ${row}: ${detail}`;
            for (const { index } of validRows) {
              const rowError = index === batchRowIndex
                ? message
                : `Not imported because its transaction batch was rolled back after row ${row} failed.`;
              errors.push({ index, row: index + 2, error: rowError, ...(isDuplicate ? { duplicateFields } : {}) });
              rowResults.push({ index, row: index + 2, status: 'failed', error: rowError, ...(isDuplicate ? { duplicateFields } : {}) });
            }
          }
        }
        rowResults.sort((left, right) => left.index - right.index);
        errors.sort((left, right) => left.index - right.index);
        const bookedBucketRows = rowResults.filter((item) => item.status === 'success' && item.leadStatus?.toUpperCase() === 'BOOKED');
        const bookedBucketSummary = {
          leadCount: bookedBucketRows.length,
          ownerCount: bookedBucketOwnerCount,
          isActive: bookedBucketSetting?.isActive ?? false,
          warning: bookedBucketRows.length > 0 && (!(bookedBucketSetting?.isActive) || bookedBucketOwnerCount === 0),
          warningMessage: !(bookedBucketSetting?.isActive)
            ? 'Booked Bucket is inactive; imported Booked leads were not moved.'
            : bookedBucketOwnerCount === 0
              ? 'No active Booked Bucket owners are configured; the Admin fallback was used.'
              : null,
        };
        const failedCount = rowResults.filter((item) => item.status === 'failed').length;
        const importStatus = failedCount === 0
          ? 'COMPLETED'
          : created + linkedEnquiries > 0
            ? 'PARTIAL'
            : 'FAILED';
        await prisma.leadImportJob.update({
          where: { id: importJob.id, tenantId: req.tenantId! },
          data: {
            status: importStatus,
            createdCount: created,
            linkedCount: linkedEnquiries,
            failedCount,
            completedAt: new Date(),
          },
        });
        await prisma.auditLog.create({
          data: {
            tenantId: req.tenantId!,
            userId: req.user!.id,
            action: 'LEAD_IMPORT_COMPLETED',
            objectType: 'LeadImportJob',
            objectId: importJob.id,
            newValues: {
              totalRows: records.length,
              createdCount: created,
              linkedCount: linkedEnquiries,
              failedCount,
              status: importStatus,
              bookedBucket: bookedBucketSummary,
            },
          },
        });
        if (created + linkedEnquiries === 0 && errors.length) {
          const hasDuplicate = errors.some((item) => item.duplicateFields?.length);
          return res.status(hasDuplicate || batchConflict ? 409 : 400).json({
            success: false,
            ...(batchConflict ? { action: batchConflict, row: batchConflictRow, importedCount: 0 } : {}),
            code: hasDuplicate ? 'DUPLICATE_LEAD' : undefined,
            error: errors[0].error,
            data: {
              count: 0,
              linkedEnquiries: 0,
              errors,
              rowResults,
              job: { id: importJob.id, status: importStatus, totalRows: records.length, createdCount: created, linkedCount: linkedEnquiries, failedCount },
              assignmentSummary: { bookedBucket: bookedBucketSummary },
            },
          });
        }
        return res.status(201).json({
          success: true,
          data: {
            count: created,
            linkedEnquiries,
            errors,
            rowResults,
            job: { id: importJob.id, status: importStatus, totalRows: records.length, createdCount: created, linkedCount: linkedEnquiries, failedCount },
            assignmentSummary: { bookedBucket: bookedBucketSummary },
          },
        });
      }

      if (standardConfig.model === 'unit') {
        const unitImport = await importUnitRecords({
          tenantId: req.tenantId!,
          userId: req.user!.id,
          fields,
          records,
          fieldTypes,
        });
        if (unitImport.importedCount === 0 && unitImport.importErrors.length > 0) {
          return res.status(400).json({
            success: false,
            error: unitImport.importErrors[0].error,
            data: { count: 0, errors: unitImport.importErrors, rowResults: unitImport.rowResults },
          });
        }
        return res.status(201).json({
          success: true,
          data: { count: unitImport.importedCount, errors: unitImport.importErrors, rowResults: unitImport.rowResults },
        });
      }

      let importedCount = 0;
      const importErrors: { index: number; error: string }[] = [];
      const rowResults: { index: number; status: 'success' | 'failed'; error?: string }[] = [];
      for (let start = 0; start < records.length; start += STANDARD_IMPORT_BATCH_SIZE) {
        const batch = records.slice(start, start + STANDARD_IMPORT_BATCH_SIZE).map((row, offset) => {
          const data: Record<string, unknown> = { tenantId: req.tenantId! };
          for (const field of fields) {
            const value = convertImportValue(String(row[field] ?? ''), fieldTypes.get(field) || 'text');
            if (value !== undefined) data[field] = value;
          }
          if (standardConfig.hasCreator) data.creatorId = req.user!.id;
          return { index: start + offset, data };
        });
        try {
          await delegate.createMany({ data: batch.map(({ data }) => data) });
          importedCount += batch.length;
          batch.forEach(({ index }) => rowResults.push({ index, status: 'success' }));
        } catch (batchError) {
          console.error('Batched standard-record import failed; retrying the affected rows individually:', batchError);
          for (const { index, data } of batch) {
            try {
              await delegate.create({ data });
              importedCount += 1;
              rowResults.push({ index, status: 'success' });
            } catch (error: any) {
              const detail = error?.meta?.cause || error?.message || 'Invalid row';
              const message = `Import failed on row ${index + 2}: ${detail}`;
              importErrors.push({ index, error: message });
              rowResults.push({ index, status: 'failed', error: message });
            }
          }
        }
      }

      if (importedCount === 0 && importErrors.length > 0) {
        return res.status(400).json({
          success: false,
          error: importErrors[0].error,
          data: { count: 0, errors: importErrors, rowResults },
        });
      }
      return res.status(201).json({
        success: true,
        data: { count: importedCount, errors: importErrors, rowResults },
      });
    }

    const result = await bulkImportRecords(req.tenantId!, objectName.trim(), records, req.user!.id);
    const errorsByIndex = new Map(result.errors.map(({ index, error }) => [index, error]));
    const rowResults = records.map((_, index) => {
      const error = errorsByIndex.get(index);
      return error
        ? { index, status: 'failed' as const, error }
        : { index, status: 'success' as const };
    });
    if (result.created === 0 && result.errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: `No records were imported. ${result.errors[0].error}`,
        data: { ...result, rowResults },
      });
    }
    res.status(201).json({ success: true, data: { ...result, rowResults } });
  } catch (error: any) {
    if (leadImportJobId) {
      try {
        await prisma.leadImportJob.update({
          where: { id: leadImportJobId, tenantId: req.tenantId! },
          data: {
            status: leadImportCounts && leadImportCounts.createdCount + leadImportCounts.linkedCount > 0 ? 'PARTIAL' : 'FAILED',
            ...(leadImportCounts ? {
              createdCount: leadImportCounts.createdCount,
              linkedCount: leadImportCounts.linkedCount,
              failedCount: Math.max(0, leadImportCounts.totalRows - leadImportCounts.createdCount - leadImportCounts.linkedCount),
            } : {}),
            completedAt: new Date(),
          },
        });
      } catch (jobError) {
        console.error('Unable to mark the Lead import job as failed:', jobError);
      }
    }
    console.error('Data import error:', error);
    res.status(400).json({ success: false, error: error.message || 'Import failed' });
  }
});

router.post('/update', requirePermission('DATA_UPDATE'), async (req: AuthRequest, res: Response) => {
  try {
    const { objectName, fields, csv } = req.body ?? {};
    if (typeof objectName !== 'string' || !objectName.trim()) {
      return res.status(400).json({ success: false, error: 'objectName is required' });
    }
    if (!Array.isArray(fields) || fields.length === 0 || fields.some((field) => typeof field !== 'string')) {
      return res.status(400).json({ success: false, error: 'At least one field is required to update records' });
    }
    if (typeof csv !== 'string' || !csv.trim()) {
      return res.status(400).json({ success: false, error: 'CSV content is required' });
    }
    if (objectName.trim().toLowerCase() !== 'lead') {
      return res.status(501).json({
        success: false,
        error: 'Bulk updates are currently supported only for Leads.',
        data: { objectName, fieldCount: fields.length },
      });
    }
    if (!fields.includes('originalSubmissionId')) {
      return res.status(400).json({
        success: false,
        error: 'Map a CSV column to Enquiry Original Submission ID to update Leads. Contact details are never used as update keys.',
      });
    }
    if (!fields.includes('source')) {
      return res.status(400).json({ success: false, error: 'Map Lead Source so the source-system ID can be resolved within its source namespace.' });
    }
    const object = await getObjectDefinition(req.tenantId!, objectName.trim());
    if (!object) return res.status(404).json({ success: false, error: 'Object not found' });
    const definitions = (await getFieldDefinitions(req.tenantId!, object.id) as Array<{
      name: string;
      required: boolean;
      isActive: boolean;
      isSystemField: boolean;
      fieldType?: string;
    }>).filter((field) => field.isActive && !field.isSystemField);
    if (!definitions.some((field) => field.name === 'originalSubmissionId')) {
      definitions.push({ name: 'originalSubmissionId', required: false, isActive: true, isSystemField: false, fieldType: 'text' });
    }
    const availableNames = new Set(definitions.map((field) => field.name));
    const invalidFields = fields.filter((field: string) => !availableNames.has(field));
    if (invalidFields.length) {
      return res.status(400).json({ success: false, error: `Invalid fields: ${invalidFields.join(', ')}` });
    }
    const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as Record<string, string>[];
    if (!rows.length) return res.status(400).json({ success: false, error: 'CSV must contain at least one data row' });
    if (rows.length > MAX_IMPORT_RECORDS) {
      return res.status(400).json({ success: false, error: `Import is limited to ${MAX_IMPORT_RECORDS.toLocaleString()} records per request` });
    }
    const missingCsvFields = fields.filter((field: string) => !Object.prototype.hasOwnProperty.call(rows[0], field));
    if (missingCsvFields.length) {
      return res.status(400).json({ success: false, error: `CSV is missing selected fields: ${missingCsvFields.join(', ')}` });
    }

    const leadFields = new Set(Object.keys(leadCreateSchema.shape));
    const enquiryFields = new Set([
      'secondaryPhone', 'tertiaryPhone', 'secondaryEmail', 'tertiaryEmail', 'originalSubmissionId',
      'countryCode', 'secondaryCountryCode', 'tertiaryCountryCode', 'subSource', 'campaignId',
      'campaign', 'subCampaignId', 'subCampaign', 'medium', 'enquiryDescription', 'channelPartner',
      'enquiryDate',
    ]);
    const fieldTypes = new Map(definitions.map((field) => [field.name, field.fieldType || 'text']));
    const picklists = await getLeadPicklistOptions(req.tenantId!);
    const rowResults: Array<{ index: number; status: 'success' | 'failed'; error?: string }> = [];
    const seenExternalIds = new Set<string>();
    let updatedCount = 0;
    let createdCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const fail = (detail: string) => rowResults.push({
        index,
        status: 'failed',
        error: `Update failed on row ${index + 2}: ${detail}`,
      });
      const sourceSystemId = String(row.originalSubmissionId || '').trim();
      const source = String(row.source || '').trim();
      if (!sourceSystemId || !source) {
        fail('Enquiry Original Submission ID and Lead Source are required to locate a Lead.');
        continue;
      }
      const sourcePrefix = `${source.toUpperCase()}:`;
      const canonicalId = sourceSystemId.toUpperCase().startsWith(sourcePrefix)
        ? `${sourcePrefix}${sourceSystemId.slice(sourcePrefix.length)}`
        : `${sourcePrefix}${sourceSystemId}`;
      if (seenExternalIds.has(canonicalId)) {
        fail('The Enquiry Original Submission ID appears more than once in this upload.');
        continue;
      }
      seenExternalIds.add(canonicalId);
      const sourceOptions = picklists.get('source');
      if (!sourceOptions?.has(source)) {
        fail('Select a configured Lead Source for this company.');
        continue;
      }
      const existingEnquiry = await prisma.enquiry.findFirst({
        where: { tenantId: req.tenantId!, originalSubmissionId: canonicalId },
        include: { lead: true },
      });
      if (existingEnquiry?.lead && existingEnquiry.lead.tenantId !== req.tenantId) {
        fail('No Lead matched this Enquiry Original Submission ID in this company.');
        continue;
      }
      if (existingEnquiry?.lead && !(await canAccessLead(req.user!, existingEnquiry.lead))) {
        fail('You do not have permission to update this Lead.');
        continue;
      }
      const leadData: Record<string, unknown> = {};
      const customPatch: Record<string, unknown> = {};
      const enquiryData: Record<string, unknown> = {};
      let invalidValue: string | null = null;
      for (const field of fields as string[]) {
        if (field === 'originalSubmissionId') continue;
        const raw = String(row[field] ?? '').trim();
        if (!raw) continue;
        const value = convertImportValue(raw, fieldTypes.get(field) || 'text');
        if (value === undefined) continue;
        invalidValue = importValueError(value, fieldTypes.get(field) || 'text', raw);
        if (invalidValue) break;
        if (field === 'status' && typeof value === 'string') leadData[field] = normalizeLeadStatus(value);
        else if (leadFields.has(field)) leadData[field] = value;
        else if (enquiryFields.has(field)) enquiryData[field] = value;
        else customPatch[field] = value;
      }
      if (invalidValue) {
        fail(invalidValue);
        continue;
      }
      const picklistError = validateLeadPicklists(leadData, picklists, { partial: true });
      if (picklistError) {
        fail(picklistError.message);
        continue;
      }
      const mergedCustomFields = {
        ...(existingEnquiry?.lead?.customFields && typeof existingEnquiry.lead.customFields === 'object'
          ? existingEnquiry.lead.customFields as Record<string, unknown>
          : {}),
        ...customPatch,
      };
      if (Object.keys(customPatch).length) leadData.customFields = mergedCustomFields;
      const validatedPatch = leadUpdateSchema.safeParse(leadData);
      if (!validatedPatch.success) {
        fail(validatedPatch.error.issues[0]?.message || 'Invalid Lead values.');
        continue;
      }
      if (!existingEnquiry?.lead) {
        const missingRequired = definitions
          .filter((field) => field.required)
          .filter((field) => !String(row[field.name] ?? '').trim())
          .map((field) => field.name);
        if (missingRequired.length > 0) {
          fail(`Empty required fields for a new Lead: ${missingRequired.join(', ')}`);
          continue;
        }
        const createInput = leadCreateSchema.safeParse({
          ...validatedPatch.data,
          source,
          phone: validatedPatch.data.phone || '',
          company: validatedPatch.data.company || [validatedPatch.data.firstName, validatedPatch.data.lastName].filter(Boolean).join(' '),
          customFields: mergedCustomFields,
        });
        if (!createInput.success) {
          fail(createInput.error.issues[0]?.message || 'Required Lead fields are missing.');
          continue;
        }
        const requiredPicklistError = validateLeadPicklists(createInput.data, picklists, { validateRequired: true });
        if (requiredPicklistError) {
          fail(requiredPicklistError.message);
          continue;
        }
        const externalId = canonicalId.slice(sourcePrefix.length);
        try {
          const created = await processLeadEnquiryBatch([{
            tenantId: req.tenantId!,
            userId: req.user!.id,
            profileName: req.user!.profileName,
            lead: createInput.data,
            bookedBucketSource: createInput.data.status === 'BOOKED' ? 'import' : undefined,
            enquiry: {
              source,
              originalSubmissionId: externalId,
              subSource: String(row.subSource || row.leadSubSource || '') || undefined,
              campaignId: String(row.campaignId || '') || undefined,
              campaign: String(row.campaign || '') || undefined,
              subCampaignId: String(row.subCampaignId || '') || undefined,
              subCampaign: String(row.subCampaign || '') || undefined,
              secondaryPhone: String(row.secondaryPhone || '') || undefined,
              tertiaryPhone: String(row.tertiaryPhone || '') || undefined,
              secondaryEmail: String(row.secondaryEmail || '') || undefined,
              tertiaryEmail: String(row.tertiaryEmail || '') || undefined,
              countryCode: String(row.countryCode || '91'),
              secondaryCountryCode: String(row.secondaryCountryCode || row.countryCode || '91'),
              tertiaryCountryCode: String(row.tertiaryCountryCode || row.secondaryCountryCode || row.countryCode || '91'),
              medium: String(row.medium || '') || undefined,
              description: String(row.enquiryDescription || row.description || '') || undefined,
              channelPartner: String(row.channelPartner || '') || undefined,
              enquiryDate: row.enquiryDate ? new Date(String(row.enquiryDate)) : undefined,
            },
          }], { rejectDuplicates: true });
          createdCount += created.filter((result) => result.action === 'NEW_LEAD').length;
          updatedCount += created.filter((result) => result.action !== 'NEW_LEAD').length;
          rowResults.push({ index, status: 'success' });
        } catch (error: any) {
          const duplicateFields = Array.isArray(error?.duplicateFields)
            ? error.duplicateFields.filter((field: unknown) => field === 'phone' || field === 'email')
            : [];
          fail(error?.message === 'DUPLICATE_LEAD'
            ? duplicateLeadMessage(duplicateFields)
            : error?.validationErrors?.[0]?.message || error?.message || 'This row could not be saved.');
        }
        continue;
      }
      const duplicateInput = leadDuplicateInputForEnquiry({
          tenantId: req.tenantId!,
          userId: req.user!.id,
          profileName: req.user!.profileName,
          lead: { ...existingEnquiry.lead, ...validatedPatch.data } as any,
          enquiry: {
            source,
            countryCode: String(row.countryCode || existingEnquiry.countryCode || '91'),
            secondaryCountryCode: String(row.secondaryCountryCode || existingEnquiry.secondaryCountryCode || ''),
            tertiaryCountryCode: String(row.tertiaryCountryCode || existingEnquiry.tertiaryCountryCode || ''),
            secondaryPhone: String(row.secondaryPhone || existingEnquiry.secondaryPhone || ''),
            tertiaryPhone: String(row.tertiaryPhone || existingEnquiry.tertiaryPhone || ''),
            secondaryEmail: String(row.secondaryEmail || existingEnquiry.secondaryEmail || ''),
            tertiaryEmail: String(row.tertiaryEmail || existingEnquiry.tertiaryEmail || ''),
          } as any,
        });
      const duplicates = await findLeadDuplicatesBatch(prisma, req.tenantId!, [duplicateInput]);
      const otherMatches = (duplicates[0] || []).filter((match) => match.lead.id !== existingEnquiry.lead.id);
      if (otherMatches.length) {
        fail(duplicateLeadMessage(duplicateLeadFields(otherMatches)));
        continue;
      }
      try {
        await prisma.$transaction(async (tx) => {
          if (Object.keys(validatedPatch.data).length) {
            await tx.lead.update({ where: { id: existingEnquiry.lead.id }, data: validatedPatch.data });
          }
          if (existingEnquiry.lead.status !== 'BOOKED' && validatedPatch.data.status === 'BOOKED') {
            await moveLeadToBookedBucket(existingEnquiry.lead.id, 'import', tx, req.user!.id);
          }
          if (Object.keys(enquiryData).length || source !== existingEnquiry.source) {
            const nextExternalId = canonicalId;
            await tx.enquiry.update({
              where: { id: existingEnquiry.id },
              data: {
                ...enquiryData,
                source,
                originalSubmissionId: nextExternalId,
                updatedById: req.user!.id,
              },
            });
          }
          await tx.auditLog.create({
            data: {
              tenantId: req.tenantId!,
              userId: req.user!.id,
              leadId: existingEnquiry.lead.id,
              action: 'LEAD_UPDATED',
              objectType: 'Lead',
              objectId: existingEnquiry.lead.id,
              oldValues: Object.fromEntries(Object.keys(validatedPatch.data).map((field) => [field, (existingEnquiry.lead as any)[field]])),
              newValues: validatedPatch.data as any,
            },
          });
        });
        updatedCount += 1;
        rowResults.push({ index, status: 'success' });
      } catch (error) {
        console.error('Lead data update row transaction failed:', error);
        fail(error instanceof Error && error.message === 'BOOKED_BUCKET_ADMIN_FALLBACK_NOT_FOUND'
          ? 'No active company administrator is available for the Booked Bucket fallback.'
          : 'This row could not be saved.');
      }
    }
    const errors = rowResults.filter((result) => result.status === 'failed').map(({ index, error }) => ({ index, error }));
    return res.status(updatedCount > 0 ? 200 : 400).json({
      success: updatedCount + createdCount > 0,
      ...(updatedCount + createdCount === 0 ? { error: errors[0]?.error || 'No Leads were updated.' } : {}),
      data: { count: updatedCount + createdCount, created: createdCount, updated: updatedCount, errors, rowResults },
    });
  } catch (error: any) {
    console.error('Lead data update error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Update failed' });
  }
});

router.get('/export/:objectName', requirePermission('DATA_EXPORT'), async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', limit = '1000', search, sortBy, sortOrder, fields: fieldsQuery, ...filters } = req.query;
    const fields = typeof fieldsQuery === 'string' ? fieldsQuery.split(',').map((field) => field.trim()).filter(Boolean) : [];
    const pageNumber = Math.max(Number(page) || 1, 1);
    const pageLimit = Math.min(Math.max(Number(limit) || 1000, 1), 10000);
    let exportRows: any[];

    const standardModel = STANDARD_EXPORT_MODELS[req.params.objectName.toLowerCase()];
    if (standardModel) {
      const delegate = (prisma as any)[standardModel];
      let where: any = { tenantId: req.tenantId! };
      if (standardModel === 'lead') {
        where = applyScope(where, leadScopeClause(await getLeadRecordScope(req.user!)));
      } else if (standardModel === 'siteVisit') {
        where = applyScope(where, await getScopeClause(req.user!, 'siteVisit'));
      } else if (standardModel === 'task') {
        where = applyScope(where, await getScopeClause(req.user!, 'task'));
      } else if (standardModel === 'followUp') {
        where = applyScope(where, await getScopeClause(req.user!, 'followUp'));
      } else if (standardModel === 'activity') {
        where = applyScope(where, await getScopeClause(req.user!, 'activity'));
      }
      const records = await delegate.findMany({
        where,
        skip: (pageNumber - 1) * pageLimit,
        take: pageLimit,
        orderBy: { createdAt: 'desc' },
      });
      exportRows = records.map((record: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(record).map(([key, value]) => [
          key,
          value instanceof Date ? value.toISOString() : value,
        ]))
      );
    } else {
      const recordFilters = Object.fromEntries(
        Object.entries(filters).filter(([key]) => key !== 'tenantId'),
      );
      const result = await listRecords(req.tenantId!, req.params.objectName, {
        page: pageNumber,
        limit: pageLimit,
        search: search as string,
        filters: Object.keys(recordFilters).length > 0 ? recordFilters : undefined,
        sortBy: sortBy as string,
        sortOrder: (sortOrder as 'asc' | 'desc') || 'desc',
      });
      exportRows = result.data;
    }

    const selectedFields = fields.length > 0 ? fields : Object.keys(exportRows[0]?.data || exportRows[0] || {});
    const escapeCsv = (value: unknown) => {
      const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [
      selectedFields.map(escapeCsv).join(','),
      ...exportRows.map((record: any) => {
        const source = record.data || record;
        return selectedFields.map((field) => escapeCsv(source[field])).join(',');
      }),
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.objectName}.csv"`);
    res.send(csv);
  } catch (error: any) {
    console.error('Data export error:', error);
    res.status(400).json({ success: false, error: error.message || 'Export failed' });
  }
});

export { router as dataAdministrationRoutes };
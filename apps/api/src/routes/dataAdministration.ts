import { Router, Response } from 'express';
import { parse } from 'csv-parse/sync';
import { prisma, unitFieldTags } from '@dct-crm/db';
import { leadCreateSchema, resolveUnitLocation } from '@dct-crm/shared';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { bulkImportRecords, listRecords } from '../services/dynamicCrud';
import { getFieldDefinitions, getObjectDefinition } from '../services/metadata';
import {
  applyScope,
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
const LEAD_IMPORT_BATCH_SIZE = 1_000;
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

function convertImportValue(value: string, fieldType: string) {
  if (value === '') return undefined;
  if (['number', 'integer', 'decimal', 'currency', 'percentage'].includes(fieldType)) return Number(value);
  if (fieldType === 'boolean') return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
  if (fieldType === 'date' || fieldType === 'dateTime') return new Date(value);
  return value;
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

function normalizeLeadStatus(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return LEAD_STATUSES.has(normalized) ? normalized : value;
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

    if (objectName.trim().toLowerCase() === 'user') await ensureUserObjectOnce(req.tenantId!);
    const object = await getObjectDefinition(req.tenantId!, objectName.trim());
    if (!object) return res.status(404).json({ success: false, error: 'Object not found' });
    const normalizedObjectName = String(object?.name || objectName.trim()).trim().toLowerCase();
    const availableFields = (await getFieldDefinitions(req.tenantId!, object.id) as Array<{ name: string; label?: string; required: boolean; isActive: boolean; isSystemField: boolean }>).filter((field) => field.isActive && !field.isSystemField);
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
    if (invalidRequiredRows.length > 0) {
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
        const inputs: LeadEnquiryInput[] = [];
        for (let index = 0; index < records.length; index += 1) {
          const row = records[index];
          const values: Record<string, unknown> = {};
          const customFields: Record<string, unknown> = {};
          for (const field of fields) {
            const value = convertImportValue(String(row[field] ?? ''), fieldTypes.get(field) || 'text');
            if (value === undefined) continue;
            if (field === 'status' && typeof value === 'string') values[field] = normalizeLeadStatus(value);
            else if (leadFields.has(field)) values[field] = value;
            else if (!enquiryFields.has(field)) customFields[field] = value;
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
                const rowErrors = records.map((_, rowIndex) => ({
                  index: rowIndex,
                  error: rowIndex === index
                    ? error
                    : `Not imported because validation failed on row ${index + 2}.`,
                }));
                return res.status(400).json({
                  success: false,
                  error,
                  row: index + 2,
                  fieldErrors: [{ field: allocatedProjectFields[0], message: 'Select a valid project for this company.' }],
                  data: {
                    count: 0,
                    linkedEnquiries: 0,
                    errors: rowErrors,
                    rowResults: rowErrors.map(({ index: rowIndex, error: rowError }) => ({
                      index: rowIndex,
                      status: 'failed',
                      error: rowError,
                    })),
                  },
                });
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
            const rowErrors = records.map((_, rowIndex) => ({
              index: rowIndex,
              error: rowIndex === index
                ? error
                : `Not imported because validation failed on row ${index + 2}.`,
            }));
            return res.status(400).json({
              success: false,
              error,
              row: index + 2,
              fieldErrors: leadResult.error.issues.map((issue) => ({
                field: issue.path.join('.'),
                message: issue.message,
              })),
              data: {
                count: 0,
                linkedEnquiries: 0,
                errors: rowErrors,
                rowResults: rowErrors.map(({ index: rowIndex, error: rowError }) => ({
                  index: rowIndex,
                  status: 'failed',
                  error: rowError,
                })),
              },
            });
          }
          const picklistError = validateLeadPicklists(leadResult.data, leadPicklistOptions, { validateRequired: true });
          if (picklistError) {
            const error = `Import failed on row ${index + 2}: ${picklistError.message}`;
            const rowErrors = records.map((_, rowIndex) => ({
              index: rowIndex,
              row: rowIndex + 2,
              error: rowIndex === index
                ? error
                : `Not imported because validation failed on row ${index + 2}.`,
            }));
            return res.status(400).json({
              success: false,
              error,
              row: index + 2,
              fieldErrors: [picklistError],
              data: {
                count: 0,
                linkedEnquiries: 0,
                errors: rowErrors,
                rowResults: rowErrors.map(({ index: rowIndex, error: rowError }) => ({
                  index: rowIndex,
                  row: rowIndex + 2,
                  status: 'failed',
                  error: rowError,
                })),
              },
            });
          }
          inputs.push({
            tenantId: req.tenantId!,
            userId: req.user!.id,
            profileName: req.user!.profileName,
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
          });
        }
        let created = 0;
        let linkedEnquiries = 0;
        const errors: { index: number; row: number; error: string; duplicateFields?: string[] }[] = [];
        const rowResults: { index: number; row: number; status: 'success' | 'failed'; error?: string; duplicateFields?: string[] }[] = [];
        const seenUploadContacts = new Set<string>();
        for (let start = 0; start < inputs.length; start += LEAD_IMPORT_BATCH_SIZE) {
          const batchInputs = inputs.slice(start, start + LEAD_IMPORT_BATCH_SIZE);
          const duplicateMatches = await findLeadDuplicatesBatch(
            prisma,
            req.tenantId!,
            batchInputs.map(leadDuplicateInputForEnquiry),
          );
          const validRows: Array<{ index: number; input: LeadEnquiryInput }> = [];
          for (let offset = 0; offset < batchInputs.length; offset += 1) {
            const index = start + offset;
            const keys = leadDuplicateContactKeys(leadDuplicateInputForEnquiry(batchInputs[offset]));
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
              validRows.push({ index, input: batchInputs[offset] });
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
            results.forEach((_, offset) => {
              const index = validRows[offset].index;
              rowResults.push({ index, row: index + 2, status: 'success' });
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
            if (created + linkedEnquiries === 0) {
              return res.status(error?.message === 'DUPLICATE_CONFLICT' || error?.message === 'LEAD_MISMATCH' ? 409 : 400).json({
                success: false,
                ...(error?.message === 'DUPLICATE_CONFLICT' || error?.message === 'LEAD_MISMATCH' ? { action: error.message } : {}),
                row,
                error: message,
                importedCount: 0,
                data: { count: 0, linkedEnquiries: 0, errors, rowResults },
              });
            }
          }
        }
        rowResults.sort((left, right) => left.index - right.index);
        errors.sort((left, right) => left.index - right.index);
        if (created + linkedEnquiries === 0 && errors.length) {
          return res.status(errors.some((item) => item.duplicateFields?.length) ? 409 : 400).json({
            success: false,
            code: errors.some((item) => item.duplicateFields?.length) ? 'DUPLICATE_LEAD' : undefined,
            error: errors[0].error,
            data: { count: 0, linkedEnquiries: 0, errors, rowResults },
          });
        }
        return res.status(201).json({
          success: true,
          data: { count: created, linkedEnquiries, errors, rowResults },
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
    console.error('Data import error:', error);
    res.status(400).json({ success: false, error: error.message || 'Import failed' });
  }
});

router.post('/update', requirePermission('DATA_UPDATE'), async (req: AuthRequest, res: Response) => {
  const { objectName, fields, csv } = req.body ?? {};
  if (typeof objectName !== 'string' || !objectName.trim()) {
    return res.status(400).json({ success: false, error: 'objectName is required' });
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    return res.status(400).json({ success: false, error: 'At least one field is required to preview an update' });
  }
  if (typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ success: false, error: 'CSV content is required' });
  }
  return res.status(501).json({
    success: false,
    error: 'Bulk data update is not enabled in this build. The page is available for Admin access, but the preview/apply workflow must be implemented with the shared object validation layer before it writes records.',
    data: { objectName, fieldCount: fields.length },
  });
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
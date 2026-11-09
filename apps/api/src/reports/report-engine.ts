import { prisma } from "@dct-crm/db";
import { getTenantTimezone } from "../services/tenantTimezone";
import { DEFAULT_CRM_TIMEZONE, crmDateToUtcStart } from "@dct-crm/shared";
import { REPORT_OBJECTS, ReportField, reportObjectFromPrismaModel } from "./report-metadata";

export type AggregateFunction =
  | "count"
  | "uniqueCount"
  | "sum"
  | "avg"
  | "min"
  | "max";

export interface ReportAggregate {
  function: AggregateFunction;
  field?: string;
  label?: string;
}

type ReportFilterOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isBlank"
  | "isNotBlank"
  | "in"
  | "notIn"
  | "customRange";

const MAX_FILTER_DEPTH = 5;
const MAX_FILTER_CONDITIONS = 30;
const dateGroupBuckets = new Set(["day", "week", "month", "quarter", "year"]);
const virtualReportColumns = new Set(["count"]);

function isVirtualReportColumn(column: string): boolean {
  return virtualReportColumns.has(column);
}

function parseDateValue(value: unknown, timeZone = DEFAULT_CRM_TIMEZONE): Date | null {
  if (value == null || value === "") {
    return null;
  }

  const raw = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? crmDateToUtcStart(raw, timeZone) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getAllowedOperators(field: ReportField): Set<string> {
  const base = new Set([
    "equals",
    "notEquals",
  ]);

  if (field.type === "string" || field.type === "enum") {
    base.add("contains");
    base.add("startsWith");
    base.add("endsWith");
    base.add("notContains");
    base.add("isBlank");
    base.add("isNotBlank");
    base.add("in");
    base.add("notIn");
  }

  if (field.type === "number" || field.type === "date") {
    base.add("gt");
    base.add("gte");
    base.add("lt");
    base.add("lte");
  }

  base.add("isBlank");
  base.add("isNotBlank");
  base.add("in");
  base.add("notIn");

  if (field.type === "date") {
    base.add("customRange");
    for (const operator of relativeDateOperators) {
      base.add(operator);
    }
  }

  return base;
}

export function validateFilterTree(filterTree: any, depth = 0): void {
  if (!filterTree) {
    return;
  }

  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`Filter depth exceeded: max ${MAX_FILTER_DEPTH}`);
  }

  if (typeof filterTree === "object" && (filterTree.type === "AND" || filterTree.type === "OR")) {
    const conditions = Array.isArray(filterTree.conditions) ? filterTree.conditions : [];

    if (conditions.length > MAX_FILTER_CONDITIONS) {
      throw new Error(`Filter condition limit exceeded: max ${MAX_FILTER_CONDITIONS}`);
    }

    for (const condition of conditions) {
      validateFilterTree(condition, depth + 1);
    }
    return;
  }

  if (filterTree && typeof filterTree === "object" && filterTree.field && filterTree.operator) {
    const fieldName = String(filterTree.field);
    const field = REPORT_OBJECTS[filterTree.objectName || "Lead"]?.fields[fieldName];
    if (!field) {
      throw new Error(`Unknown report field: ${fieldName}`);
    }

    if (!getAllowedOperators(field).has(String(filterTree.operator))) {
      throw new Error(`Invalid operator "${filterTree.operator}" for field "${fieldName}"`);
    }

    if (field.type === "date" && String(filterTree.operator) === "customRange") {
      const value = filterTree.value;
      const range = value && typeof value === "object" ? value as Record<string, unknown> : null;
      const start = parseDateValue(range?.start);
      const end = parseDateValue(range?.end);

      if (!start || !end) {
        throw new Error("Custom date range requires valid start and end values");
      }

      if (start.getTime() > end.getTime()) {
        throw new Error("Custom date range start must be before end");
      }
    }
  }
}

export function validateReportRequest(input: Partial<RunReportInput> & { objectName?: string; columns?: string[]; filters?: ReportFilter[] }): void {
  if (!input.objectName) {
    throw new Error("Report object name is required");
  }

  if (!input.columns?.length) {
    throw new Error("At least one report column is required");
  }

  const rowGroups = input.rowGroups || (input.groupBy ? [input.groupBy] : []);
  const columnGroups = input.columnGroups || (input.groupColumn ? [input.groupColumn] : []);
  if (rowGroups.length > 2) {
    throw new Error("You can add up to 2 row groupings.");
  }
  if (columnGroups.length > 2) {
    throw new Error("You can add up to 2 column groupings.");
  }
  if (new Set(rowGroups).size !== rowGroups.length || new Set(columnGroups).size !== columnGroups.length) {
    throw new Error("A field cannot be grouped more than once.");
  }
  if (rowGroups.some((field) => columnGroups.includes(field))) {
    throw new Error("A field cannot be grouped in both rows and columns.");
  }

  const objectConfig = REPORT_OBJECTS[input.objectName];
  if (!objectConfig) {
    return;
  }

  for (const column of input.columns) {
    if (isVirtualReportColumn(column)) continue;
    const field = objectConfig.fields[column];
    if (!field) {
      throw new Error(`Unknown report column: ${column}`);
    }
  }

  for (const group of [...rowGroups, ...columnGroups]) {
    if (!objectConfig.fields[group]) {
      throw new Error(`Unknown group field: ${group}`);
    }
  }

  for (const filter of input.filters || []) {
    if (!filter || typeof filter !== "object") {
      throw new Error("Invalid report filter payload");
    }

    const field = objectConfig.fields[filter.field];
    if (!field) {
      throw new Error(`Unknown report field: ${filter.field}`);
    }

    if (!getAllowedOperators(field).has(String(filter.operator))) {
      throw new Error(`Invalid operator "${filter.operator}" for field "${filter.field}"`);
    }

    if (field.type === "date" && String(filter.operator) === "customRange") {
      const range = filter.value && typeof filter.value === "object" ? filter.value as Record<string, unknown> : null;
      const start = parseDateValue(range?.start);
      const end = parseDateValue(range?.end);

      if (!start || !end) {
        throw new Error("Custom date range requires valid start and end values");
      }

      if (start.getTime() > end.getTime()) {
        throw new Error("Custom date range start must be before end");
      }
    }
  }
}

export interface ReportFilter {
  field: string;
  operator: ReportFilterOperator | string;
  value: unknown;
}

export interface RunReportInput {
  tenantId: string;
  userId?: string;
  objectName: string;
  columns: string[];
  filters?: ReportFilter[];
  filterTree?: FilterTree;
  crossFilter?: {
    objectName: string;
    mode: "with" | "without";
  };
  filterLogic?: "AND" | "OR";
  showMe?: "all" | "mine";
  groupBy?: string;
  groupColumn?: string;
  rowGroups?: string[];
  columnGroups?: string[];
  groupOptions?: Record<string, { dateBucket?: string }>;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  sortRules?: { field: string; order: "asc" | "desc" }[];
  limit?: number;
  aggregates?: ReportAggregate[];
}

export type FilterTree =
  | { type: "AND" | "OR"; conditions: FilterTree[] }
  | { filterIndex: number };

export function parseFilterExpression(expression: string, filterCount: number): FilterTree | undefined {
  const tokens = expression.match(/\(|\)|AND|OR|\d+/gi) || [];
  let position = 0;
  const parsePrimary = (): FilterTree => {
    const token = tokens[position++];
    if (token === "(") {
      const node = parseOr();
      if (tokens[position++] !== ")") throw new Error("Filter expression has an unmatched parenthesis");
      return node;
    }
    const index = Number(token);
    if (!Number.isInteger(index) || index < 1 || index > filterCount) throw new Error(`Filter expression references invalid filter ${token}`);
    return { filterIndex: index - 1 };
  };
  const parseAnd = (): FilterTree => {
    let node = parsePrimary();
    while (String(tokens[position]).toUpperCase() === "AND") {
      position += 1;
      const right = parsePrimary();
      node = { type: "AND", conditions: [node, right] };
    }
    return node;
  };
  const parseOr = (): FilterTree => {
    let node = parseAnd();
    while (String(tokens[position]).toUpperCase() === "OR") {
      position += 1;
      const right = parseAnd();
      node = { type: "OR", conditions: [node, right] };
    }
    return node;
  };
  if (!expression.trim()) return undefined;
  const tree = parseOr();
  if (position !== tokens.length) throw new Error("Filter expression contains unexpected text");
  return tree;
}

interface DynamicObjectConfig {
  label: string;
  model: "customRecord";
  fields: Record<string, ReportField>;
}

interface ResultGroup {
  key: string;
  groupValues: Record<string, string>;
  count: number;
  summary: Record<string, number>;
  rows: Record<string, unknown>[];
}

interface GroupedDetailRow {
  groupValues: Record<string, string>;
  groupCounts: Record<string, number>;
  values: Record<string, unknown>;
}

interface PivotRow {
  group: string;
  groupValues: Record<string, string>;
  values: Record<string, number>;
}

const relativeDateOperators = new Set([
  "today",
  "yesterday",
  "tomorrow",
  "thisWeek",
  "lastWeek",
  "nextWeek",
  "thisMonth",
  "lastMonth",
  "nextMonth",
  "thisQuarter",
  "lastQuarter",
  "thisYear",
  "lastYear",
  "last90Days",
]);

function dateRange(
  operator: string,
  now = new Date(),
  timeZone = DEFAULT_CRM_TIMEZONE,
): { gte: Date; lt: Date } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const start = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  switch (operator) {
    case "today":
      end.setUTCDate(end.getUTCDate() + 1);
      break;

    case "yesterday":
      start.setUTCDate(start.getUTCDate() - 1);
      end.setTime(start.getTime());
      end.setUTCDate(end.getUTCDate() + 1);
      break;

    case "tomorrow":
      start.setUTCDate(start.getUTCDate() + 1);
      end.setTime(start.getTime());
      end.setUTCDate(end.getUTCDate() + 1);
      break;

    case "thisWeek": {
      const day = start.getUTCDay();
      start.setUTCDate(start.getUTCDate() - day);
      end.setTime(start.getTime());
      end.setUTCDate(end.getUTCDate() + 7);
      break;
    }

    case "lastWeek": {
      const day = start.getUTCDay();
      start.setUTCDate(start.getUTCDate() - day - 7);
      end.setTime(start.getTime());
      end.setUTCDate(end.getUTCDate() + 7);
      break;
    }

    case "nextWeek": {
      const day = start.getUTCDay();
      start.setUTCDate(start.getUTCDate() - day + 7);
      end.setTime(start.getTime());
      end.setUTCDate(end.getUTCDate() + 7);
      break;
    }

    case "thisMonth":
      start.setUTCDate(1);
      end.setTime(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      break;

    case "lastMonth":
      start.setUTCDate(1);
      start.setUTCMonth(start.getUTCMonth() - 1);
      end.setTime(Date.UTC(Number(parts.year), Number(parts.month) - 1, 1));
      break;

    case "nextMonth":
      start.setUTCDate(1);
      start.setUTCMonth(start.getUTCMonth() + 1);
      end.setTime(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).getTime());
      break;

    case "thisQuarter": {
      const quarterStart = Math.floor(start.getUTCMonth() / 3) * 3;
      start.setUTCMonth(quarterStart, 1);
      end.setTime(Date.UTC(start.getUTCFullYear(), quarterStart + 3, 1));
      break;
    }

    case "lastQuarter": {
      const quarterStart = Math.floor(start.getUTCMonth() / 3) * 3 - 3;
      start.setUTCMonth(quarterStart, 1);
      end.setTime(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 1));
      break;
    }

    case "thisYear":
      start.setUTCMonth(0, 1);
      end.setTime(Date.UTC(start.getUTCFullYear() + 1, 0, 1));
      break;

    case "lastYear":
      start.setUTCFullYear(start.getUTCFullYear() - 1, 0, 1);
      end.setTime(Date.UTC(Number(parts.year), 0, 1));
      break;

    case "last90Days":
      start.setUTCDate(start.getUTCDate() - 89);
      end.setUTCDate(end.getUTCDate() + 1);
      break;
  }

  return {
    gte: crmDateToUtcStart(start.toISOString().slice(0, 10), timeZone),
    lt: crmDateToUtcStart(end.toISOString().slice(0, 10), timeZone),
  };
}

function getNestedValue(source: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, key) => {
      if (value == null || typeof value !== "object") {
        return undefined;
      }

      return (value as Record<string, unknown>)[key];
    }, source);
}

function readFieldValue(record: unknown, field: ReportField): unknown {
  if (field.path === 'bookingSource') {
    const bookings = getNestedValue(record, 'bookings');
    const rows = Array.isArray(bookings) ? bookings as Array<{ status?: string; lead?: { source?: string | null } | null }> : [];
    const active = rows.find((booking) => booking.status !== 'CANCELLED');
    return active?.lead?.source ?? null;
  }
  if (field.path === 'villaPrice') {
    const type = String(getNestedValue(record, 'type') || '').trim().toLowerCase();
    const price = getNestedValue(record, 'price');
    return type === 'villa' ? (typeof price === 'number' ? price : 0) : 0;
  }
  if (field.path === 'Area__c') {
    const value = getNestedValue(record, 'customFields.Area__c');
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return null;
  }
  if (field.combine?.length) {
    const parts = field.combine
      .map((path) => getNestedValue(record, path))
      .map((value) => (value == null ? "" : String(value).trim()))
      .filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }

  return getNestedValue(record, field.path);
}

function addFieldSelect(select: Record<string, any>, field: ReportField) {
  if (field.path === 'bookingSource') {
    addSelectPath(select, 'bookings.status');
    addSelectPath(select, 'bookings.lead.source');
    return;
  }
  if (field.path === 'villaPrice') {
    addSelectPath(select, 'type');
    addSelectPath(select, 'price');
    return;
  }
  if (field.path === 'Area__c') {
    select.customFields = true;
    return;
  }
  const paths = field.combine?.length ? field.combine : [field.path];
  for (const path of paths) {
    addSelectPath(select, path);
  }
}

function addSelectPath(select: Record<string, any>, path: string) {
  const parts = path.split(".");
  let current = select;

  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];

    if (!current[part]) {
      current[part] = { select: {} };
    }

    current = current[part].select;
  }

  current[parts[parts.length - 1]] = true;
}

function convertValue(value: unknown, field: ReportField, timeZone = DEFAULT_CRM_TIMEZONE) {
  if (value === undefined || value === null || value === "") {
    return value;
  }

  switch (field.type) {
    case "number":
      return Number(value);

    case "date":
      return parseDateValue(value, timeZone);

    case "enum":
      return String(value);

    default:
      return value;
  }
}

export function createCondition(
  field: ReportField,
  operator: string,
  value: unknown,
  timeZone = DEFAULT_CRM_TIMEZONE,
) {
  if (field.type === "date" && relativeDateOperators.has(operator)) {
    return dateRange(operator, new Date(), timeZone);
  }

  if (field.type === "date" && operator === "customRange") {
    const range = value && typeof value === "object" ? value as Record<string, unknown> : null;
    const start = parseDateValue(range?.start, timeZone);
    let end = parseDateValue(range?.end, timeZone);

    if (!start || !end) {
      throw new Error("Custom date range requires valid start and end values");
    }

    if (start.getTime() > end.getTime()) {
      throw new Error("Custom date range start must be before end");
    }
    if (typeof range?.end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(range.end)) {
      const nextDate = new Date(`${range.end}T00:00:00.000Z`);
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      end = crmDateToUtcStart(nextDate.toISOString().slice(0, 10), timeZone);
    }

    return {
      gte: start,
      lt: end,
    };
  }

  if (value === undefined || value === null || value === "") {
    if (field.type === "date" || field.type === "number") {
      return { not: null };
    }
  }

  const convertedValue = convertValue(value, field, timeZone);
  const isStringLike = field.type === "string" || field.type === "enum";
  const stringOnlyOperators = new Set([
    "contains",
    "notContains",
    "startsWith",
    "endsWith",
  ]);

  if (field.type === "date" && convertedValue instanceof Date && Number.isNaN(convertedValue.getTime())) {
    return { not: null };
  }

  if (stringOnlyOperators.has(operator) && !isStringLike) {
    return { equals: convertedValue };
  }

  switch (operator) {
    case "equals":
      return convertedValue;

    case "notEquals":
      return { not: convertedValue };

    case "contains":
      return {
        contains: String(convertedValue ?? ""),
        mode: "insensitive",
      };

    case "notContains":
      return { not: { contains: String(convertedValue ?? ""), mode: "insensitive" } };

    case "startsWith":
      return {
        startsWith: String(convertedValue ?? ""),
        mode: "insensitive",
      };

    case "endsWith":
      return {
        endsWith: String(convertedValue ?? ""),
        mode: "insensitive",
      };

    case "gt":
      return { gt: convertedValue };

    case "gte":
      return { gte: convertedValue };

    case "lt":
      return { lt: convertedValue };

    case "lte":
      return { lte: convertedValue };

    case "isBlank":
      return { equals: null };

    case "isNotBlank":
      return { not: null };

    case "in":
      return { in: Array.isArray(value) ? value.map((item) => convertValue(item, field)) : String(value).split(",").map((item) => convertValue(item.trim(), field)) };

    case "notIn":
      return { notIn: Array.isArray(value) ? value.map((item) => convertValue(item, field)) : String(value).split(",").map((item) => convertValue(item.trim(), field)) };

    default:
      throw new Error(`Unsupported operator: ${operator}`);
  }
}

function buildNestedObject(path: string, value: unknown) {
  const parts = path.split(".");
  let result: Record<string, unknown> = value as Record<string, unknown>;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    result = { [parts[index]]: result };
  }

  return result;
}

function buildWhere(
  objectConfig: { fields: Record<string, ReportField> },
  tenantId: string,
  filters: ReportFilter[],
  filterLogic: "AND" | "OR" = "AND",
  filterTree?: FilterTree,
  showMe: "all" | "mine" = "all",
  userId?: string,
  timeZone = DEFAULT_CRM_TIMEZONE,
) {
  const validFilters = filters.filter((filter) => {
    const field = objectConfig.fields[filter.field];
    if (!field) {
      throw new Error(`Unknown report field: ${filter.field}`);
    }

    const valueOptional = ['isBlank', 'isNotBlank', 'customRange', ...relativeDateOperators];
    if (valueOptional.includes(filter.operator)) {
      return true;
    }

    if (field.type === "date") {
      const parsed = new Date(String(filter.value));
      return !Number.isNaN(parsed.getTime());
    }

    return true;
  });

  const systemConditions = showMe === "mine" && userId && objectConfig.fields.ownerId ? [{ ownerId: userId }] : [];
  if (validFilters.length === 0) {
    return { AND: [{ tenantId }, ...systemConditions] };
  }

  const buildFilterWhere = (filter: ReportFilter, field: ReportField): Record<string, unknown> => {
    if (field.path === 'bookingSource' || field.path === 'villaPrice') {
      throw new Error(`${field.label} is calculated and cannot be filtered`);
    }
    if (field.path === 'Area__c') {
      const condition = createCondition(field, filter.operator, filter.value, timeZone);
      const jsonFilter = condition !== null && typeof condition === 'object' && !Array.isArray(condition)
        ? { path: ['Area__c'], ...condition }
        : { path: ['Area__c'], equals: condition };
      return { customFields: jsonFilter };
    }
    const isStringLike = field.type === "string" || field.type === "enum";
    const isRequiredIdentifier = field.path === "id";
    const isBlankValue = isStringLike && (filter.operator === "isBlank" || (filter.operator === "equals" && filter.value === ""));
    const isNotBlankValue = isStringLike && (filter.operator === "isNotBlank" || (filter.operator === "notEquals" && filter.value === ""));
    if (isRequiredIdentifier && isBlankValue) return buildNestedObject(field.path, { equals: "" });
    if (isRequiredIdentifier && isNotBlankValue) return buildNestedObject(field.path, { not: "" });
    if (isBlankValue) {
      return {
        OR: [
          buildNestedObject(field.path, { equals: null }),
          buildNestedObject(field.path, { equals: "" }),
        ],
      };
    }
    if (isNotBlankValue) {
      return {
        AND: [
          buildNestedObject(field.path, { not: null }),
          buildNestedObject(field.path, { not: "" }),
        ],
      };
    }
    return buildNestedObject(field.path, createCondition(field, filter.operator, filter.value, timeZone));
  };

  const buildTreeWhere = (node: FilterTree): Record<string, unknown> => {
    if ("filterIndex" in node) {
      const filter = filters[node.filterIndex];
      if (!filter) throw new Error(`Filter expression references invalid filter ${node.filterIndex + 1}`);
      const field = objectConfig.fields[filter.field];
      if (!field) throw new Error(`Unknown report field: ${filter.field}`);
      return buildFilterWhere(filter, field);
    }
    const conditions = node.conditions.map(buildTreeWhere);
    return node.type === "OR" ? { OR: conditions } : { AND: conditions };
  };

  if (filterTree) {
    return { AND: [{ tenantId }, ...systemConditions, buildTreeWhere(filterTree)] };
  }

  const filterConditions = validFilters.map((filter) => {
    const field = objectConfig.fields[filter.field];

    if (!field) {
      throw new Error(`Unknown report field: ${filter.field}`);
    }

    return buildFilterWhere(filter, field);
  });

  if (filterLogic === "OR") {
    return {
      AND: [
        { tenantId },
        ...systemConditions,
        { OR: filterConditions },
      ],
    };
  }

  return {
    AND: [
      { tenantId },
      ...systemConditions,
      ...filterConditions,
    ],
  };
}

const relationMap: Record<string, Record<string, string>> = {
  Lead: {
    SiteVisit: "siteVisits",
    FollowUp: "followUps",
    Enquiry: "enquiries",
  },
  SiteVisit: {
    Activity: "activities",
  },
  Project: {
    Lead: "leads",
    SiteVisit: "siteVisits",
    Unit: "units",
  },
  Unit: {
    Booking: "bookings",
  },
  Enquiry: {
    FollowUp: "followUps",
  },
  Booking: {
    FollowUp: "followUps",
  },
};

function applyCrossFilter(
  where: any,
  objectName: string,
  crossFilter?: RunReportInput["crossFilter"],
) {
  if (!crossFilter) {
    return where;
  }

  const relation = relationMap[objectName]?.[crossFilter.objectName];

  if (!relation) {
    throw new Error(
      `Unsupported cross filter: ${objectName} ${crossFilter.mode} ${crossFilter.objectName}`,
    );
  }

  return {
    ...where,
    [relation]: crossFilter.mode === "with"
      ? { some: {} }
      : { none: {} },
  };
}

function matchesFilter(
  record: unknown,
  field: ReportField,
  operator: string,
  value: unknown,
) {
  const actual = readFieldValue(record, field);

  if (field.type === "date" && relativeDateOperators.has(operator)) {
    if (actual == null) {
      return false;
    }

    const timestamp = new Date(String(actual)).getTime();
    const range = dateRange(operator);

    return (
      timestamp >= range.gte.getTime() &&
      timestamp < range.lt.getTime()
    );
  }

  if (field.type === "date" && operator === "customRange") {
    if (actual == null) {
      return false;
    }

    const timestamp = new Date(String(actual)).getTime();
    const range = value && typeof value === "object" ? value as Record<string, unknown> : null;
    const start = parseDateValue(range?.start);
    const end = parseDateValue(range?.end);

    if (!start || !end) {
      throw new Error("Custom date range requires valid start and end values");
    }

    return timestamp >= start.getTime() && timestamp <= end.getTime();
  }

  const expected = convertValue(value, field);

  switch (operator) {
    case "equals":
      return String(actual ?? "").toLowerCase() ===
        String(expected ?? "").toLowerCase();

    case "notEquals":
      return String(actual ?? "").toLowerCase() !==
        String(expected ?? "").toLowerCase();

    case "contains":
      return String(actual ?? "").toLowerCase().includes(
        String(expected ?? "").toLowerCase(),
      );

    case "notContains":
      return !String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());

    case "startsWith":
      return String(actual ?? "").toLowerCase().startsWith(
        String(expected ?? "").toLowerCase(),
      );

    case "endsWith":
      return String(actual ?? "").toLowerCase().endsWith(
        String(expected ?? "").toLowerCase(),
      );

    case "gt":
      return actual != null && expected != null && actual > expected;

    case "gte":
      return actual != null && expected != null && actual >= expected;

    case "lt":
      return actual != null && expected != null && actual < expected;

    case "lte":
      return actual != null && expected != null && actual <= expected;

    case "isBlank":
      return actual == null || actual === "";

    case "isNotBlank":
      return actual != null && actual !== "";

    case "in": {
      const values = Array.isArray(value) ? value : String(value ?? "").split(",").map((item) => item.trim());
      return values.some((item) => String(actual ?? "").toLowerCase() === String(item).toLowerCase());
    }

    case "notIn": {
      const values = Array.isArray(value) ? value : String(value ?? "").split(",").map((item) => item.trim());
      return !values.some((item) => String(actual ?? "").toLowerCase() === String(item).toLowerCase());
    }

    default:
      throw new Error(`Unsupported operator: ${operator}`);
  }
}

function matchesFilterTree(record: unknown, tree: FilterTree, filters: ReportFilter[], objectConfig: { fields: Record<string, ReportField> }): boolean {
  if ("filterIndex" in tree) {
    const filter = filters[tree.filterIndex];
    if (!filter) return false;
    const field = objectConfig.fields[filter.field];
    if (!field) throw new Error(`Unknown report field: ${filter.field}`);
    return matchesFilter(record, field, filter.operator, filter.value);
  }
  const matches = tree.conditions.map((condition) => matchesFilterTree(record, condition, filters, objectConfig));
  return tree.type === "OR" ? matches.some(Boolean) : matches.every(Boolean);
}

function calculateAggregate(
  records: any[],
  aggregate: ReportAggregate,
  objectConfig: { fields: Record<string, ReportField> },
): number {
  if (aggregate.function === "count") {
    return records.length;
  }

  if (aggregate.function === "uniqueCount") {
    if (!aggregate.field) return 0;
    const field = objectConfig.fields[aggregate.field];
    if (!field) throw new Error(`Unknown aggregate field: ${aggregate.field}`);
    return new Set(records.map((record) => JSON.stringify(readFieldValue(record, field))).filter((value) => value !== undefined && value !== "null")).size;
  }

  if (!aggregate.field) {
    return 0;
  }

  const field = objectConfig.fields[aggregate.field];

  if (!field) {
    throw new Error(`Unknown aggregate field: ${aggregate.field}`);
  }

  if (field.type !== "number") {
    throw new Error(
      `Aggregate field must be numeric: ${aggregate.field}`,
    );
  }

  const values = records
    .map((record) => Number(readFieldValue(record, field)))
    .filter(Number.isFinite);

  if (values.length === 0) {
    return 0;
  }

  switch (aggregate.function) {
    case "sum":
      return values.reduce((total, value) => total + value, 0);

    case "avg":
      return (
        values.reduce((total, value) => total + value, 0) /
        values.length
      );

    case "min":
      return Math.min(...values);

    case "max":
      return Math.max(...values);

    default:
      return 0;
  }
}

function getAggregateLabel(
  aggregate: ReportAggregate,
  objectConfig: { fields: Record<string, ReportField> },
) {
  if (aggregate.label) {
    return aggregate.label;
  }

  if (aggregate.function === "count") {
    return "Record Count";
  }

  const field = aggregate.field
    ? objectConfig.fields[aggregate.field]
    : undefined;

  const fieldLabel = field?.label || aggregate.field || "Value";
  const functionLabel =
    aggregate.function.charAt(0).toUpperCase() +
    aggregate.function.slice(1);

  return `${functionLabel} ${fieldLabel}`;
}

function calculateAggregates(
  records: any[],
  aggregates: ReportAggregate[],
  objectConfig: { fields: Record<string, ReportField> },
) {
  const summary: Record<string, number> = {};

  for (const aggregate of aggregates) {
    summary[getAggregateLabel(aggregate, objectConfig)] = calculateAggregate(
      records,
      aggregate,
      objectConfig,
    );
  }

  return summary;
}

function buildRows(
  records: any[],
  columns: string[],
  objectConfig: { fields: Record<string, ReportField> },
) {
  return records.map((record) => {
    const row: Record<string, unknown> = {};

    for (const column of columns) {
      if (isVirtualReportColumn(column)) {
        row[column] = 1;
        continue;
      }

      const field = objectConfig.fields[column];

      if (!field) {
        throw new Error(`Unknown report column: ${column}`);
      }

      row[column] = readFieldValue(record, field);
    }

    return row;
  });
}

function groupValue(
  record: any,
  fieldNames: string[],
  objectConfig: { fields: Record<string, ReportField> },
  groupOptions: Record<string, { dateBucket?: string }> = {},
  timeZone = DEFAULT_CRM_TIMEZONE,
) {
  const values: Record<string, string> = {};

  for (const fieldName of fieldNames) {
    const field = objectConfig.fields[fieldName];

    if (!field) {
      throw new Error(`Unknown group field: ${fieldName}`);
    }

    const raw = readFieldValue(record, field);
    if (raw == null || raw === "") {
      values[fieldName] = "(Blank)";
      continue;
    }
    if (field.type === "date") {
      const date = new Date(String(raw));
      if (!Number.isNaN(date.getTime())) {
        const bucket = groupOptions[fieldName]?.dateBucket || "day";
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(date).map((part) => [part.type, part.value]));
        const year = Number(parts.year);
        const month = Number(parts.month) - 1;
        const day = Number(parts.day);
        if (bucket === "year") values[fieldName] = String(year);
        else if (bucket === "quarter") values[fieldName] = `Q${Math.floor(month / 3) + 1} ${year}`;
        else if (bucket === "month") values[fieldName] = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone }).format(date);
        else if (bucket === "week") {
          const start = new Date(Date.UTC(year, month, day));
          start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
          values[fieldName] = `Week of ${start.toISOString().slice(0, 10)}`;
        } else values[fieldName] = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        continue;
      }
    }
    const displayValue = typeof raw === "object"
      ? (raw as Record<string, unknown>).name || (raw as Record<string, unknown>).label || (raw as Record<string, unknown>).fullName || (raw as Record<string, unknown>).displayName
      : raw;
    values[fieldName] = displayValue == null || displayValue === "" ? "(Blank)" : String(displayValue);
  }

  return values;
}

function groupKey(groupValues: Record<string, string>, fields: string[]) {
  return fields
    .map((field) => `${field}=${groupValues[field]}`)
    .join("||");
}

function displayGroupKey(groupValues: Record<string, string>, fields: string[]) {
  return fields.map((field) => groupValues[field]).join(" / ");
}

export function canAccessReportForUser(
  report: { createdBy?: string | null; isShared?: boolean | null; tenantId?: string | null },
  user: { id: string; tenantId: string; isSuperAdmin?: boolean },
  permissions: string[] = [],
) {
  if (user.isSuperAdmin) {
    return true;
  }

  if (report.tenantId && report.tenantId !== user.tenantId) {
    return false;
  }

  if (!permissions.includes('REPORT_VIEW') && !permissions.includes('REPORT_READ')) {
    return false;
  }

  return report.createdBy === user.id || Boolean(report.isShared);
}

export function canAccessDashboardForUser(
  dashboard: { createdBy?: string | null; isDefault?: boolean | null; tenantId?: string | null },
  user: { id: string; tenantId: string; isSuperAdmin?: boolean },
  permissions: string[] = [],
) {
  if (user.isSuperAdmin) {
    return true;
  }

  if (dashboard.tenantId && dashboard.tenantId !== user.tenantId) {
    return false;
  }

  if (!permissions.includes('DASHBOARD_READ')) {
    return false;
  }

  return dashboard.createdBy === user.id || Boolean(dashboard.isDefault);
}

export function canAccessReportFolderForUser(
  folder: { createdBy?: string | null; isShared?: boolean | null; tenantId?: string | null },
  user: { id: string; tenantId: string; isSuperAdmin?: boolean },
  permissions: string[] = [],
) {
  if (user.isSuperAdmin) {
    return true;
  }

  if (folder.tenantId && folder.tenantId !== user.tenantId) {
    return false;
  }

  if (!permissions.includes('REPORT_VIEW') && !permissions.includes('REPORT_READ')) {
    return false;
  }

  return folder.createdBy === user.id || Boolean(folder.isShared);
}

export async function runReport(input: RunReportInput) {
  validateReportRequest(input);
  const timeZone = await getTenantTimezone(input.tenantId);

  const rowGroups = input.rowGroups?.length
    ? [...input.rowGroups]
    : input.groupBy
      ? [input.groupBy]
      : [];

  const columnGroups = input.columnGroups?.length
    ? [...input.columnGroups]
    : input.groupColumn
      ? [input.groupColumn]
      : [];
  const groupOptions = input.groupOptions || {};
  for (const field of [...rowGroups, ...columnGroups]) {
    const bucket = groupOptions[field]?.dateBucket;
    if (bucket && !dateGroupBuckets.has(bucket)) throw new Error(`Invalid date grouping bucket: ${bucket}`);
  }

  const configuredObject = Object.entries(REPORT_OBJECTS).find(
    ([name, object]) =>
      name.toLowerCase() === input.objectName.toLowerCase() &&
      Boolean((prisma as any)[object.model]?.findMany),
  );
  let objectConfig: ReportObjectConfig | undefined = configuredObject?.[1];
  let dynamicRecords: any[] | null = null;

  if (!objectConfig) {
    const storedObject = reportObjectFromPrismaModel(input.objectName);
    if (storedObject) objectConfig = storedObject;
  }

  if (!objectConfig) {
    const definition = await prisma.objectDefinition.findFirst({
      where: {
        tenantId: input.tenantId,
        name: {
          equals: input.objectName,
          mode: "insensitive",
        },
        isActive: true,
      },
      include: {
        fields: {
          where: {
            isActive: true,
            visible: true,
          },
          orderBy: {
            displayOrder: "asc",
          },
        },
      },
    });

    if (!definition) {
      throw new Error(
        `Unsupported report object: ${input.objectName}`,
      );
    }

    const dynamicConfig: DynamicObjectConfig = {
      label: definition.pluralLabel || definition.label,
      model: "customRecord",
      fields: Object.fromEntries(
        definition.fields.map((field) => [
          field.name,
          {
            label: field.label,
            path: field.name,
            type:
              ["number", "currency", "decimal"].includes(field.fieldType)
                ? "number"
                : ["date", "dateTime"].includes(field.fieldType)
                  ? "date"
                  : field.fieldType === "picklist"
                    ? "enum"
                    : "string",
          } satisfies ReportField,
        ]),
      ),
    };

    objectConfig = dynamicConfig;

    const customRecords = await prisma.customRecord.findMany({
      where: {
        tenantId: input.tenantId,
        objectId: definition.id,
        isActive: true,
      },
    });

    dynamicRecords = customRecords.map((record) => ({
      ...(record.data as Record<string, unknown>),
      id: record.id,
      recordNumber: record.recordNumber,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  const delegate = (prisma as any)[objectConfig.model];

  if (!delegate && !dynamicRecords) {
    throw new Error(`Prisma model not found: ${objectConfig.model}`);
  }

  if (!input.columns?.length) {
    throw new Error("At least one report column is required");
  }

  const select: Record<string, any> = {};

  for (const column of input.columns) {
    if (isVirtualReportColumn(column)) continue;
    const field = objectConfig.fields[column];
    if (!field) {
      throw new Error(`Unknown report column: ${column}`);
    }
    addFieldSelect(select, field);
  }

  for (const fieldName of rowGroups) {
    const field = objectConfig.fields[fieldName];
    if (!field) {
      throw new Error(`Unknown row group field: ${fieldName}`);
    }
    addFieldSelect(select, field);
  }

  for (const fieldName of columnGroups) {
    const field = objectConfig.fields[fieldName];
    if (!field) {
      throw new Error(`Unknown column group field: ${fieldName}`);
    }
    addFieldSelect(select, field);
  }

  if (input.sortBy) {
    const sortField = objectConfig.fields[input.sortBy];
    if (!sortField) {
      throw new Error(`Unknown sort field: ${input.sortBy}`);
    }
    addFieldSelect(select, sortField);
  }

  const aggregates =
    input.aggregates?.length
      ? input.aggregates
      : [{ function: "count" as const }];

  for (const aggregate of aggregates) {
    if (aggregate.function === "count" || !aggregate.field) {
      continue;
    }

    const aggregateField = objectConfig.fields[aggregate.field];
    if (!aggregateField) {
      throw new Error(
        `Unknown aggregate field: ${aggregate.field}`,
      );
    }

    addFieldSelect(select, aggregateField);
  }

  const fetchedRecords = dynamicRecords ||
    await delegate.findMany({
      where: applyCrossFilter(
        buildWhere(
          objectConfig,
          input.tenantId,
          input.filters || [],
          input.filterLogic || "AND",
          input.filterTree,
          input.showMe || "all",
          input.userId,
          timeZone,
        ),
        input.objectName,
        input.crossFilter,
      ),
      select,
    });

  const workingRecords = dynamicRecords
    ? fetchedRecords.filter((record: any) => {
        const filters = input.filters || [];

        if (filters.length === 0) {
          return true;
        }

        if (input.filterTree) return matchesFilterTree(record, input.filterTree, filters, objectConfig);

        const matches = filters.map((filter) => {
          const field = objectConfig.fields[filter.field];

          if (!field) {
            throw new Error(`Unknown report field: ${filter.field}`);
          }

          return matchesFilter(
            record,
            field,
            filter.operator,
            filter.value,
          );
        });

        return input.filterLogic === "OR"
          ? matches.some(Boolean)
          : matches.every(Boolean);
      })
    : fetchedRecords;

  const sortRules = input.sortRules?.length
    ? input.sortRules
    : input.sortBy ? [{ field: input.sortBy, order: input.sortOrder || "desc" }] : [];
  for (const rule of sortRules) {
    if (!objectConfig.fields[rule.field]) throw new Error(`Unknown sort field: ${rule.field}`);
  }
  if (sortRules.length) {
    workingRecords.sort((a: any, b: any) => {
      for (const rule of sortRules) {
        const field = objectConfig.fields[rule.field];
        const aValue = readFieldValue(a, field);
        const bValue = readFieldValue(b, field);
        if (aValue == null && bValue == null) continue;
        if (aValue == null) return 1;
        if (bValue == null) return -1;
        const comparison = aValue === bValue ? 0 : aValue > bValue ? 1 : -1;
        if (comparison !== 0) return rule.order === "asc" ? comparison : -comparison;
      }
      return 0;
    });
  }

  const totalRows = workingRecords.length;

  const summary = calculateAggregates(
    workingRecords,
    aggregates,
    objectConfig,
  );

  /*
   * limit is ONLY the number of detail rows returned to the UI.
   * Summary/group counts/pivot calculations use ALL matching records.
   */
  const limit =
    typeof input.limit === "number" && input.limit > 0
      ? Math.floor(input.limit)
      : 1000;

  const limitedRecords = workingRecords.slice(0, limit);
  const rows = buildRows(
    limitedRecords,
    input.columns,
    objectConfig,
  );

  let groups: ResultGroup[] | undefined;
  let groupedDetailRows: GroupedDetailRow[] | undefined;

  if (rowGroups.length > 0) {
    const allGroups = new Map<
      string,
      {
        groupValues: Record<string, string>;
        records: any[];
      }
    >();

    for (const record of workingRecords) {
      const values = groupValue(record, rowGroups, objectConfig, groupOptions, timeZone);
      const key = groupKey(values, rowGroups);
      const existing = allGroups.get(key);

      if (existing) {
        existing.records.push(record);
      } else {
        allGroups.set(key, {
          groupValues: values,
          records: [record],
        });
      }
    }

    const groupCountsByKey = new Map<string, number>();

    for (const [key, value] of allGroups) {
      groupCountsByKey.set(key, value.records.length);
    }

    const previewRecordsByGroup = new Map<string, any[]>();

    for (const record of limitedRecords) {
      const values = groupValue(record, rowGroups, objectConfig, groupOptions, timeZone);
      const key = groupKey(values, rowGroups);
      const list = previewRecordsByGroup.get(key) || [];
      list.push(record);
      previewRecordsByGroup.set(key, list);
    }

    groups = [...allGroups.entries()].map(([key, value]) => ({
      key,
      groupValues: value.groupValues,
      count: value.records.length,
      summary: calculateAggregates(
        value.records,
        aggregates,
        objectConfig,
      ),
      rows: buildRows(
        previewRecordsByGroup.get(key) || [],
        input.columns,
        objectConfig,
      ),
    }));

    groupedDetailRows = limitedRecords.map((record: any) => {
      const values = groupValue(record, rowGroups, objectConfig, groupOptions, timeZone);
      const key = groupKey(values, rowGroups);
      const counts: Record<string, number> = {};
      const totalCount = groupCountsByKey.get(key) || 0;

      for (const field of rowGroups) {
        counts[field] = totalCount;
      }

      const normalValues = buildRows(
        [record],
        input.columns,
        objectConfig,
      )[0] || {};

      return {
        groupValues: values,
        groupCounts: counts,
        values: normalValues,
      };
    });
  }

  let columnGroupResults:
    | { group: string; groupValues: Record<string, string>; count: number }[]
    | undefined;

  let pivot:
    | {
        rowGroups: string[];
        columnGroups: string[];
        aggregateLabel: string;
        columns: string[];
        columnValues: Record<string, Record<string, string>>;
        rows: PivotRow[];
      }
    | undefined;

  if (columnGroups.length > 0) {
    const distinctColumnGroups = new Map<
      string,
      Record<string, string>
    >();

    for (const record of workingRecords) {
      const values = groupValue(record, columnGroups, objectConfig, groupOptions, timeZone);
      const key = groupKey(values, columnGroups);

      if (!distinctColumnGroups.has(key)) {
        distinctColumnGroups.set(key, values);
      }
    }

    columnGroupResults = [];

    for (const [key, groupValues] of distinctColumnGroups) {
      const count = workingRecords.filter((record: any) => {
        const current = groupValue(record, columnGroups, objectConfig, groupOptions, timeZone);
        return groupKey(current, columnGroups) === key;
      }).length;

      columnGroupResults.push({
        group: displayGroupKey(groupValues, columnGroups),
        groupValues,
        count,
      });
    }

    if (rowGroups.length > 0) {
      const pivotMap = new Map<
        string,
        {
          groupValues: Record<string, string>;
          cells: Map<string, any[]>;
        }
      >();

      for (const record of workingRecords) {
        const rowValues = groupValue(record, rowGroups, objectConfig, groupOptions, timeZone);
        const columnValues = groupValue(record, columnGroups, objectConfig, groupOptions, timeZone);

        const rowKey = groupKey(rowValues, rowGroups);
        const columnKey = groupKey(columnValues, columnGroups);

        let rowEntry = pivotMap.get(rowKey);

        if (!rowEntry) {
          rowEntry = {
            groupValues: rowValues,
            cells: new Map<string, any[]>(),
          };
          pivotMap.set(rowKey, rowEntry);
        }

        const records = rowEntry.cells.get(columnKey) || [];
        records.push(record);
        rowEntry.cells.set(columnKey, records);
      }

      const firstAggregate = aggregates[0] || {
        function: "count" as const,
      };

      const pivotColumns = [...distinctColumnGroups.entries()].map(
        ([key, groupValues]) => ({
          key,
          label: displayGroupKey(groupValues, columnGroups),
        }),
      );

      pivot = {
        rowGroups,
        columnGroups,
        aggregateLabel: getAggregateLabel(
          firstAggregate,
          objectConfig,
        ),
        columns: pivotColumns.map((item) => item.label),
        columnValues: Object.fromEntries(
          pivotColumns.map((item) => [item.label, distinctColumnGroups.get(item.key)!]),
        ),
        rows: [...pivotMap.values()].map((entry) => ({
          group: displayGroupKey(entry.groupValues, rowGroups),
          groupValues: entry.groupValues,
          values: Object.fromEntries(
            pivotColumns.map((column: { key: string; label: string }) => [
              column.label,
              calculateAggregate(
                entry.cells.get(column.key) || [],
                firstAggregate,
                objectConfig,
              ),
            ]),
          ),
        })),
      };
    }
  }

  return {
    objectName: input.objectName,
    columns: input.columns,
    totalRows,
    rows,
    groupedDetailRows,
    summary,
    groups,
    columnGroups: columnGroupResults,
    pivot,
  };
}

type ReportObjectConfig = {
  label: string;
  category?: string;
  model: string;
  fields: Record<string, ReportField>;
};
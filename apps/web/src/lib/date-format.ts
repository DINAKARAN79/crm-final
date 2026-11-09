import {
  DEFAULT_CRM_TIMEZONE,
  crmDateTimeInputValue,
  formatCRMDate,
  formatCRMDateTime,
  resolveCRMTimezone,
} from "@dct-crm/shared";

let tenantTimezone = DEFAULT_CRM_TIMEZONE;

export function setTenantTimezone(timezone?: string | null): void {
  tenantTimezone = resolveCRMTimezone(timezone);
}

export function getTenantTimezone(): string {
  return tenantTimezone;
}

export function formatDate(value: string | number | Date, timezone = tenantTimezone): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return formatCRMDate(date, timezone);
}

export function formatDateTime(value: string | number | Date, timezone = tenantTimezone): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return formatCRMDateTime(date, timezone);
}

export function formatDateShort(value: string | number | Date, timezone = tenantTimezone): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: resolveCRMTimezone(timezone),
  }).format(date);
}

export function dateKey(value: string | number | Date, timezone = tenantTimezone): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: resolveCRMTimezone(timezone),
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function dateTimeInputValue(value = new Date(), timezone = tenantTimezone): string {
  return crmDateTimeInputValue(value, timezone);
}

export function formatDateOnly(value: string, locale = "en-GB"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "-";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

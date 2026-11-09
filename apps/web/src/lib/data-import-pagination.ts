export const IMPORT_PAGE_SIZE = 200;

export function getPageCount(rowCount: number, pageSize = IMPORT_PAGE_SIZE): number {
  return Math.ceil(rowCount / pageSize);
}

export function getPageNumbers(page: number, pageCount: number, radius = 2): number[] {
  if (pageCount <= 0) return [];
  const start = Math.max(0, Math.min(page - radius, pageCount - (radius * 2 + 1)));
  const end = Math.min(pageCount, start + radius * 2 + 1);
  return Array.from({ length: end - start }, (_, index) => start + index);
}

export function paginateRows<T>(rows: T[], page: number, pageSize = IMPORT_PAGE_SIZE): T[] {
  const safePage = Math.max(0, Math.min(page, Math.max(0, getPageCount(rows.length, pageSize) - 1)));
  return rows.slice(safePage * pageSize, (safePage + 1) * pageSize);
}

export function filterImportRows<T>(
  rows: T[],
  query: string,
  getSearchableValues: (row: T) => unknown[],
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return rows;
  return rows.filter((row) => getSearchableValues(row)
    .some((value) => String(value ?? "").toLocaleLowerCase().includes(normalizedQuery)));
}

export function normalizeImportStatus(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases: Record<string, string> = {
    VISIT_SCHEDULED: "SITE_VISIT_SCHEDULED",
    SITE_VISIT_BOOKED: "SITE_VISIT_SCHEDULED",
    VISIT_HAPPENED: "SITE_VISIT_HAPPENED",
    SITE_VISIT_COMPLETED: "SITE_VISIT_HAPPENED",
  };
  return aliases[normalized] || normalized || "NEW";
}

export function getImportAssignmentLabel(status: string, projectValue: string, ownerValue: string): string {
  if (status === "BOOKED") return "Booked Bucket";
  if (ownerValue.trim()) return "Mapped owner";
  if (!projectValue.trim() || status === "LOST") return "System Administrator fallback";
  if (status === "NEW" || status === "INCOMING") return "Pre Sales round robin";
  if (status === "PROSPECT" || status === "SITE_VISIT_SCHEDULED") return "SVC round robin";
  if (status === "SITE_VISIT_HAPPENED") return "Sales round robin";
  return "System Administrator fallback";
}

export function serializeDownloadCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => {
    const normalized = cell.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const safe = /^[\s]*[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  }).join(",")).join("\n");
}

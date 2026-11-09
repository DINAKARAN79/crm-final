import { describe, expect, it } from "vitest";
import {
  filterImportRows,
  getImportAssignmentLabel,
  getPageCount,
  getPageNumbers,
  IMPORT_PAGE_SIZE,
  paginateRows,
  normalizeImportStatus,
  serializeDownloadCsv,
} from "./data-import-pagination";

describe("data import pagination", () => {
  it("uses 200-row pages and returns only the selected page", () => {
    const rows = Array.from({ length: 450 }, (_, index) => index);
    expect(IMPORT_PAGE_SIZE).toBe(200);
    expect(getPageCount(rows.length)).toBe(3);
    expect(paginateRows(rows, 1)).toEqual(rows.slice(200, 400));
  });

  it("builds a bounded page-number window", () => {
    expect(getPageNumbers(5, 12)).toEqual([3, 4, 5, 6, 7]);
    expect(getPageNumbers(0, 3)).toEqual([0, 1, 2]);
  });

  it("filters across searchable fields without changing the source array", () => {
    const rows = [{ name: "Alice", error: "" }, { name: "Bob", error: "Invalid status" }];
    expect(filterImportRows(rows, "STATUS", (row) => [row.name, row.error])).toEqual([rows[1]]);
    expect(rows).toHaveLength(2);
  });

  it("normalizes imported status labels and previews status-based assignment groups", () => {
    expect(normalizeImportStatus("Site Visit Scheduled")).toBe("SITE_VISIT_SCHEDULED");
    expect(normalizeImportStatus("")).toBe("NEW");
    expect(getImportAssignmentLabel("SITE_VISIT_SCHEDULED", "Project A", "")).toBe("SVC round robin");
    expect(getImportAssignmentLabel("LOST", "Project A", "")).toBe("System Administrator fallback");
    expect(getImportAssignmentLabel("NEW", "Project A", "owner@example.com")).toBe("Mapped owner");
  });

  it("escapes spreadsheet formulas in downloaded CSV fields", () => {
    expect(serializeDownloadCsv([["=1+1", "safe", "-1"]])).toBe("'=1+1,safe,'-1");
  });
});

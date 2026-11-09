import { describe, expect, it } from "vitest";
import {
  buildMappedImportRows,
  getCsvColumns,
  parseCsvPreview,
  parseCsvPreviewAsync,
  serializeCsv,
  suggestCsvFieldMappings,
} from "./data-import-csv";

describe("parseCsvPreview", () => {
  it("parses asynchronously without changing CSV semantics and supports cancellation", async () => {
    await expect(parseCsvPreviewAsync('name,notes\r\nDana,"first\nsecond"')).resolves.toEqual({
      rows: [["name", "notes"], ["Dana", "first\nsecond"]],
      error: "",
    });
    await expect(parseCsvPreviewAsync("name\nDana", () => false)).resolves.toBeNull();
  });

  it("parses quoted commas, escaped quotes, and CRLF rows", () => {
    expect(parseCsvPreview('\uFEFFname,company\r\n"Dana, DCT","He said ""hello"""')).toEqual({
      rows: [["name", "company"], ["Dana, DCT", 'He said "hello"']],
      error: "",
    });
  });

  it("keeps newlines inside quoted values and ignores blank rows", () => {
    expect(parseCsvPreview('name,notes\nDana,"First line\nSecond line"\n\n')).toEqual({
      rows: [["name", "notes"], ["Dana", "First line\nSecond line"]],
      error: "",
    });
  });

  it("reports an unterminated quoted field", () => {
    expect(parseCsvPreview('name,notes\nDana,"unfinished')).toEqual({
      rows: [],
      error: "CSV contains an unterminated quoted field.",
    });
  });

  it("splits tab-separated data copied from a spreadsheet", () => {
    expect(parseCsvPreview("_FirstName\t_LastName\t_Company\tPhone\t_LeadSource\tStatus\nTest\t1\tABC Test Company\t9876543210\tWebsite\tNew")).toEqual({
      rows: [
        ["_FirstName", "_LastName", "_Company", "Phone", "_LeadSource", "Status"],
        ["Test", "1", "ABC Test Company", "9876543210", "Website", "New"],
      ],
      error: "",
    });
  });

  it("normalizes parsed rows into valid comma-separated CSV", () => {
    expect(serializeCsv([
      ["name", "company", "notes"],
      ["Dana", "DCT, Inc.", 'Said "hello"\nthen left'],
    ])).toBe('name,company,notes\nDana,"DCT, Inc.","Said ""hello""\nthen left"');
  });

  it("allows CSV headers to map to different CRM API field names", () => {
    const rows = parseCsvPreview("Booking Ref,Project Name\nB-001,DCT Valley").rows;
    const mappings = { 0: "bookingNumber", 1: "project" };
    expect(serializeCsv(buildMappedImportRows(rows, true, mappings))).toBe(
      "bookingNumber,project\nB-001,DCT Valley",
    );
  });

  it("imports the first row as data for headerless files", () => {
    const rows = parseCsvPreview("B-001\tDCT Valley\nB-002\tGreen Valley").rows;
    expect(getCsvColumns(rows, false)).toEqual(["Column 1", "Column 2"]);
    expect(serializeCsv(buildMappedImportRows(rows, false, { 0: "bookingNumber", 1: "project" }))).toBe(
      "bookingNumber,project\nB-001,DCT Valley\nB-002,Green Valley",
    );
  });

  it("suggests API mappings from common header names and Salesforce custom API names", () => {
    expect(suggestCsvFieldMappings(
      ["PROJECT__C", "First Name", "Unknown column"],
      [
        { name: "project", label: "Project" },
        { name: "firstName", label: "First Name" },
      ],
    )).toEqual({ 0: "project", 1: "firstName" });
  });

  it("rejects mapping one CRM field to multiple CSV columns", () => {
    expect(() => buildMappedImportRows(
      [["Project", "Project Name"], ["A", "B"]],
      true,
      { 0: "project", 1: "project" },
    )).toThrow("The project field is mapped to more than one CSV column.");
  });
});

import { describe, expect, it } from "vitest";
import { buildImportRowOutcomes, summarizeImportResult } from "./data-import-result";

describe("buildImportRowOutcomes", () => {
  it("uses explicit row outcomes to distinguish successes and failures", () => {
    expect(buildImportRowOutcomes(3, {
      success: true,
      data: {
        rowResults: [
          { index: 0, status: "success" },
          { index: 1, status: "failed", error: "Invalid phone number" },
          { index: 2, status: "success" },
        ],
      },
    })).toEqual([
      { index: 0, status: "success" },
      { index: 1, status: "failed", error: "Invalid phone number" },
      { index: 2, status: "success" },
    ]);
  });

  it("does not label unimported rows as successful after a validation failure", () => {
    expect(buildImportRowOutcomes(3, {
      success: false,
      row: 3,
      error: "Import failed on row 3: Phone is invalid",
      data: {
        rowResults: [
          { index: 0, status: "failed", error: "Not imported because validation failed on row 3." },
          { index: 1, status: "failed", error: "Import failed on row 3: Phone is invalid" },
          { index: 2, status: "failed", error: "Not imported because validation failed on row 3." },
        ],
      },
    })).toMatchObject([
      { index: 0, status: "failed" },
      { index: 1, status: "failed", error: "Import failed on row 3: Phone is invalid" },
      { index: 2, status: "failed" },
    ]);
  });

  it("does not infer successful rows when the server confirms no imported records", () => {
    expect(buildImportRowOutcomes(1, {
      success: true,
      data: { count: 0 },
    })).toEqual([{
      index: 0,
      status: "failed",
      error: "The server did not confirm that this row was imported.",
    }]);
  });
});

describe("summarizeImportResult", () => {
  it("confirms created standard records", () => {
    expect(summarizeImportResult("Booking", { success: true, data: { count: 3 } })).toEqual({
      kind: "success",
      title: "Data uploaded successfully",
      description: "Successfully uploaded 3 records.",
    });
  });

  it("explains when lead rows matched existing leads instead of creating new leads", () => {
    expect(summarizeImportResult("Lead", { success: true, data: { count: 0, linkedEnquiries: 2 } })).toEqual({
      kind: "success",
      title: "Data uploaded successfully",
      description: "Processed 2 rows: 0 new leads created and 2 rows matched to existing leads.",
    });
  });

  it("reports a completed 50,000-record upload in the success notification", () => {
    expect(summarizeImportResult("Contact", { success: true, data: { count: 50_000 } })).toEqual({
      kind: "success",
      title: "Data uploaded successfully",
      description: "Successfully uploaded 50,000 records.",
    });
  });

  it("reports partial custom-record imports and row failures", () => {
    expect(summarizeImportResult("CustomObject", {
      success: true,
      data: { created: 1, errors: [{ index: 1, error: "Name is required" }] },
    })).toEqual({
      kind: "partial",
      title: "Import partially complete",
      description: "Successfully uploaded 1 record. 1 row failed. First error: Name is required",
    });
  });

  it("never reports success when the server created no records", () => {
    expect(summarizeImportResult("CustomObject", {
      success: true,
      data: { created: 0, errors: [{ index: 0, error: "Name is required" }] },
    })).toEqual({
      kind: "error",
      title: "Import failed",
      description: "No records were imported. Name is required",
    });
  });

  it("uses update language for Lead data updates", () => {
    expect(summarizeImportResult("Lead", {
      success: true,
      data: { count: 2, errors: [] },
    }, "update")).toEqual({
      kind: "success",
      title: "Data updated successfully",
      description: "Updated 2 Leads.",
    });
  });

  it("summarizes ID-keyed Lead upserts as creates and updates", () => {
    expect(summarizeImportResult("Lead", {
      success: true,
      data: { count: 3, created: 1, updated: 2, errors: [] },
    }, "update")).toMatchObject({
      kind: "success",
      description: "Upserted 3 Leads: 1 created and 2 updated.",
    });
  });
});

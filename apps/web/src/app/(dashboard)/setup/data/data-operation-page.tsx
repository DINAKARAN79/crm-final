"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Upload, XCircle } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { dataAdministrationApi, objectDefinitionApi } from "@/lib/api";
import { buildImportRowOutcomes, summarizeImportResult, type ImportFeedback } from "@/lib/data-import-result";
import {
  buildMappedImportRows,
  getCsvColumns,
  parseCsvPreviewAsync,
  serializeCsv,
  suggestCsvFieldMappings,
} from "@/lib/data-import-csv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { filterImportRows, getImportAssignmentLabel, getPageCount, getPageNumbers, IMPORT_PAGE_SIZE, normalizeImportStatus, paginateRows, serializeDownloadCsv } from "@/lib/data-import-pagination";

const MAX_IMPORT_RECORDS = 100_000;
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export default function DataOperationPage({ mode }: { mode: "import" | "update" | "export" }) {
  const { hasEffectivePermission, hasFullAccess, isAdmin, isSuperAdmin } = useAuth();
  const { toast } = useToast();
  const permission = mode === "import" ? "DATA_IMPORT" : mode === "update" ? "DATA_UPDATE" : "DATA_EXPORT";
  const allowed = hasFullAccess || hasEffectivePermission(permission);
  const isUpdateMode = mode === "update";
  const [objects, setObjects] = useState<{ name: string; label: string; isActive?: boolean }[]>([]);
  const [fields, setFields] = useState<{ name: string; label: string; required?: boolean; fieldType?: string }[]>([]);
  const [objectName, setObjectName] = useState("");
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [csv, setCsv] = useState("");
  const [parsedCsv, setParsedCsv] = useState<{ rows: string[][]; error: string }>({ rows: [], error: "" });
  const [hasHeaderRow, setHasHeaderRow] = useState(true);
  const hasHeaderRowRef = useRef(true);
  const parseRequestRef = useRef(0);
  const [columnMappings, setColumnMappings] = useState<Record<number, string>>({});
  const [csvError, setCsvError] = useState("");
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null);
  const [importJobSummary, setImportJobSummary] = useState<{
    id: string;
    status: string;
    totalRows: number;
    createdCount: number;
    linkedCount: number;
    failedCount: number;
  } | null>(null);
  const [bookedBucketImportSummary, setBookedBucketImportSummary] = useState<{
    leadCount: number;
    ownerCount: number;
    warning: boolean;
    warningMessage: string | null;
  } | null>(null);
  const [importRows, setImportRows] = useState<{
    index: number;
    status: "success" | "failed";
    error?: string;
    values: string[];
    sourceRowNumber: number;
    leadNumber?: string;
    projectName?: string;
    leadStatus?: string;
    assignedOwner?: string;
    assignmentGroup?: string;
  }[]>([]);
  const [resultHeaders, setResultHeaders] = useState<string[]>([]);
  const [resultTab, setResultTab] = useState<"success" | "failed">("success");
  const [resultPage, setResultPage] = useState(0);
  const [resultPageInput, setResultPageInput] = useState("1");
  const [resultFilter, setResultFilter] = useState("");
  const [previewPage, setPreviewPage] = useState(0);
  const [previewPageInput, setPreviewPageInput] = useState("1");
  const [previewFilter, setPreviewFilter] = useState("");
  const [parsingCsv, setParsingCsv] = useState(false);
  const [leadImportProfiles, setLeadImportProfiles] = useState<Array<{ status: string; userType: string; profileNames: string[] }>>([]);
  const [bookedBucketProfileStatus, setBookedBucketProfileStatus] = useState<{ isActive: boolean; ownerCount: number } | null>(null);
  const [savingLeadImportProfiles, setSavingLeadImportProfiles] = useState(false);
  const [loading, setLoading] = useState(false);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const csvColumns = useMemo(() => getCsvColumns(parsedCsv.rows, hasHeaderRow), [hasHeaderRow, parsedCsv.rows]);
  const csvDataRows = hasHeaderRow ? parsedCsv.rows.slice(1) : parsedCsv.rows;
  const mappedFields = [...new Set(Object.values(columnMappings).filter(Boolean))];
  const parseCsvInput = (content: string) => {
    const requestId = ++parseRequestRef.current;
    setCsv(content);
    setCsvError("");
    setParsingCsv(true);
    void parseCsvPreviewAsync(content, () => requestId === parseRequestRef.current)
      .then((parsed) => {
        if (!parsed || requestId !== parseRequestRef.current) return;
        setParsedCsv(parsed);
        setPreviewPage(0);
        const rowCount = parsed.rows.length - (hasHeaderRowRef.current ? 1 : 0);
        setCsvError(parsed.error || (rowCount < 1 ? "CSV must contain at least one data row." : rowCount > MAX_IMPORT_RECORDS ? `Imports support up to ${MAX_IMPORT_RECORDS.toLocaleString()} records at a time.` : ""));
      })
      .catch(() => {
        if (requestId === parseRequestRef.current) setCsvError("Could not parse this CSV data. Check its formatting and try again.");
      })
      .finally(() => {
        if (requestId === parseRequestRef.current) setParsingCsv(false);
      });
  };
  const mappedColumnIndex = (field: string) => Object.entries(columnMappings)
    .find(([, mappedField]) => mappedField === field)?.[0];
  const projectColumnIndex = Object.entries(columnMappings)
    .find(([, field]) => ["project", "projectId", "projectName", "allocatedProject", "allocatedProjectId", "sfAllocatedProject", "sfAllocatedProjectC", "projectAssigned"].includes(field))?.[0];
  const statusColumnIndex = mappedColumnIndex("status");
  const ownerColumnIndex = mappedColumnIndex("ownerId");
  const getRoutingPreview = (row: string[]) => {
    const statusValue = statusColumnIndex === undefined ? "" : row[Number(statusColumnIndex)] || "";
    const ownerValue = ownerColumnIndex === undefined ? "" : row[Number(ownerColumnIndex)] || "";
    const projectValue = projectColumnIndex === undefined ? "" : row[Number(projectColumnIndex)] || "";
    const status = normalizeImportStatus(statusValue);
    const routingGroup = getImportAssignmentLabel(status, projectValue, ownerValue);
    const configuredProfiles = leadImportProfiles.find((profile) => profile.status === status)?.profileNames || [];
    return {
      status,
      assignment: configuredProfiles.length && routingGroup.includes("round robin")
        ? `${routingGroup} · ${configuredProfiles.join(", ")}`
        : routingGroup,
    };
  };

  const applyImportRows = (
    result: Parameters<typeof summarizeImportResult>[1],
    sourceRows: string[][],
    sourceHeaders: string[],
    sourceHasHeaderRow: boolean,
  ) => {
    const outcomes = buildImportRowOutcomes(sourceRows.length, result);
    setResultHeaders(sourceHeaders);
    setImportRows(outcomes.map((outcome) => ({
      ...outcome,
      values: sourceRows[outcome.index] || [],
      sourceRowNumber: outcome.index + (sourceHasHeaderRow ? 2 : 1),
    })));
    setResultTab(outcomes.some((outcome) => outcome.status === "failed") ? "failed" : "success");
    setResultPage(0);
    setResultFilter("");
  };

  useEffect(() => {
    objectDefinitionApi.list().then((response) => {
      const available = (response.data.data || []).filter((object: { name: string; label: string; isActive?: boolean }) => object.isActive !== false);
      setObjects(available);
    }).catch((error: any) => {
      toast({ title: "Unable to load objects", description: error?.response?.data?.error || "Try again.", variant: "destructive" as any });
    }).finally(() => setMetadataLoading(false));
  }, [toast]);

  useEffect(() => {
    if (!objectName) {
      setFields([]);
      setSelectedFields([]);
      return;
    }
    objectDefinitionApi.fields(objectName).then((response) => {
      const available = (response.data.data || []).filter((field: { name: string; label: string; required?: boolean; isActive?: boolean; isSystemField?: boolean }) => field.isActive !== false && field.isSystemField !== true);
      if (objectName.trim().toLowerCase() === "lead") {
        if (!available.some((field: { name: string }) => field.name === "status")) {
          available.push({ name: "status", label: "Lead Status", fieldType: "text", required: false });
        }
        if (!available.some((field: { name: string }) => field.name === "ownerId")) {
          available.push({ name: "ownerId", label: "Owner (user ID or email)", fieldType: "text", required: false });
        }
      }
      if (objectName.trim().toLowerCase() === "lead" && !available.some((field: { name: string }) => field.name === "originalSubmissionId")) {
        available.push({
          name: "originalSubmissionId",
          label: "Original Submission ID (Enquiry source-system key)",
          fieldType: "text",
          required: false,
        });
      }
      setFields(available);
      setSelectedFields(available.filter((field: { name: string; label: string; required?: boolean; isActive?: boolean; isSystemField?: boolean }) => field.required).map((field: { name: string }) => field.name));
    }).catch((error: any) => {
      setFields([]);
      setSelectedFields([]);
      toast({ title: "Unable to load fields", description: error?.response?.data?.error || "Try again.", variant: "destructive" as any });
    });
  }, [objectName, toast]);

  useEffect(() => {
    setColumnMappings(suggestCsvFieldMappings(csvColumns, fields));
  }, [csvColumns, fields]);

  useEffect(() => setResultPageInput(String(resultPage + 1)), [resultPage]);
  useEffect(() => setPreviewPageInput(String(previewPage + 1)), [previewPage]);

  useEffect(() => {
    if (mode !== "import" || objectName.trim().toLowerCase() !== "lead" || (!isAdmin && !isSuperAdmin)) {
      setLeadImportProfiles([]);
      setBookedBucketProfileStatus(null);
      return;
    }
    dataAdministrationApi.leadImportProfiles().then((response) => {
      setLeadImportProfiles(response.data.data?.profiles || []);
      setBookedBucketProfileStatus(response.data.data?.bookedBucket || { isActive: false, ownerCount: 0 });
    }).catch((error: any) => {
      toast({ title: "Unable to load assignment profiles", description: error?.response?.data?.error || "Try again.", variant: "destructive" as any });
    });
  }, [isAdmin, isSuperAdmin, mode, objectName, toast]);

  const runImport = async () => {
    if (csvError) {
      toast({ title: "Invalid CSV", description: csvError, variant: "destructive" as any });
      return;
    }
    if (parsedCsv.error) {
      setCsvError(parsedCsv.error);
      toast({ title: "Invalid CSV", description: parsedCsv.error, variant: "destructive" as any });
      return;
    }
    if (!mappedFields.length) {
      const message = "Map at least one CSV column to a CRM field before importing.";
      toast({ title: "Field mapping required", description: message, variant: "destructive" as any });
      return;
    }
    if (!csvDataRows.length) {
      const message = "CSV must contain at least one data row.";
      setCsvError(message);
      toast({ title: "Invalid CSV", description: message, variant: "destructive" as any });
      return;
    }
    if (csvDataRows.length > MAX_IMPORT_RECORDS) {
      const message = `Imports support up to ${MAX_IMPORT_RECORDS.toLocaleString()} records at a time.`;
      setCsvError(message);
      toast({ title: "Import limit exceeded", description: message, variant: "destructive" as any });
      return;
    }
    let mappedRows: string[][];
    try {
      mappedRows = buildMappedImportRows(parsedCsv.rows, hasHeaderRow, columnMappings);
    } catch (mappingError) {
      toast({ title: "Invalid field mapping", description: mappingError instanceof Error ? mappingError.message : "Check your CSV field mappings.", variant: "destructive" as any });
      return;
    }
    const submittedRows = csvDataRows.map((row) => [...row]);
    const submittedHeaders = [...csvColumns];
    const submittedHasHeaderRow = hasHeaderRow;
    try {
      setLoading(true);
      setImportFeedback(null);
      setImportJobSummary(null);
      setBookedBucketImportSummary(null);
      setImportRows([]);
      const response = isUpdateMode
        ? await dataAdministrationApi.update(objectName, { fields: mappedFields, csv: serializeCsv(mappedRows) })
        : await dataAdministrationApi.import(objectName, mappedFields, serializeCsv(mappedRows));
      const outcome = summarizeImportResult(objectName, response.data, isUpdateMode ? "update" : "import");
      setImportFeedback(outcome);
      setImportJobSummary(response.data.data?.job || null);
      setBookedBucketImportSummary(response.data.data?.assignmentSummary?.bookedBucket || null);
      applyImportRows(response.data, submittedRows, submittedHeaders, submittedHasHeaderRow);
      toast({
        title: outcome.title,
        description: outcome.description,
        variant: outcome.kind === "success" ? "success" : outcome.kind === "error" ? "destructive" : "default",
      });
    } catch (error: any) {
      const description = error?.response?.data?.error || error.message || "The import request failed.";
      const responseData = error?.response?.data || { success: false, error: description };
      setImportJobSummary(responseData.data?.job || null);
      setBookedBucketImportSummary(responseData.data?.assignmentSummary?.bookedBucket || null);
      const outcome: ImportFeedback = { kind: "error", title: "Import failed", description };
      setImportFeedback(outcome);
      applyImportRows(responseData, submittedRows, submittedHeaders, submittedHasHeaderRow);
      toast({ title: outcome.title, description: outcome.description, variant: "destructive" as any });
    } finally {
      setLoading(false);
    }
  };

  const requiredFields = fields.filter((field) => field.required);
  const activeSelectedFields = mappedFields;
  const missingRequiredFields = requiredFields.filter((field) => !activeSelectedFields.includes(field.name));
  if (isUpdateMode && objectName.trim().toLowerCase() === "lead") {
    for (const [name, label] of [
      ["originalSubmissionId", "Original Submission ID (Enquiry source-system key)"],
      ["source", "Lead Source"],
    ]) {
      if (!activeSelectedFields.includes(name)) {
        missingRequiredFields.push({ name, label, required: true });
      }
    }
  }
  const missingRequiredLabels = missingRequiredFields.map((field) => `${field.label} (${field.name})`);

  const runExport = async () => {
    try {
      setLoading(true);
      const response = await dataAdministrationApi.export(objectName, { fields: selectedFields.join(",") });
      const blob = new Blob([response.data], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${objectName || "crm-data"}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast({ title: "Export complete", description: "The data file is ready." });
    } catch (error: any) {
      toast({ title: "Export failed", description: error?.response?.data?.error || error.message, variant: "destructive" as any });
    } finally {
      setLoading(false);
    }
  };

  const saveLeadImportProfiles = async () => {
    try {
      setSavingLeadImportProfiles(true);
      const editable = leadImportProfiles
        .filter((profile) => profile.userType !== "ADMIN_FALLBACK" && profile.userType !== "BOOKED_BUCKET")
        .map((profile) => ({ status: profile.status, profileNames: profile.profileNames }));
      await dataAdministrationApi.saveLeadImportProfiles(editable);
      toast({ title: "Assignment profiles saved", description: "Lead import status profiles were updated for this tenant." });
    } catch (error: any) {
      toast({ title: "Unable to save assignment profiles", description: error?.response?.data?.error || "Try again.", variant: "destructive" as any });
    } finally {
      setSavingLeadImportProfiles(false);
    }
  };

  if (!allowed) {
    return <div className="rounded-lg border p-6"><h2 className="font-medium">Access required</h2><p className="mt-2 text-sm text-muted-foreground">Ask an administrator to assign the {permission} permission through a Permission Set.</p></div>;
  }

  if (mode === "import" || mode === "update") {
    const previewHeaders = csvColumns;
    const previewRows = csvDataRows;
    const mappedHeaders = mappedFields.length;
    const visibleResultRows = filterImportRows(
      importRows.filter((row) => row.status === resultTab),
      resultFilter,
      (row) => [row.sourceRowNumber, row.leadNumber, row.projectName, row.leadStatus, row.assignedOwner, row.assignmentGroup, row.error, ...row.values],
    );
    const resultPageCount = getPageCount(visibleResultRows.length);
    const pagedResultRows = paginateRows(visibleResultRows, resultPage);
    const filteredPreviewRows = filterImportRows(
      csvDataRows.map((row, index) => ({ row, index })),
      previewFilter,
      (item) => [...item.row, ...Object.values(getRoutingPreview(item.row))],
    );
    const previewPageCount = getPageCount(filteredPreviewRows.length);
    const pagedPreviewRows = paginateRows(filteredPreviewRows, previewPage);
    const importDisabled = loading || parsingCsv || metadataLoading || !objectName || !csv || !mappedFields.length || missingRequiredFields.length > 0 || Boolean(csvError);

    return <div className="-mx-4 -mt-4 min-h-[calc(100vh-3.5rem)] bg-[#eaf6ff] text-slate-800">
      <div className="flex min-h-12 items-center justify-between bg-[#07356c] px-5 py-2 text-white">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 place-items-center rounded bg-white/15"><FileSpreadsheet className="h-4 w-4" /></span>
          <div className="text-sm font-semibold tracking-wide">{isUpdateMode ? "Data Update" : "Data Import"}</div>
        </div>
        {bookedBucketProfileStatus && (
          <p className={`mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
            !bookedBucketProfileStatus.isActive || bookedBucketProfileStatus.ownerCount === 0
              ? "bg-amber-50 text-amber-900"
              : "bg-emerald-50 text-emerald-800"
          }`}>
            {(!bookedBucketProfileStatus.isActive || bookedBucketProfileStatus.ownerCount === 0) && <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>
              Booked Bucket · {bookedBucketProfileStatus.ownerCount} active owner{bookedBucketProfileStatus.ownerCount === 1 ? "" : "s"}
              {!bookedBucketProfileStatus.isActive
                ? " · Inactive; imported Booked leads will not move until activated."
                : bookedBucketProfileStatus.ownerCount === 0
                  ? " · Admin fallback will be used."
                  : ""}
            </span>
          </p>
        )}
        <span className="hidden text-xs text-blue-100 sm:block">{isUpdateMode ? "Review and apply bulk updates to existing CRM records" : "Import CSV records into your CRM"}</span>
      </div>

      <div className="space-y-3 p-3 sm:p-4">
        {isUpdateMode && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Lead updates require an explicitly mapped Enquiry Original Submission ID and configured Lead Source. Blank cells preserve existing values; contact details are never used as match keys.
        </div>}
        {importFeedback && <div role="status" aria-live="polite" className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
          importFeedback.kind === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900"
            : importFeedback.kind === "partial" ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-rose-200 bg-rose-50 text-rose-900"
        }`}>
          {importFeedback.kind === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            : importFeedback.kind === "partial" ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <div className="min-w-0">
            <p className="font-semibold">{importFeedback.title}</p>
            <p className="mt-0.5 text-xs">{importFeedback.description}</p>
            {importJobSummary && <p className="mt-1 text-[11px]">Job {importJobSummary.id} · {importJobSummary.status} · {importJobSummary.createdCount} created · {importJobSummary.failedCount} failed</p>}
            {bookedBucketImportSummary && bookedBucketImportSummary.leadCount > 0 && (
              <p className={`mt-1 flex items-start gap-1 text-[11px] ${bookedBucketImportSummary.warning ? "font-medium text-amber-800" : ""}`}>
                {bookedBucketImportSummary.warning && <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                <span>
                  Booked Bucket · {bookedBucketImportSummary.leadCount} imported lead{bookedBucketImportSummary.leadCount === 1 ? "" : "s"} · {bookedBucketImportSummary.ownerCount} active owner{bookedBucketImportSummary.ownerCount === 1 ? "" : "s"}
                  {bookedBucketImportSummary.warningMessage ? ` · ${bookedBucketImportSummary.warningMessage}` : ""}
                </span>
              </p>
            )}
          </div>
        </div>}
        {importFeedback && <section aria-label="Import row results" className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-700">Import Results</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">Review each imported row and the reason any row failed. Showing up to {IMPORT_PAGE_SIZE} rows per page.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input aria-label="Filter import results" value={resultFilter} onChange={(event) => { setResultFilter(event.target.value); setResultPage(0); }} placeholder="Filter rows" className="h-8 max-w-xs text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={() => {
                const rows = [
                  ["CSV row", ...resultHeaders, "Lead #", "Project", "Saved status", "Assigned owner", "Assignment group", "Outcome", "Failure reason"],
                  ...visibleResultRows.map((row) => [
                    String(row.sourceRowNumber),
                    ...resultHeaders.map((_, index) => row.values[index] || ""),
                    row.leadNumber || "",
                    row.projectName || "",
                    row.leadStatus || getRoutingPreview(row.values).status,
                    row.assignedOwner || "",
                    row.assignmentGroup || getRoutingPreview(row.values).assignment,
                    row.status,
                    row.error || "",
                  ]),
                ];
                const blob = new Blob([serializeDownloadCsv(rows)], { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `${objectName || "import"}-${resultTab}-results.csv`;
                link.click();
                URL.revokeObjectURL(url);
              }}><Download className="mr-1 h-3.5 w-3.5" />Download {resultTab} CSV</Button>
            </div>
            <div role="tablist" aria-label="Import result status" className="mt-3 flex gap-2">
              {(["success", "failed"] as const).map((status) => {
                const count = importRows.filter((row) => row.status === status).length;
                return <button
                  key={status}
                  type="button"
                  role="tab"
                  aria-selected={resultTab === status}
                  onClick={() => { setResultTab(status); setResultPage(0); setResultFilter(""); }}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                    resultTab === status
                      ? status === "success" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >{status === "success" ? "Successful" : "Failed"} ({count})</button>;
              })}
            </div>
          </div>
          {pagedResultRows.length > 0 ? <div className="max-h-[55vh] overscroll-contain overflow-auto">
            <table className="w-full min-w-max border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-600"><tr>
                <th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">CSV row</th>
                {resultHeaders.map((header, index) => <th key={`${header}-${index}`} className="border-b border-r border-slate-200 px-3 py-2 font-semibold">{header || `Column ${index + 1}`}</th>)}
                <th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">CRM Lead #</th>
                <th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">Project</th>
                <th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">Saved status</th>
                <th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">Assigned owner</th>
                <th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">Assignment group</th>
                <th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">Status</th>
                {resultTab === "failed" && <th className="border-b border-slate-200 px-3 py-2 font-semibold">Failure reason</th>}
              </tr></thead>
              <tbody>{pagedResultRows.map((row) => <tr key={row.index} className="even:bg-slate-50/70">
                <td className="border-b border-r border-slate-100 px-3 py-2 text-slate-600">{row.sourceRowNumber}</td>
                {resultHeaders.map((header, columnIndex) => <td key={`${header}-${columnIndex}`} className="max-w-64 truncate border-b border-r border-slate-100 px-3 py-2 text-slate-600">{row.values[columnIndex] || <span className="text-slate-300">—</span>}</td>)}
                <td className="border-b border-r border-slate-100 px-3 py-2 text-slate-600">{row.leadNumber || "—"}</td>
                <td className="border-b border-r border-slate-100 px-3 py-2 text-slate-600">{row.projectName || "—"}</td>
                <td className="border-b border-r border-slate-100 px-3 py-2 text-slate-600">{row.leadStatus || getRoutingPreview(row.values).status}</td>
                <td className="border-b border-r border-slate-100 px-3 py-2 text-slate-600">{row.assignedOwner || "—"}</td>
                <td className="border-b border-r border-slate-100 px-3 py-2 text-slate-600">{row.assignmentGroup || getRoutingPreview(row.values).assignment}</td>
                <td className="border-b border-r border-slate-100 px-3 py-2">
                  <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${row.status === "success" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                    {row.status === "success" ? "Successful" : "Failed"}
                  </span>
                </td>
                {resultTab === "failed" && <td className="max-w-96 whitespace-normal border-b border-slate-100 px-3 py-2 text-rose-700">{row.error || "The row could not be imported."}</td>}
              </tr>)}</tbody>
            </table>
          </div> : <p className="px-4 py-8 text-center text-xs text-slate-500">{resultTab === "success" ? "No rows were imported successfully." : "No rows failed."}</p>}
          {visibleResultRows.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
            <span>Showing {resultPage * IMPORT_PAGE_SIZE + 1}–{Math.min((resultPage + 1) * IMPORT_PAGE_SIZE, visibleResultRows.length)} of {visibleResultRows.length} rows</span>
            <div className="flex flex-wrap items-center gap-1">
              <button type="button" disabled={resultPage === 0} onClick={() => setResultPage(0)} className="rounded border px-2 py-1 disabled:opacity-40">First</button>
              <button type="button" disabled={resultPage === 0} onClick={() => setResultPage((page) => page - 1)} className="rounded border px-2 py-1 disabled:opacity-40">Previous</button>
              {getPageNumbers(resultPage, resultPageCount).map((page) => <button key={page} type="button" aria-current={page === resultPage ? "page" : undefined} onClick={() => setResultPage(page)} className={`rounded border px-2 py-1 ${page === resultPage ? "border-blue-600 bg-blue-50 text-blue-700" : ""}`}>{page + 1}</button>)}
              <label className="flex items-center gap-1">Page <input aria-label="Go to results page" type="number" min={1} max={resultPageCount} value={resultPageInput} onChange={(event) => setResultPageInput(event.target.value)} onBlur={() => {
                const next = Number(resultPageInput);
                setResultPage(next >= 1 && next <= resultPageCount ? next - 1 : resultPage);
              }} onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }} className="h-7 w-14 rounded border px-1 text-center" /> of {resultPageCount}</label>
              <button type="button" disabled={resultPage + 1 >= resultPageCount} onClick={() => setResultPage((page) => page + 1)} className="rounded border px-2 py-1 disabled:opacity-40">Next</button>
              <button type="button" disabled={resultPage + 1 >= resultPageCount} onClick={() => setResultPage(resultPageCount - 1)} className="rounded border px-2 py-1 disabled:opacity-40">Last</button>
            </div>
          </div>}
        </section>}
        <div className="grid gap-3 xl:grid-cols-2">
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-slate-700">{isUpdateMode ? "Configure Update" : "Configure Import"}</h2>
              <p className="mt-1 text-xs text-slate-500">{isUpdateMode ? "Choose the CRM object and upload a CSV that updates existing records." : "Choose the CRM object and provide your CSV data."}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="data-object" className="text-xs font-medium text-slate-600">Object</label>
                <select id="data-object" value={objectName} onChange={(event) => setObjectName(event.target.value)} disabled={metadataLoading} className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100">
                  <option value="">{metadataLoading ? "Loading objects..." : "Select an object"}</option>
                  {objects.map((object) => <option key={object.name} value={object.name}>{object.label} ({object.name})</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="data-csv" className="text-xs font-medium text-slate-600">CSV file</label>
                <Input id="data-csv" type="file" accept=".csv,text/csv" className="h-10 rounded-lg border-slate-300 bg-white text-xs file:mr-2 file:rounded-md file:border-0 file:bg-blue-50 file:px-2 file:py-1 file:text-xs file:font-medium file:text-blue-700" onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > MAX_IMPORT_BYTES) {
                    setCsvError("CSV files are limited to 25 MB.");
                    return;
                  }
                  file.text().then(parseCsvInput).catch(() => setCsvError("Could not read this CSV file. Please choose another file."));
                }} />
              </div>
            </div>
            <div className="mt-4 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label htmlFor="data-csv-paste" className="text-xs font-medium text-slate-600">Paste CSV data</label>
              <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={hasHeaderRow} onChange={(event) => {
                const includesHeaders = event.target.checked;
                setHasHeaderRow(includesHeaders);
                hasHeaderRowRef.current = includesHeaders;
                setPreviewPage(0);
                const rowCount = parsedCsv.rows.length - (includesHeaders ? 1 : 0);
                setCsvError(parsedCsv.error || (csv && rowCount < 1 ? "CSV must contain at least one data row." : rowCount > MAX_IMPORT_RECORDS ? `Imports support up to ${MAX_IMPORT_RECORDS.toLocaleString()} records at a time.` : ""));
              }} className="h-4 w-4 rounded border-slate-300 accent-blue-600" />
              First row contains column headers
            </label>
            </div>
              <textarea id="data-csv-paste" value={csv} onChange={(event) => {
                const value = event.target.value;
                if (new Blob([value]).size > MAX_IMPORT_BYTES) {
                  parseRequestRef.current += 1;
                  setParsingCsv(false);
                  setCsvError("CSV content is limited to 25 MB.");
                  return;
                }
                parseCsvInput(value);
              }} placeholder={"Paste CSV with field API names in the first row\nfirstName,lastName,phone"} className="min-h-24 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs leading-5 placeholder:font-sans placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100" />
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                <span>{parsingCsv ? "Parsing CSV without blocking the page..." : csv ? `${csvDataRows.length} data row${csvDataRows.length === 1 ? "" : "s"} detected` : "Map your CSV columns to CRM API fields below."}</span>
                {csv && <button type="button" onClick={() => { parseRequestRef.current += 1; setParsingCsv(false); setCsv(""); setParsedCsv({ rows: [], error: "" }); setCsvError(""); setPreviewPage(0); }} className="font-medium text-blue-700 hover:underline">Clear data</button>}
              </div>
              {csvError && <p role="alert" className="text-xs text-rose-700">{csvError}</p>}
            </div>
          </section>
          {mode === "import" && objectName.trim().toLowerCase() === "lead" && (isAdmin || isSuperAdmin) && <section className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-700">Lead status assignment profiles</h2>
                <p className="mt-1 text-xs text-slate-500">Profile names are matched case-insensitively against eligible project queue members. Booked leads use the Booked Bucket when active; Lost leads use the administrator fallback.</p>
              </div>
              <Button type="button" variant="outline" size="sm" disabled={savingLeadImportProfiles || leadImportProfiles.length === 0} onClick={saveLeadImportProfiles}>
                {savingLeadImportProfiles ? "Saving..." : "Save profiles"}
              </Button>
            </div>
            {leadImportProfiles.length === 0 ? <p className="text-xs text-slate-500">Loading tenant assignment profiles...</p> : <div className="grid gap-2 sm:grid-cols-2">
              {leadImportProfiles.map((profile) => <label key={profile.status} className="space-y-1 rounded-lg border border-slate-200 p-3">
                <span className="flex items-center justify-between gap-2 text-xs font-medium text-slate-700"><span>{profile.status.replace(/_/g, " ")}</span><span className="text-[10px] text-slate-500">{profile.userType === "ADMIN_FALLBACK" ? "Admin fallback" : profile.userType}</span></span>
                {profile.userType === "BOOKED_BUCKET"
                  ? <p className="text-xs text-slate-500">Assigned through Booked Bucket settings.</p>
                  : profile.userType === "ADMIN_FALLBACK"
                  ? <p className="text-xs text-slate-500">System Administrator</p>
                  : <Input aria-label={`${profile.status} eligible profiles`} value={profile.profileNames.join(", ")} onChange={(event) => {
                    const profileNames = event.target.value.split(",").map((name) => name.trim()).filter(Boolean);
                    setLeadImportProfiles((current) => current.map((item) => item.status === profile.status ? { ...item, profileNames } : item));
                  }} placeholder="Profile names, comma-separated" className="h-8 text-xs" />}
              </label>)}
            </div>}
          </section>}

          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-700">Field Mapping</h2>
                <p className="mt-1 text-xs text-slate-500">{objectName ? "Map each CSV column to the CRM API field that should receive its data." : "Select an object to view its available fields."}</p>
              </div>
              {objectName && <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">{mappedHeaders} mapped</span>}
            </div>
            {!objectName ? <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 text-center text-xs text-slate-500">Choose an object to load its fields.</div>
              : fields.length === 0 ? <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 text-center text-xs text-slate-500">{metadataLoading ? "Loading fields..." : "No importable fields are available."}</div>
                : csvColumns.length === 0
                  ? <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 text-center text-xs text-slate-500">Upload or paste CSV data to map its columns to CRM fields.</div>
                  : <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                    {csvColumns.map((column, index) => {
                      const mappedField = columnMappings[index] || "";
                      const sample = csvDataRows[0]?.[index];
                      return <div key={`${index}-${column}`} className="grid gap-2 rounded-lg border border-slate-200 bg-white p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] sm:items-center">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-slate-700">{column}</p>
                          <p className="truncate text-[10px] text-slate-500">{hasHeaderRow ? `CSV header${sample ? ` · example: ${sample}` : ""}` : `Column ${index + 1}${sample ? ` · example: ${sample}` : ""}`}</p>
                        </div>
                        <select aria-label={`Map ${column} to CRM field`} value={mappedField} onChange={(event) => setColumnMappings((current) => ({ ...current, [index]: event.target.value }))} className="h-9 min-w-0 rounded-md border border-slate-300 bg-white px-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100">
                          <option value="">Do not import this column</option>
                          {fields.map((field) => {
                            const usedElsewhere = Object.entries(columnMappings).some(([mappedIndex, name]) => Number(mappedIndex) !== index && name === field.name);
                            return <option key={field.name} value={field.name} disabled={usedElsewhere}>{field.label} ({field.name}) · {field.required ? "Required" : "Optional"}</option>;
                          })}
                        </select>
                      </div>;
                    })}
                </div>}
            {missingRequiredFields.length > 0 && <p role="alert" className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Map these required CRM fields to a CSV column to continue: <strong>{missingRequiredLabels.join(", ")}</strong>.
            </p>}
          </section>
        </div>

        <section className="flex flex-col gap-4 rounded-2xl bg-white p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={runImport} disabled={importDisabled} className="h-9 rounded-full bg-blue-600 px-5 text-xs hover:bg-blue-700">
              <Upload className="h-4 w-4" />{loading ? (isUpdateMode ? "Updating..." : "Importing...") : (isUpdateMode ? "Run Update" : "Run Import")}
            </Button>
            <span className="text-[11px] text-slate-500">Up to {MAX_IMPORT_RECORDS.toLocaleString()} records per import</span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center sm:min-w-[300px]">
            <div className="rounded-lg bg-blue-50 px-3 py-2"><div className="text-base font-semibold text-blue-800">{csvDataRows.length}</div><div className="text-[10px] text-slate-500">Rows ready</div></div>
            <div className="rounded-lg bg-emerald-50 px-3 py-2"><div className="text-base font-semibold text-emerald-800">{mappedHeaders}</div><div className="text-[10px] text-slate-500">Fields in CSV</div></div>
            <div className="rounded-lg bg-amber-50 px-3 py-2"><div className="text-base font-semibold text-amber-800">{requiredFields.length}</div><div className="text-[10px] text-slate-500">Required fields</div></div>
          </div>
        </section>

        <section className="min-h-36 overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-700">Data Preview</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">{previewRows.length ? `Showing ${Math.min(previewPage * IMPORT_PAGE_SIZE + 1, filteredPreviewRows.length)}–${Math.min((previewPage + 1) * IMPORT_PAGE_SIZE, filteredPreviewRows.length)} of ${filteredPreviewRows.length.toLocaleString()} matching records (${csvDataRows.length.toLocaleString()} total)` : "Your CSV preview will appear here."}</p>
            </div>
            {csv && <div className="flex items-center gap-2"><Input aria-label="Filter preview rows" value={previewFilter} onChange={(event) => { setPreviewFilter(event.target.value); setPreviewPage(0); }} placeholder="Filter rows" className="h-8 max-w-48 text-xs" /><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-600">{previewHeaders.length} columns</span></div>}
          </div>
          {previewRows.length > 0 ? <div aria-label="CSV data preview rows" className="max-h-[55vh] overscroll-contain overflow-auto">
            <table className="w-full min-w-max border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-600"><tr><th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">CSV row</th>{previewHeaders.map((header, index) => <th key={`${header}-${index}`} className="border-b border-r border-slate-200 px-3 py-2 font-semibold last:border-r-0">{header || `Column ${index + 1}`}</th>)}<th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">Lead status</th><th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">Assignment plan</th></tr></thead>
              <tbody>{pagedPreviewRows.map(({ row, index }) => <tr key={index} className="even:bg-slate-50/70"><td className="border-b border-r border-slate-100 px-3 py-2 text-slate-600">{index + (hasHeaderRow ? 2 : 1)}</td>{previewHeaders.map((header, columnIndex) => <td key={`${header}-${columnIndex}`} className="max-w-64 truncate border-b border-r border-slate-100 px-3 py-2 text-slate-600 last:border-r-0">{row[columnIndex] || <span className="text-slate-300">—</span>}</td>)}<td className="border-b border-r border-slate-100 px-3 py-2 text-slate-600">{getRoutingPreview(row).status}</td><td className="border-b border-r border-slate-100 px-3 py-2 text-slate-600">{getRoutingPreview(row).assignment}</td></tr>)}</tbody>
            </table>
          </div> : <div className="grid min-h-24 place-items-center px-4 text-center text-xs text-slate-400">Choose a CSV file or paste CSV data to preview records.</div>}
          {csv && filteredPreviewRows.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
            <span>Preview page {previewPage + 1} of {previewPageCount}</span>
            <div className="flex flex-wrap items-center gap-1">
              <button type="button" disabled={previewPage === 0} onClick={() => setPreviewPage(0)} className="rounded border px-2 py-1 disabled:opacity-40">First</button>
              <button type="button" disabled={previewPage === 0} onClick={() => setPreviewPage((page) => page - 1)} className="rounded border px-2 py-1 disabled:opacity-40">Previous</button>
              {getPageNumbers(previewPage, previewPageCount).map((page) => <button key={page} type="button" aria-current={page === previewPage ? "page" : undefined} onClick={() => setPreviewPage(page)} className={`rounded border px-2 py-1 ${page === previewPage ? "border-blue-600 bg-blue-50 text-blue-700" : ""}`}>{page + 1}</button>)}
              <label className="flex items-center gap-1">Page <input aria-label="Go to preview page" type="number" min={1} max={previewPageCount} value={previewPageInput} onChange={(event) => setPreviewPageInput(event.target.value)} onBlur={() => {
                const next = Number(previewPageInput);
                setPreviewPage(next >= 1 && next <= previewPageCount ? next - 1 : previewPage);
              }} onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }} className="h-7 w-14 rounded border px-1 text-center" /> of {previewPageCount}</label>
              <button type="button" disabled={previewPage + 1 >= previewPageCount} onClick={() => setPreviewPage((page) => page + 1)} className="rounded border px-2 py-1 disabled:opacity-40">Next</button>
              <button type="button" disabled={previewPage + 1 >= previewPageCount} onClick={() => setPreviewPage(previewPageCount - 1)} className="rounded border px-2 py-1 disabled:opacity-40">Last</button>
            </div>
          </div>}
        </section>
      </div>
    </div>;
  }

  return <div className="max-w-2xl space-y-5 rounded-lg border bg-card p-6">
    <div><h2 className="font-medium">Export data</h2><p className="mt-1 text-sm text-muted-foreground">Select an object and fields to download as CSV.</p></div>
    <div className="space-y-2"><label htmlFor="data-object" className="text-sm font-medium">Object</label><select id="data-object" value={objectName} onChange={(event) => setObjectName(event.target.value)} disabled={metadataLoading} className="h-9 w-full rounded-md border bg-background px-3 text-sm"><option value="">Select an object</option>{objects.map((object) => <option key={object.name} value={object.name}>{object.label} ({object.name})</option>)}</select></div>
    <fieldset className="space-y-3"><legend className="text-sm font-medium">Fields</legend>{!objectName ? <p className="text-sm text-muted-foreground">Select an object first.</p> : fields.length === 0 ? <p className="text-sm text-muted-foreground">No fields available.</p> : <><div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Required fields</p><div className="grid gap-2 sm:grid-cols-2">{fields.filter((field) => field.required).map((field) => <label key={field.name} className="flex items-center gap-2 text-sm"><input type="checkbox" checked disabled />{field.label} <span className="text-muted-foreground">({field.name})</span><span className="text-xs font-medium text-amber-700">Required</span></label>)}</div>{requiredFields.length === 0 && <p className="text-sm text-muted-foreground">No required fields configured.</p>}</div><div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Optional fields</p><div className="grid gap-2 sm:grid-cols-2">{fields.filter((field) => !field.required).map((field) => <label key={field.name} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedFields.includes(field.name)} onChange={(event) => setSelectedFields((current) => event.target.checked ? [...current, field.name] : current.filter((name) => name !== field.name))} />{field.label} <span className="text-muted-foreground">({field.name})</span></label>)}</div></div></>}</fieldset>
    <Button onClick={runExport} disabled={loading || !objectName || selectedFields.length === 0 || missingRequiredFields.length > 0}><Download className="mr-2 h-4 w-4" />{loading ? "Processing..." : "Export CSV"}</Button>
  </div>;
}
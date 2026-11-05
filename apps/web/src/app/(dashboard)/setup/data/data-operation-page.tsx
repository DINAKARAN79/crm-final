"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Upload, XCircle } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { dataAdministrationApi, objectDefinitionApi } from "@/lib/api";
import { buildImportRowOutcomes, summarizeImportResult, type ImportFeedback } from "@/lib/data-import-result";
import {
  buildMappedImportRows,
  getCsvColumns,
  parseCsvPreview,
  serializeCsv,
  suggestCsvFieldMappings,
} from "@/lib/data-import-csv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

const MAX_IMPORT_RECORDS = 100_000;
const PREVIEW_ROW_LIMIT = 100;

export default function DataOperationPage({ mode }: { mode: "import" | "update" | "export" }) {
  const { hasEffectivePermission, hasFullAccess } = useAuth();
  const { toast } = useToast();
  const permission = mode === "import" ? "DATA_IMPORT" : mode === "update" ? "DATA_UPDATE" : "DATA_EXPORT";
  const allowed = hasFullAccess || hasEffectivePermission(permission);
  const isUpdateMode = mode === "update";
  const [objects, setObjects] = useState<{ name: string; label: string; isActive?: boolean }[]>([]);
  const [fields, setFields] = useState<{ name: string; label: string; required?: boolean }[]>([]);
  const [objectName, setObjectName] = useState("");
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [csv, setCsv] = useState("");
  const [parsedCsv, setParsedCsv] = useState<{ rows: string[][]; error: string }>({ rows: [], error: "" });
  const [hasHeaderRow, setHasHeaderRow] = useState(true);
  const [columnMappings, setColumnMappings] = useState<Record<number, string>>({});
  const [csvError, setCsvError] = useState("");
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null);
  const [importRows, setImportRows] = useState<{ index: number; status: "success" | "failed"; error?: string; values: string[]; sourceRowNumber: number }[]>([]);
  const [resultHeaders, setResultHeaders] = useState<string[]>([]);
  const [resultTab, setResultTab] = useState<"success" | "failed">("success");
  const [resultPage, setResultPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const csvColumns = useMemo(() => getCsvColumns(parsedCsv.rows, hasHeaderRow), [hasHeaderRow, parsedCsv.rows]);
  const csvDataRows = hasHeaderRow ? parsedCsv.rows.slice(1) : parsedCsv.rows;
  const mappedFields = [...new Set(Object.values(columnMappings).filter(Boolean))];

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
      setImportRows([]);
      const response = isUpdateMode
        ? await dataAdministrationApi.update(objectName, { fields: mappedFields, csv: serializeCsv(mappedRows) })
        : await dataAdministrationApi.import(objectName, mappedFields, serializeCsv(mappedRows));
      const outcome = summarizeImportResult(objectName, response.data);
      setImportFeedback(outcome);
      applyImportRows(response.data, submittedRows, submittedHeaders, submittedHasHeaderRow);
      toast({
        title: outcome.title,
        description: outcome.description,
        variant: outcome.kind === "success" ? "success" : outcome.kind === "error" ? "destructive" : "default",
      });
    } catch (error: any) {
      const description = error?.response?.data?.error || error.message || "The import request failed.";
      const responseData = error?.response?.data || { success: false, error: description };
      const outcome: ImportFeedback = { kind: "error", title: "Import failed", description };
      setImportFeedback(outcome);
      applyImportRows(responseData, submittedRows, submittedHeaders, submittedHasHeaderRow);
      toast({ title: outcome.title, description: outcome.description, variant: "destructive" as any });
    } finally {
      setLoading(false);
    }
  };

  const requiredFields = fields.filter((field) => field.required);
  const activeSelectedFields = mode === "import" ? mappedFields : selectedFields;
  const missingRequiredFields = requiredFields.filter((field) => !activeSelectedFields.includes(field.name));
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

  if (!allowed) {
    return <div className="rounded-lg border p-6"><h2 className="font-medium">Access required</h2><p className="mt-2 text-sm text-muted-foreground">Ask an administrator to assign the {permission} permission through a Permission Set.</p></div>;
  }

  if (mode === "import" || mode === "update") {
    const previewHeaders = csvColumns;
    const previewRows = csvDataRows;
    const mappedHeaders = mappedFields.length;
    const visibleResultRows = importRows.filter((row) => row.status === resultTab);
    const resultPageCount = Math.ceil(visibleResultRows.length / PREVIEW_ROW_LIMIT);
    const pagedResultRows = visibleResultRows.slice(resultPage * PREVIEW_ROW_LIMIT, (resultPage + 1) * PREVIEW_ROW_LIMIT);
    const importDisabled = loading || metadataLoading || !objectName || !csv || !mappedFields.length || missingRequiredFields.length > 0 || Boolean(csvError);

    return <div className="-mx-4 -mt-4 min-h-[calc(100vh-3.5rem)] bg-[#eaf6ff] text-slate-800">
      <div className="flex min-h-12 items-center justify-between bg-[#07356c] px-5 py-2 text-white">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 place-items-center rounded bg-white/15"><FileSpreadsheet className="h-4 w-4" /></span>
          <div className="text-sm font-semibold tracking-wide">{isUpdateMode ? "Data Update" : "Data Import"}</div>
        </div>
        <span className="hidden text-xs text-blue-100 sm:block">{isUpdateMode ? "Review and apply bulk updates to existing CRM records" : "Import CSV records into your CRM"}</span>
      </div>

      <div className="space-y-3 p-3 sm:p-4">
        {isUpdateMode && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Bulk updates are preview-first and must match the same validation rules as the normal create/update APIs. Lead status is excluded from this tool.
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
          </div>
        </div>}
        {importFeedback && <section aria-label="Import row results" className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-700">Import Results</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">Review each imported row and the reason any row failed.</p>
            <div role="tablist" aria-label="Import result status" className="mt-3 flex gap-2">
              {(["success", "failed"] as const).map((status) => {
                const count = importRows.filter((row) => row.status === status).length;
                return <button
                  key={status}
                  type="button"
                  role="tab"
                  aria-selected={resultTab === status}
                  onClick={() => { setResultTab(status); setResultPage(0); }}
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
                <th className="border-b border-r border-slate-200 px-3 py-2 font-semibold">Status</th>
                {resultTab === "failed" && <th className="border-b border-slate-200 px-3 py-2 font-semibold">Failure reason</th>}
              </tr></thead>
              <tbody>{pagedResultRows.map((row) => <tr key={row.index} className="even:bg-slate-50/70">
                <td className="border-b border-r border-slate-100 px-3 py-2 text-slate-600">{row.sourceRowNumber}</td>
                {resultHeaders.map((header, columnIndex) => <td key={`${header}-${columnIndex}`} className="max-w-64 truncate border-b border-r border-slate-100 px-3 py-2 text-slate-600">{row.values[columnIndex] || <span className="text-slate-300">—</span>}</td>)}
                <td className="border-b border-r border-slate-100 px-3 py-2">
                  <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${row.status === "success" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                    {row.status === "success" ? "Successful" : "Failed"}
                  </span>
                </td>
                {resultTab === "failed" && <td className="max-w-96 whitespace-normal border-b border-slate-100 px-3 py-2 text-rose-700">{row.error || "The row could not be imported."}</td>}
              </tr>)}</tbody>
            </table>
          </div> : <p className="px-4 py-8 text-center text-xs text-slate-500">{resultTab === "success" ? "No rows were imported successfully." : "No rows failed."}</p>}
          {resultPageCount > 1 && <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
            <span>Showing {resultPage * PREVIEW_ROW_LIMIT + 1}–{Math.min((resultPage + 1) * PREVIEW_ROW_LIMIT, visibleResultRows.length)} of {visibleResultRows.length} rows</span>
            <div className="flex gap-2">
              <button type="button" disabled={resultPage === 0} onClick={() => setResultPage((page) => page - 1)} className="rounded border px-2 py-1 disabled:opacity-40">Previous</button>
              <button type="button" disabled={resultPage + 1 >= resultPageCount} onClick={() => setResultPage((page) => page + 1)} className="rounded border px-2 py-1 disabled:opacity-40">Next</button>
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
                  file.text().then((content) => {
                    const parsed = parseCsvPreview(content);
                    setCsv(content);
                    setParsedCsv(parsed);
                    const rowCount = parsed.rows.length - (hasHeaderRow ? 1 : 0);
                    setCsvError(parsed.error || (rowCount < 1 ? "CSV must contain at least one data row." : rowCount > MAX_IMPORT_RECORDS ? `Imports support up to ${MAX_IMPORT_RECORDS.toLocaleString()} records at a time.` : ""));
                  }).catch(() => setCsvError("Could not read this CSV file. Please choose another file."));
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
                const rowCount = parsedCsv.rows.length - (includesHeaders ? 1 : 0);
                setCsvError(parsedCsv.error || (csv && rowCount < 1 ? "CSV must contain at least one data row." : rowCount > MAX_IMPORT_RECORDS ? `Imports support up to ${MAX_IMPORT_RECORDS.toLocaleString()} records at a time.` : ""));
              }} className="h-4 w-4 rounded border-slate-300 accent-blue-600" />
              First row contains column headers
            </label>
            </div>
              <textarea id="data-csv-paste" value={csv} onChange={(event) => {
                const value = event.target.value;
                const parsed = parseCsvPreview(value);
                setCsv(value);
                setParsedCsv(parsed);
                const rowCount = parsed.rows.length - (hasHeaderRow ? 1 : 0);
                setCsvError(parsed.error || (value && rowCount < 1 ? "CSV must contain at least one data row." : rowCount > MAX_IMPORT_RECORDS ? `Imports support up to ${MAX_IMPORT_RECORDS.toLocaleString()} records at a time.` : ""));
              }} placeholder={"Paste CSV with field API names in the first row\nfirstName,lastName,phone"} className="min-h-24 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs leading-5 placeholder:font-sans placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100" />
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                <span>{csv ? `${csvDataRows.length} data row${csvDataRows.length === 1 ? "" : "s"} detected` : "Map your CSV columns to CRM API fields below."}</span>
                {csv && <button type="button" onClick={() => { setCsv(""); setParsedCsv({ rows: [], error: "" }); setCsvError(""); }} className="font-medium text-blue-700 hover:underline">Clear data</button>}
              </div>
              {csvError && <p role="alert" className="text-xs text-rose-700">{csvError}</p>}
            </div>
          </section>

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
                            return <option key={field.name} value={field.name} disabled={usedElsewhere}>{field.label} ({field.name}){field.required ? " · Required" : ""}</option>;
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
              <p className="mt-0.5 text-[11px] text-slate-500">{previewRows.length ? `Showing the first ${Math.min(previewRows.length, PREVIEW_ROW_LIMIT)} of ${csvDataRows.length.toLocaleString()} records` : "Your CSV preview will appear here."}</p>
            </div>
            {csv && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-600">{previewHeaders.length} columns</span>}
          </div>
          {previewRows.length > 0 ? <div aria-label="CSV data preview rows" className="max-h-[55vh] overscroll-contain overflow-auto">
            <table className="w-full min-w-max border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-600"><tr>{previewHeaders.map((header, index) => <th key={`${header}-${index}`} className="border-b border-r border-slate-200 px-3 py-2 font-semibold last:border-r-0">{header || `Column ${index + 1}`}</th>)}</tr></thead>
              <tbody>{previewRows.slice(0, PREVIEW_ROW_LIMIT).map((row, rowIndex) => <tr key={rowIndex} className="even:bg-slate-50/70">{previewHeaders.map((header, columnIndex) => <td key={`${header}-${columnIndex}`} className="max-w-64 truncate border-b border-r border-slate-100 px-3 py-2 text-slate-600 last:border-r-0">{row[columnIndex] || <span className="text-slate-300">—</span>}</td>)}</tr>)}</tbody>
            </table>
          </div> : <div className="grid min-h-24 place-items-center px-4 text-center text-xs text-slate-400">Choose a CSV file or paste CSV data to preview records.</div>}
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
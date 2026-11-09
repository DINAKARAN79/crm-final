"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  Filter,
  GripVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Save,
  Search,
  Trash2,
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isSiteVisitStatusColumn, reportStatusCell, siteVisitStatusLabel } from "@/components/crm/site-visit-status-badge";
import { useAuth } from "@/contexts/auth-context";
import { dateKey, formatDateOnly, formatDateShort } from "@/lib/date-format";

interface Field {
  key: string;
  label: string;
  type: string;
  groupableInColumns?: boolean;
  groupableInRows?: boolean;
  isIdentifier?: boolean;
}
type DateGroupBucket = "day" | "week" | "month" | "quarter" | "year";
interface ReportObject {
  name: string;
  label: string;
  fields: Field[];
}
interface FilterRule {
  field: string;
  operator: string;
  value: string | { start: string; end: string };
}
interface ColumnConfig {
  field: string;
  label: string;
  visible: boolean;
  aggregation: "none" | "count" | "uniqueCount" | "sum" | "avg" | "min" | "max";
}
interface Aggregate {
  function: "count" | "sum" | "avg" | "min" | "max";
  field: string;
}
interface BuilderSnapshot {
  selectedFields: string[];
  rowGroups: string[];
  columnGroups: string[];
  filters: FilterRule[];
  sortBy: string;
  sortOrder: "asc" | "desc";
  secondarySortBy: string;
  secondarySortOrder: "asc" | "desc";
}
interface Result {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  summary?: Record<string, number>;
  groups?: { key?: string; group: string; groupValues?: Record<string, string>; count: number; summary: Record<string, number>; rows?: Record<string, unknown>[] }[];
  columnGroups?: { group: string; count: number }[];
  pivot?: {
    columns: string[];
    columnValues?: Record<string, Record<string, string>>;
    rows: { group: string; groupValues?: Record<string, string>; values: Record<string, number> }[];
    aggregateLabel?: string;
  };
}

interface GroupTreeNode {
  key: string;
  field: string;
  value: string;
  values: Record<string, string>;
  depth: number;
  count: number;
  summary: Record<string, number>;
  rows: Record<string, unknown>[];
  children: GroupTreeNode[];
}

function buildGroupTree(
  groups: NonNullable<Result["groups"]>,
  fields: string[],
): GroupTreeNode[] {
  const roots: GroupTreeNode[] = [];

  for (const group of groups) {
    let nodes = roots;
    let parentKey = "root";
    fields.forEach((field, depth) => {
      const value = group.groupValues?.[field] || "(Blank)";
      const key = `${parentKey}/${field}=${value}`;
      let node = nodes.find((candidate) => candidate.key === key);
      if (!node) {
        node = { key, field, value, values: {}, depth, count: 0, summary: {}, rows: [], children: [] };
        nodes.push(node);
      }
      node.values[field] = value;
      node.count += depth === fields.length - 1 ? group.count : 0;
      for (const [label, amount] of Object.entries(group.summary || {})) {
        node.summary[label] = (node.summary[label] || 0) + (depth === fields.length - 1 ? amount : 0);
      }
      if (depth === fields.length - 1) node.rows.push(...(group.rows || []));
      nodes = node.children;
      parentKey = key;
    });
  }

  const addParentTotals = (nodes: GroupTreeNode[]) => {
    for (const node of nodes) {
      addParentTotals(node.children);
      if (node.children.length) {
        node.count = node.children.reduce((sum, child) => sum + child.count, 0);
        node.summary = node.children.reduce<Record<string, number>>((totals, child) => {
          for (const [label, amount] of Object.entries(child.summary)) totals[label] = (totals[label] || 0) + amount;
          return totals;
        }, {});
      }
    }
  };
  addParentTotals(roots);
  return roots;
}

const operators = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "isBlank",
  "isNotBlank",
  "in",
  "notIn",
];
const getAvailableOperators = (type: string) => {
  const normalized = type.toLowerCase();

  if (normalized.includes("date")) {
    return [
      "equals",
      "notEquals",
      "gt",
      "gte",
      "lt",
      "lte",
    ];
  }

  if (normalized === "number" || normalized === "currency" || normalized === "decimal") {
    return [
      "equals",
      "notEquals",
      "gt",
      "gte",
      "lt",
      "lte",
    ];
  }

  return operators;
};
const relativeDateOperators = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "thisWeek", label: "This Week" },
  { value: "lastWeek", label: "Last Week" },
  { value: "nextWeek", label: "Next Week" },
  { value: "thisMonth", label: "This Month" },
  { value: "lastMonth", label: "Last Month" },
  { value: "nextMonth", label: "Next Month" },
  { value: "thisQuarter", label: "This Quarter" },
  { value: "lastQuarter", label: "Last Quarter" },
  { value: "thisYear", label: "This Year" },
  { value: "lastYear", label: "Last Year" },
  { value: "last90Days", label: "Last 90 Days" },
  { value: "customRange", label: "Custom Date Range" },
];
const operatorLabels: Record<string, string> = {
  equals: "equals",
  notEquals: "not equal to",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  gt: "greater than",
  gte: "greater or equal",
  lt: "less than",
  lte: "less or equal",
  isBlank: "is blank",
  isNotBlank: "is not blank",
  in: "is one of",
  notIn: "is not one of",
};

function validateFilterExpression(expression: string, filterCount: number): string | null {
  if (!expression.trim()) return null;
  const tokens = expression.match(/\(|\)|AND|OR|NOT|\d+/gi) || [];
  const source = expression.replace(/\(|\)|AND|OR|NOT|\d+/gi, "").trim();
  if (source) return "Filter logic contains an invalid expression.";
  let position = 0;
  const primary = (): boolean => {
    const token = tokens[position++];
    if (token === "(") {
      if (!orExpression()) return false;
      if (tokens[position++] !== ")") throw new Error("Invalid filter logic");
      return true;
    }
    if (token?.toUpperCase() === "NOT") return primary();
    const number = Number(token);
    if (!Number.isInteger(number) || number < 1 || number > filterCount) throw new Error("Invalid filter logic");
    return true;
  };
  const andExpression = (): boolean => {
    if (!primary()) return false;
    while (tokens[position]?.toUpperCase() === "AND") {
      position += 1;
      primary();
    }
    return true;
  };
  const orExpression = (): boolean => {
    if (!andExpression()) return false;
    while (tokens[position]?.toUpperCase() === "OR") {
      position += 1;
      andExpression();
    }
    return true;
  };
  try {
    orExpression();
    if (position !== tokens.length) throw new Error("Invalid filter logic");
    return null;
  } catch {
    return "Invalid filter logic";
  }
}

function relativeDateSummary(operator: string): string {
  const [year, month] = dateKey(new Date()).split("-").map(Number);
  const firstDay = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const today = dateKey(new Date());
  if (operator === "today") return `Today (${formatDateOnly(today)})`;
  if (operator === "thisMonth") return `This Month (${formatDateOnly(firstDay(year, month))} - ${formatDateOnly(lastDay(year, month))})`;
  if (operator === "lastMonth") {
    const previous = new Date(Date.UTC(year, month - 2, 1));
    const y = previous.getUTCFullYear();
    const m = previous.getUTCMonth() + 1;
    return `Last Month (${formatDateOnly(firstDay(y, m))} - ${formatDateOnly(lastDay(y, m))})`;
  }
  if (operator === "thisYear") return `This Year (${formatDateOnly(firstDay(year, 1))} - ${formatDateOnly(`${year}-12-31`)})`;
  return relativeDateOperators.find((item) => item.value === operator)?.label || operator;
}

function formatCustomDate(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDateOnly(value).replaceAll(" ", "-");
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return formatDateShort(date).replaceAll(" ", "-");
}
const crossFilterRelations: Record<string, string[]> = {
  Lead: ["SiteVisit", "Opportunity", "Quotation", "Booking", "Task"],
  Opportunity: ["Quotation", "Booking", "Task", "Activity"],
  SiteVisit: ["Task", "Activity"],
  Quotation: ["Booking", "Approval", "QuotationItem"],
  Booking: ["Payment", "Activity"],
  Project: ["Lead", "SiteVisit", "Opportunity", "Quotation", "Booking", "Unit"],
};
const aggregateLabels = {
  count: "Record Count",
  sum: "Sum",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
};

export default function NewReportPage() {
  const router = useRouter();
  const { getLeadStatusLabel } = useAuth();
  const [objects, setObjects] = React.useState<ReportObject[]>([]);
  const [selectedObject, setSelectedObject] = React.useState("");
  const [selectedFields, setSelectedFields] = React.useState<string[]>([]);
  const [columnLabels, setColumnLabels] = React.useState<Record<string, string>>({});
  const [hiddenColumns, setHiddenColumns] = React.useState<string[]>([]);
  const [columnAggregations, setColumnAggregations] = React.useState<Record<string, ColumnConfig["aggregation"]>>({});
  const [filters, setFilters] = React.useState<FilterRule[]>([]);
  const [filterFieldPicker, setFilterFieldPicker] = React.useState("");
  const [filterFieldPickerOpen, setFilterFieldPickerOpen] = React.useState(false);
  const [groupBy, setGroupBy] = React.useState("");
  const [groupColumn, setGroupColumn] = React.useState("");
  const [rowGroups, setRowGroups] = React.useState<string[]>([]);
  const [columnGroups, setColumnGroups] = React.useState<string[]>([]);
    const [groupDateBuckets, setGroupDateBuckets] = React.useState<Record<string, DateGroupBucket>>({});
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<string, boolean>>({});
  const [rowGroupSearch, setRowGroupSearch] = React.useState("");
  const [columnGroupSearch, setColumnGroupSearch] = React.useState("");
  const [rowGroupPickerOpen, setRowGroupPickerOpen] = React.useState(false);
  const [columnGroupPickerOpen, setColumnGroupPickerOpen] = React.useState(false);
  const [rowGroupHighlight, setRowGroupHighlight] = React.useState(0);
  const [columnGroupHighlight, setColumnGroupHighlight] = React.useState(0);
  const rowGroupPickerRef = React.useRef<HTMLDivElement>(null);
  const columnGroupPickerRef = React.useRef<HTMLDivElement>(null);
  const columnPickerRef = React.useRef<HTMLDivElement>(null);
  const filterFieldPickerRef = React.useRef<HTMLDivElement>(null);
  const [crossFilterObject, setCrossFilterObject] = React.useState("");
  const [crossFilterMode, setCrossFilterMode] = React.useState<"with" | "without">("with");
  const [sortBy, setSortBy] = React.useState("");
  const [sortOrder, setSortOrder] = React.useState<"asc" | "desc">("desc");
  const [secondarySortBy, setSecondarySortBy] = React.useState("");
  const [secondarySortOrder, setSecondarySortOrder] = React.useState<"asc" | "desc">("asc");
  const [aggregates, setAggregates] = React.useState<Aggregate[]>([
    { function: "count", field: "" },
  ]);
  const [reportName, setReportName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [fieldSearch, setFieldSearch] = React.useState("");
  const [columnPickerOpen, setColumnPickerOpen] = React.useState(false);
  const [panel, setPanel] = React.useState<"outline" | "filters">("outline");
  const [leftPanelWidth, setLeftPanelWidth] = React.useState(420);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = React.useState(false);
  const [resizingPanel, setResizingPanel] = React.useState(false);
  const [result, setResult] = React.useState<Result | null>(null);
  const panelTextSize = React.useMemo(() => {
    if (leftPanelCollapsed) return 12;
    return Math.min(15.5, Math.max(12.5, leftPanelWidth / 28));
  }, [leftPanelCollapsed, leftPanelWidth]);
  const [loading, setLoading] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [hasRun, setHasRun] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [showFolderPicker, setShowFolderPicker] = React.useState(false);
  const [newFolderDialogOpen, setNewFolderDialogOpen] = React.useState(false);
  const [newFolderName, setNewFolderName] = React.useState("");
  const [newFolderUniqueName, setNewFolderUniqueName] = React.useState("");
  const [reportUniqueName, setReportUniqueName] = React.useState("");
  const [folders, setFolders] = React.useState<{ id: string; name: string }[]>([]);
  const [folderSearch, setFolderSearch] = React.useState("");
  const [selectedFolderId, setSelectedFolderId] = React.useState<string | null>(null);
  const [folderMenuOpen, setFolderMenuOpen] = React.useState(false);
  const [folderPickerSearch, setFolderPickerSearch] = React.useState("");
  const [folderPickerCategory, setFolderPickerCategory] = React.useState<"all" | "createdByMe">("all");
  const [pendingFolderId, setPendingFolderId] = React.useState<string | null>(null);
  const [editingReportId, setEditingReportId] = React.useState<string | null>(null);
  const editHydrated = React.useRef(false);
  const closingRef = React.useRef(false);
  const [autoPreview, setAutoPreview] = React.useState(true);
  const [filterLogic, setFilterLogic] = React.useState<"AND" | "OR">("AND");
  const [filterExpression, setFilterExpression] = React.useState("");
  const [filterLogicDraft, setFilterLogicDraft] = React.useState("");
  const [filterLogicError, setFilterLogicError] = React.useState("");
  const [filterLogicOpen, setFilterLogicOpen] = React.useState(false);
  const [showMe, setShowMe] = React.useState<"all" | "mine">("all");
  const [filterActionsOpen, setFilterActionsOpen] = React.useState(false);
  const [crossFilterEditorOpen, setCrossFilterEditorOpen] = React.useState(false);
  const [filterEditorOpen, setFilterEditorOpen] = React.useState(false);
  const [filterEditorIndex, setFilterEditorIndex] = React.useState<number | null>(null);
  const [filterDraft, setFilterDraft] = React.useState<FilterRule | null>(null);
  const [picklistValues, setPicklistValues] = React.useState<string[]>([]);
  const [rowLimitEditorOpen, setRowLimitEditorOpen] = React.useState(false);
  const [showRowCounts, setShowRowCounts] = React.useState(true);
  const [showDetailRows, setShowDetailRows] = React.useState(true);
  const [showSubtotals, setShowSubtotals] = React.useState(false);
  const [showGrandTotal, setShowGrandTotal] = React.useState(true);
  const [reportFormat, setReportFormat] = React.useState<"TABULAR" | "SUMMARY" | "MATRIX" | "JOINED">("TABULAR");
  const [rowLimit, setRowLimit] = React.useState(10000);
  const [showChart, setShowChart] = React.useState(false);
  const [conditionalFormatting, setConditionalFormatting] = React.useState(false);
  const [historyVersion, setHistoryVersion] = React.useState(0);
  const historyRef = React.useRef<BuilderSnapshot[]>([]);
  const futureRef = React.useRef<BuilderSnapshot[]>([]);
  const previousSnapshotRef = React.useRef<BuilderSnapshot | null>(null);
  const restoringSnapshotRef = React.useRef(false);

  const object = objects.find((item) => item.name === selectedObject);
  const fields = object?.fields || [];
  const canGroupInColumns = (field: Field) => {
    const key = field.key.toLowerCase();
    const label = field.label.toLowerCase();
    if (field.groupableInColumns === false || field.isIdentifier) return false;
    if (key === "id" || key.endsWith("id")) return false;
    if (label === "id" || label.endsWith(" id")) return false;
    return true;
  };
  const visibleFields = fields.filter((field) =>
    `${field.label} ${field.key}`
      .toLowerCase()
      .includes(fieldSearch.toLowerCase()),
  );
  const visibleRowGroupFields = fields.filter(
    (field) =>
      field.groupableInRows !== false &&
      !rowGroups.includes(field.key) &&
      `${field.label} ${field.key}`
        .toLowerCase()
        .includes(rowGroupSearch.toLowerCase()),
  );
  const visibleColumnGroupFields = fields.filter(
    (field) =>
      canGroupInColumns(field) &&
      !columnGroups.includes(field.key) &&
      `${field.label} ${field.key}`
        .toLowerCase()
        .includes(columnGroupSearch.toLowerCase()),
  );
  const numericFields = fields.filter((field) =>
    ["number", "currency", "decimal"].includes(field.type.toLowerCase()),
  );

  const currentSnapshot = React.useMemo<BuilderSnapshot>(() => ({
    selectedFields,
    rowGroups,
    columnGroups,
    filters,
    sortBy,
    sortOrder,
    secondarySortBy,
    secondarySortOrder,
  }), [selectedFields, rowGroups, columnGroups, filters, sortBy, sortOrder, secondarySortBy, secondarySortOrder]);

  React.useEffect(() => {
    if (!previousSnapshotRef.current) {
      previousSnapshotRef.current = currentSnapshot;
      return;
    }
    if (restoringSnapshotRef.current) {
      restoringSnapshotRef.current = false;
      previousSnapshotRef.current = currentSnapshot;
      return;
    }
    if (JSON.stringify(previousSnapshotRef.current) !== JSON.stringify(currentSnapshot)) {
      historyRef.current = [...historyRef.current.slice(-19), previousSnapshotRef.current];
      futureRef.current = [];
      previousSnapshotRef.current = currentSnapshot;
      setHistoryVersion((version) => version + 1);
    }
  }, [currentSnapshot]);

  const restoreSnapshot = (snapshot: BuilderSnapshot) => {
    restoringSnapshotRef.current = true;
    setSelectedFields(snapshot.selectedFields);
    setRowGroups(snapshot.rowGroups);
    setColumnGroups(snapshot.columnGroups);
    setGroupBy(snapshot.rowGroups[0] || "");
    setGroupColumn(snapshot.columnGroups[0] || "");
    setFilters(snapshot.filters);
    setSortBy(snapshot.sortBy);
    setSortOrder(snapshot.sortOrder);
    setSecondarySortBy(snapshot.secondarySortBy);
    setSecondarySortOrder(snapshot.secondarySortOrder);
  };

  const undoBuilderChange = () => {
    const snapshot = historyRef.current.pop();
    if (!snapshot || !previousSnapshotRef.current) return;
    futureRef.current = [...futureRef.current, previousSnapshotRef.current];
    restoreSnapshot(snapshot);
    previousSnapshotRef.current = snapshot;
    setHistoryVersion((version) => version + 1);
  };

  const redoBuilderChange = () => {
    const snapshot = futureRef.current.pop();
    if (!snapshot || !previousSnapshotRef.current) return;
    historyRef.current = [...historyRef.current, previousSnapshotRef.current];
    restoreSnapshot(snapshot);
    previousSnapshotRef.current = snapshot;
    setHistoryVersion((version) => version + 1);
  };

  React.useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      const pickerTarget = target instanceof Element ? target.closest("[data-group-picker]") : null;
      if (!rowGroupPickerRef.current?.contains(target) && pickerTarget?.getAttribute("data-group-picker") !== "rows") setRowGroupPickerOpen(false);
      if (!columnGroupPickerRef.current?.contains(target) && pickerTarget?.getAttribute("data-group-picker") !== "columns") setColumnGroupPickerOpen(false);
      if (!columnPickerRef.current?.contains(target) && pickerTarget?.getAttribute("data-column-picker") !== "columns") setColumnPickerOpen(false);
      if (!filterFieldPickerRef.current?.contains(target)) setFilterFieldPickerOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, []);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey) return;

      // Never hijack keys while typing, and never swallow Alt+←/→ — those are
      // the browser's Back/Forward navigation on Windows/Linux.
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (typing) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") return;

      if (event.key === "0" || event.key === "Escape") {
        event.preventDefault();
        setLeftPanelCollapsed(true);
      }

      if (event.key === "1") {
        event.preventDefault();
        setLeftPanelCollapsed(false);
        setLeftPanelWidth(320);
      }

      if (event.key === "2") {
        event.preventDefault();
        setLeftPanelCollapsed(false);
        setLeftPanelWidth(520);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleLeftPanelResize = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const container = event.currentTarget.parentElement;
    if (!container) return;

    const startX = event.clientX;
    const startWidth = leftPanelWidth;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = Math.min(760, Math.max(260, startWidth + delta));
      setLeftPanelWidth(nextWidth);
      setLeftPanelCollapsed(false);
    };

    const handleMouseUp = () => {
      setResizingPanel(false);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    setResizingPanel(true);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [leftPanelWidth]);

  React.useEffect(() => {
    setRowGroupHighlight(0);
  }, [rowGroupSearch]);

  React.useEffect(() => {
    setColumnGroupHighlight(0);
  }, [columnGroupSearch]);

  React.useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setEditingReportId(new URLSearchParams(window.location.search).get("edit"));
    const requestedFormat = query.get("format");
    if (["TABULAR", "SUMMARY", "MATRIX", "JOINED"].includes(requestedFormat || "")) setReportFormat(requestedFormat as "TABULAR" | "SUMMARY" | "MATRIX" | "JOINED");
    setSelectedFolderId(query.get("folderId"));
    fetch("/api/proxy/api/reports/metadata", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.success)
          throw new Error(body.error || "Unable to load report types");
        const data = (
          Array.isArray(body.data) ? body.data : body.data?.objects || []
        )
          .map((item: any) => ({
            name: item.name || item.objectName || item.object,
            label: item.label || item.name || item.object,
            fields: (item.fields || []).map((field: any) => ({
              key: field.key || field.name,
              label: field.label || field.key || field.name,
              type: field.type || "string",
              groupableInColumns: field.groupableInColumns !== false,
              groupableInRows: field.groupableInRows !== false,
              isIdentifier: field.isIdentifier === true,
            })),
          }))
          .filter((item: ReportObject) => item.name && item.fields.length);
        setObjects(data);
        const requested = new URLSearchParams(window.location.search).get(
          "object",
        );
        const requestedObject = requested && requested !== "undefined" ? requested : "";
        setSelectedObject(
          data.find((item: ReportObject) => item.name === requestedObject)?.name ||
            data[0]?.name ||
            "",
        );
      })
      .catch((requestError) =>
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to load report types",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    if (!saveOpen) return;

    fetch("/api/proxy/api/report-folders?view=all", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error || "Unable to load folders");
        setFolders(Array.isArray(body.data) ? body.data : []);
      })
      .catch(() => setFolders([]));
  }, [saveOpen]);

  React.useEffect(() => {
    if (!object || !editingReportId || editHydrated.current) return;
    editHydrated.current = true;
    fetch(`/api/proxy/api/reports/${editingReportId}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error || "Unable to load report");
        const saved = body.data;
        const savedObjectName = saved.objectName || object.name;
        const savedObject = objects.find((item) => item.name === savedObjectName) || object;
        const savedColumns = Array.isArray(saved.columns)
          ? saved.columns.filter((field: unknown): field is string => typeof field === "string" && savedObject.fields.some((item) => item.key === field))
          : [];
        setReportName(saved.name || "");
        setDescription(saved.description || "");
        if (["TABULAR", "SUMMARY", "MATRIX", "JOINED"].includes(saved.type)) setReportFormat(saved.type);
        setSelectedObject(savedObjectName);
        setSelectedFields(savedColumns.length ? savedColumns : savedObject.fields.slice(0, 3).map((field) => field.key));
        const savedConfig = saved.config && typeof saved.config === "object" ? saved.config : {};
        setColumnLabels(savedConfig.columnLabels || {});
        setHiddenColumns(Array.isArray(savedConfig.hiddenColumns) ? savedConfig.hiddenColumns : []);
        setColumnAggregations(savedConfig.columnAggregations || {});
        setRowLimit(Number(savedConfig.rowLimit) || 10000);
        setShowChart(savedConfig.showChart === true);
        setConditionalFormatting(savedConfig.conditionalFormatting === true);
        setShowRowCounts(savedConfig.showRowCounts !== false);
        setShowDetailRows(savedConfig.showDetailRows !== false);
        setShowSubtotals(savedConfig.showSubtotals === true);
        setShowGrandTotal(savedConfig.showGrandTotal !== false);
        setFilters(Array.isArray(saved.filters) ? saved.filters : []);
        setFilterLogic(saved.filterLogic === "OR" ? "OR" : "AND");
        setFilterExpression(saved.filterExpression || "");
        setCrossFilterObject(saved.crossFilter?.objectName || "");
        setCrossFilterMode(saved.crossFilter?.mode === "without" ? "without" : "with");
        const savedRowGroups = Array.isArray(saved.rowGroups)
          ? saved.rowGroups
          : Array.isArray(savedConfig.rowGroups)
            ? savedConfig.rowGroups
            : saved.groupBy
              ? [saved.groupBy]
              : [];
        const savedColumnGroups = Array.isArray(saved.columnGroups)
          ? saved.columnGroups
          : Array.isArray(savedConfig.columnGroups)
            ? savedConfig.columnGroups
            : saved.groupColumn
              ? [saved.groupColumn]
              : [];
        const normalizedRowGroups = savedRowGroups.filter((field: unknown): field is string => typeof field === "string" && !savedColumnGroups.includes(field));
        const normalizedColumnGroups = normalizedRowGroups.length ? savedColumnGroups : [];
        setGroupBy(saved.groupBy && !normalizedColumnGroups.includes(saved.groupBy) ? saved.groupBy : normalizedRowGroups[0] || "");
        setGroupColumn(saved.groupColumn && normalizedColumnGroups.includes(saved.groupColumn) ? saved.groupColumn : normalizedColumnGroups[0] || "");
        setSelectedFolderId(saved.folderId || saved.folder?.id || null);
        setFolderSearch(saved.folder?.name || "");
        setRowGroups(normalizedRowGroups);
        setColumnGroups(normalizedColumnGroups);
          setGroupDateBuckets(savedConfig.groupDateBuckets || {});
        setSortBy(saved.sortBy || "");
        setSortOrder(saved.sortOrder === "asc" ? "asc" : "desc");
        setAggregates(Array.isArray(saved.aggregates) && saved.aggregates.length ? saved.aggregates : [{ function: "count", field: "" }]);
      })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to load report"));
  }, [editingReportId, object]);

  React.useEffect(() => {
    if (!object) return;
    if (editingReportId && editHydrated.current) return;
    const defaults = object.fields.slice(0, 3).map((field) => field.key);
    setSelectedFields(defaults);
    setFilters([]);
    setFilterFieldPicker("");
    setGroupBy("");
    setGroupColumn("");
    setRowGroups([]);
    setColumnGroups([]);
      setGroupDateBuckets({});
    setRowGroupSearch("");
    setColumnGroupSearch("");
    setCrossFilterObject("");
    setCrossFilterMode("with");
    setSortBy(
      object.fields.some((field) => field.key === "createdAt")
        ? "createdAt"
        : object.fields[0]?.key || "",
    );
    setAggregates([{ function: "count", field: "" }]);
    setResult(null);
  }, [object, selectedObject]);

  const fieldLabel = (key: string) =>
    fields.find((field) => field.key === key)?.label || key;
  const fieldType = (key: string) => fields.find((field) => field.key === key)?.type.toLowerCase() || "string";
  const columnLabel = (key: string) => columnLabels[key] || fieldLabel(key);
  React.useEffect(() => {
    if (!filterEditorOpen || !filterDraft || fieldType(filterDraft.field) !== "enum") {
      setPicklistValues([]);
      return;
    }
    const params = new URLSearchParams({ objectName: selectedObject, field: filterDraft.field });
    fetch(`/api/proxy/api/reports/field-values?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error || "Unable to load picklist values");
        setPicklistValues(Array.isArray(body.data) ? body.data : []);
      })
      .catch(() => setPicklistValues([]));
  }, [filterEditorOpen, filterDraft?.field, selectedObject]);
  const allowedAggregations = (key: string): ColumnConfig["aggregation"][] =>
    ["number", "currency", "decimal"].includes(fieldType(key))
      ? ["none", "sum", "avg", "min", "max", "count", "uniqueCount"]
      : ["none", "count", "uniqueCount"];
  const removeFieldFromColumns = (key: string) => {
    setSelectedFields((current) => {
      const next = current.filter((item) => item !== key);
      if (next.length !== current.length && next.length === 0) {
        setResult(null);
        setHasRun(false);
      }
      return next;
    });
  };
  const toggleField = (key: string) => {
    const isSelected = selectedFields.includes(key);
    if (!isSelected) {
      setRowGroups((current) => current.filter((item) => item !== key));
      setColumnGroups((current) => current.filter((item) => item !== key));
      if (groupBy === key) setGroupBy("");
      if (groupColumn === key) setGroupColumn("");
    }
    setSelectedFields((current) => {
      const next = isSelected
        ? current.filter((item) => item !== key)
        : [...current, key];
      if (next.length === 0) {
        setResult(null);
        setHasRun(false);
      }
      return next;
    });
  };
  const clearSelectedFields = () => {
    setSelectedFields([]);
    setResult(null);
    setHasRun(false);
  };
  const openFilterEditor = (field: string, index: number | null = null) => {
    const existing = index === null ? null : filters[index];
    setFilterEditorIndex(index);
    setFilterDraft(existing ? { ...existing } : { field, operator: fieldType(field).includes("date") ? "thisMonth" : "equals", value: "" });
    setFilterEditorOpen(true);
  };
  const addFilter = (field = filterFieldPicker || fields[0]?.key || "") => {
    if (field) openFilterEditor(field);
  };
  const applyFilterDraft = () => {
    if (!filterDraft?.field) return;
    if (filterDraft.operator === "customRange" && (typeof filterDraft.value !== "object" || !filterDraft.value.start || !filterDraft.value.end)) {
      setError("Enter both dates before applying the custom range.");
      return;
    }
    const normalizedFilter = { field: filterDraft.field, operator: filterDraft.operator, value: filterDraft.value };
    setFilters((current) => filterEditorIndex === null ? [...current, normalizedFilter] : current.map((item, index) => index === filterEditorIndex ? normalizedFilter : item));
    setFilterEditorOpen(false);
    setFilterEditorIndex(null);
    setFilterDraft(null);
    setError("");
  };
  const addAggregate = () =>
    setAggregates((current) => [
      ...current,
      { function: "sum", field: numericFields[0]?.key || "" },
    ]);
  const addRowGroup = (field: string) => {
    if (!field || rowGroups.includes(field)) {
      if (field) setError(`${fieldLabel(field)} is already grouped.`);
      return;
    }
    const nextRowGroups = rowGroups.filter((item) => item !== field);
    if (nextRowGroups.length >= 2) {
      setError("You can add up to 2 row groupings.");
      return;
    }
    if (columnGroups.includes(field)) {
      setColumnGroups((current) => current.filter((item) => item !== field));
      if (groupColumn === field) setGroupColumn(columnGroups.find((item) => item !== field) || "");
    }
    removeFieldFromColumns(field);
    setRowGroups((current) => [...current.filter((item) => item !== field), field]);
    if (fieldType(field) === "date") setGroupDateBuckets((current) => ({ ...current, [field]: current[field] || "day" }));
    if (!groupBy) setGroupBy(field);
    setRowGroupPickerOpen(false);
    setError("");
  };
  const moveGroup = (groups: string[], setGroups: React.Dispatch<React.SetStateAction<string[]>>, field: string, direction: -1 | 1) => {
    const index = groups.indexOf(field);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= groups.length) return;
    setGroups((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };
  const reorderGroup = (field: string, axis: "rows" | "columns", targetIndex: number) => {
    const setGroups = axis === "rows" ? setRowGroups : setColumnGroups;
    setGroups((current) => {
      const sourceIndex = current.indexOf(field);
      if (sourceIndex < 0 || sourceIndex === targetIndex) return current;
      const next = [...current];
      next.splice(sourceIndex, 1);
      next.splice(Math.min(targetIndex, next.length), 0, field);
      return next;
    });
  };
  const moveColumn = (field: string, direction: -1 | 1) => moveGroup(selectedFields, setSelectedFields, field, direction);
  const removeRowGroup = (field: string) => {
    const nextRowGroups = rowGroups.filter((item) => item !== field);
    setRowGroups(nextRowGroups);
    if (nextRowGroups.length === 0) {
      setColumnGroups([]);
      setGroupColumn("");
    }
    if (groupBy === field)
      setGroupBy(rowGroups.find((item) => item !== field) || "");
    setCollapsedGroups((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  };
  const addColumnGroup = (field: string) => {
    if (!field || columnGroups.includes(field)) {
      if (field) setError(`${fieldLabel(field)} is already grouped.`);
      return;
    }
    const nextColumnGroups = columnGroups.filter((item) => item !== field);
    if (nextColumnGroups.length >= 2) {
      setError("You can add up to 2 column groupings.");
      return;
    }
    if (rowGroups.includes(field)) {
      setRowGroups((current) => current.filter((item) => item !== field));
      if (groupBy === field) setGroupBy(rowGroups.find((item) => item !== field) || "");
    }
    removeFieldFromColumns(field);
    setColumnGroups((current) => [...current.filter((item) => item !== field), field]);
    if (fieldType(field) === "date") setGroupDateBuckets((current) => ({ ...current, [field]: current[field] || "day" }));
    if (!groupColumn) setGroupColumn(field);
    setColumnGroupPickerOpen(false);
    setError("");
  };
  const removeColumnGroup = (field: string) => {
    setColumnGroups((current) => current.filter((item) => item !== field));
    if (groupColumn === field) setGroupColumn(columnGroups.find((item) => item !== field) || "");
  };
  const moveGroupBetweenAxes = (field: string, from: "rows" | "columns", to: "rows" | "columns") => {
    if (from === to) return;
    if (to === "rows") {
      if (rowGroups.length >= 2) {
        setError("You can add up to 2 row groupings.");
        return;
      }
      if (rowGroups.includes(field)) return;
      setRowGroups((current) => [...current, field]);
      setColumnGroups((current) => current.filter((item) => item !== field));
      setGroupBy(rowGroups[0] || field);
      if (groupColumn === field) setGroupColumn(columnGroups.find((item) => item !== field) || "");
    } else {
      if (columnGroups.length >= 2) {
        setError("You can add up to 2 column groupings.");
        return;
      }
      if (columnGroups.includes(field)) return;
      setColumnGroups((current) => [...current, field]);
      setRowGroups((current) => current.filter((item) => item !== field));
      setGroupColumn(columnGroups[0] || field);
      if (groupBy === field) setGroupBy(rowGroups.find((item) => item !== field) || "");
    }
    setError("");
  };
  const handleGroupDrop = (event: React.DragEvent, axis: "rows" | "columns") => {
    event.preventDefault();
    const field = event.dataTransfer.getData("text/plain");
    const from = event.dataTransfer.getData("group-axis");
    if (!field) return;
    if (from === "fields") {
      if (axis === "rows") addRowGroup(field);
      else addColumnGroup(field);
    } else if (from === "rows" || from === "columns") {
      moveGroupBetweenAxes(field, from, axis);
    }
  };
  const validFilters = filters.filter(
    (filter) => filter.field,
  );
  const hasGrouping = rowGroups.length > 0 || columnGroups.length > 0;
  const validAggregates = aggregates.filter(
    (aggregate) => aggregate.function === "count" || aggregate.field,
  );
  const filterSummary =
    validFilters.length === 0
      ? "No filters"
      : `${validFilters.length} filter${validFilters.length === 1 ? "" : "s"} · ${filterLogic}`;

  const groupCountByField = React.useMemo(() => {
    const counts: Record<string, Record<string, number>> = {};
    for (const field of rowGroups) counts[field] = {};
    for (const group of result?.groups || []) {
      for (const field of rowGroups) {
        const value = group.groupValues?.[field] || "Unknown";
        counts[field][value] = (counts[field][value] || 0) + group.count;
      }
    }
    return counts;
  }, [result?.groups, rowGroups]);

  const formatGroupedValue = (field: string, value: string) => {
    const label = selectedObject === "Lead" && field === "status"
      ? getLeadStatusLabel(value)
      : isSiteVisitStatusColumn(selectedObject, field) ? siteVisitStatusLabel(value) : value;
    const count = groupCountByField[field]?.[value] || 0;
    return showRowCounts && count > 0 ? `${label} (${count})` : label;
  };
  const formatReportCell = (objectName: string, field: string, value: unknown) =>
    objectName === "Lead" && field === "status"
      ? getLeadStatusLabel(String(value ?? ""))
      : reportStatusCell(objectName, field, value);
  const formatFilterValue = (field: string, value: unknown) =>
    selectedObject === "Lead" && field === "status" && typeof value === "string"
      ? getLeadStatusLabel(value)
      : String(value ?? "");

  const runReport = async (preview = false): Promise<Result | null> => {
    if (!selectedObject || selectedFields.length === 0) {
      setError("Select at least one field before running the report.");
      return null;
    }
    try {
      setRunning(true);
      setError("");
      const response = await fetch("/api/proxy/api/reports/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objectName: selectedObject,
          columns: selectedFields.filter((field) => !hiddenColumns.includes(field)),
          filters: validFilters,
          filterExpression: filterExpression.trim() || undefined,
          showMe,
          crossFilter: crossFilterObject ? { objectName: crossFilterObject, mode: crossFilterMode } : null,
          filterLogic,
          groupBy: rowGroups[0] || undefined,
          groupColumn: columnGroups[0] || undefined,
          rowGroups,
          columnGroups,
          groupOptions: Object.fromEntries(Object.entries(groupDateBuckets).map(([field, dateBucket]) => [field, { dateBucket }])),
          sortBy: sortBy || undefined,
          sortOrder,
          sortRules: [sortBy && { field: sortBy, order: sortOrder }, secondarySortBy && { field: secondarySortBy, order: secondarySortOrder }].filter(Boolean),
          limit: preview ? Math.min(rowLimit, 20) : rowLimit,
          aggregates: [...validAggregates, ...selectedFields.filter((field) => !hiddenColumns.includes(field) && columnAggregations[field] && columnAggregations[field] !== "none").map((field) => ({ function: columnAggregations[field] === "uniqueCount" ? "uniqueCount" : columnAggregations[field], field, label: columnLabel(field) }))],
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.success)
        throw new Error(body.error || body.message || "Unable to run report");
      setResult(body.data);
      if (!preview) setHasRun(true);
      return body.data;
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to run report",
      );
      return null;
    } finally {
      setRunning(false);
    }
  };

  React.useEffect(() => {
    if (closingRef.current || !autoPreview || !selectedObject || selectedFields.length === 0 || loading) return;
    const timer = window.setTimeout(() => void runReport(true), 250);
    return () => window.clearTimeout(timer);
  }, [autoPreview, selectedObject, selectedFields, filters, filterLogic, filterExpression, showMe, rowGroups, columnGroups, groupDateBuckets, sortBy, sortOrder, secondarySortBy, secondarySortOrder, rowLimit, loading]);

  const saveReport = async () => {
    if (!reportName.trim()) {
      setError("Enter a report name before saving.");
      return;
    }
    try {
      setSaving(true);
      setError("");
      const response = await fetch(editingReportId ? `/api/proxy/api/reports/${editingReportId}` : "/api/proxy/api/reports", {
        method: editingReportId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: reportName.trim(),
          uniqueName: reportUniqueName.trim() || undefined,
          config: { columnLabels, hiddenColumns, columnAggregations, filterExpression, rowLimit, showChart, conditionalFormatting, reportFormat, showRowCounts, showDetailRows, showSubtotals, showGrandTotal, groupDateBuckets, rowGroups, columnGroups },
          description: description.trim() || undefined,
          type: reportFormat,
          objectName: selectedObject,
          columns: selectedFields.filter((field) => !hiddenColumns.includes(field)),
          filters: validFilters,
          filterExpression: filterExpression.trim() || undefined,
          crossFilter: crossFilterObject ? { objectName: crossFilterObject, mode: crossFilterMode } : null,
          aggregates: [...validAggregates, ...selectedFields.filter((field) => !hiddenColumns.includes(field) && columnAggregations[field] && columnAggregations[field] !== "none").map((field) => ({ function: columnAggregations[field] === "uniqueCount" ? "uniqueCount" : columnAggregations[field], field, label: columnLabel(field) }))],
          groupBy: rowGroups[0] || undefined,
          groupColumn: columnGroups[0] || undefined,
          rowGroups,
          columnGroups,
          groupOptions: Object.fromEntries(Object.entries(groupDateBuckets).map(([field, dateBucket]) => [field, { dateBucket }])),
          filterLogic,
          sortBy: sortBy || undefined,
          sortOrder,
          sortRules: [sortBy && { field: sortBy, order: sortOrder }, secondarySortBy && { field: secondarySortBy, order: secondarySortOrder }].filter(Boolean),
          rowLimit,
          chart: showChart ? { enabled: true } : undefined,
          conditionalFormatting: conditionalFormatting ? { enabled: true } : undefined,
          folderId: selectedFolderId || undefined,
          isShared: false,
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.success)
        throw new Error(body.error || body.message || "Unable to save report");
      setSaveOpen(false);
      const tenantId = new URLSearchParams(window.location.search).get("tenantId");
      const tenantQuery = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
      router.push(`/reports/${body.data.id}${tenantQuery}`);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to save report",
      );
    } finally {
      setSaving(false);
    }
  };

  const runAndPreviewReport = async () => {
    setAutoPreview(false);
    const previewResult = await runReport();
    if (!previewResult) return;
    const previewId = editingReportId || "new";
    sessionStorage.setItem(`report-preview:${previewId}`, JSON.stringify({
      result: previewResult,
      report: {
        id: previewId,
        name: reportName || "Untitled Report",
        description,
        type: reportFormat,
        objectName: selectedObject,
        columns: selectedFields.filter((field) => !hiddenColumns.includes(field)),
        filters: validFilters,
        filterLogic,
        aggregates: validAggregates,
        groupBy: rowGroups[0] || null,
        groupColumn: columnGroups[0] || null,
        rowGroups,
        columnGroups,
        crossFilter: crossFilterObject ? { objectName: crossFilterObject, mode: crossFilterMode } : null,
        sortBy: sortBy || null,
        sortOrder,
        config: { showRowCounts, showDetailRows, showSubtotals, showGrandTotal, rowGroups, columnGroups, groupDateBuckets },
      },
    }));
    router.push(editingReportId ? `/reports/${encodeURIComponent(editingReportId)}` : "/reports/preview");
  };

  const closeReportBuilder = () => {
    closingRef.current = true;
    setAutoPreview(false);
    historyRef.current = [];
    futureRef.current = [];
    const destination = editingReportId ? `/reports/${encodeURIComponent(editingReportId)}` : "/reports";
    window.location.replace(destination);
  };

  const filteredFolders = folders.filter((folder) =>
    folder.name.toLowerCase().includes(folderSearch.toLowerCase()),
  );
  const filteredPickerFolders = folders.filter((folder) =>
    folder.name.toLowerCase().includes(folderPickerSearch.toLowerCase()),
  );
  const openFolderPicker = () => {
    setPendingFolderId(selectedFolderId);
    setFolderPickerCategory("all");
    setFolderPickerSearch("");
    setShowFolderPicker(true);
  };
  const createFolderFromPicker = async () => {
    const name = newFolderName.trim();
    if (!name || !newFolderUniqueName.trim()) return;
    try {
      const response = await fetch("/api/proxy/api/report-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), uniqueName: newFolderUniqueName.trim() }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "Unable to create folder");
      const folder = body.data;
      setFolders((current) => [...current, { id: folder.id, name: folder.name }]);
      setPendingFolderId(folder.id);
      setNewFolderName("");
      setNewFolderUniqueName("");
      setNewFolderDialogOpen(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create folder");
    }
  };
  const selectedFolderName =
    folders.find((folder) => folder.id === selectedFolderId)?.name || "Private Reports";
  const pivotColumnHeaders = result?.pivot?.columns.map((column) => ({
    label: column,
    primary: result.pivot?.columnValues?.[column]?.[columnGroups[0]] || column,
    secondary: columnGroups.length > 1 ? result.pivot?.columnValues?.[column]?.[columnGroups[1]] || "(Blank)" : "",
  })) || [];
  const displayGroups = React.useMemo(() => {
    if (!result || !rowGroups.length) return [];
    if (result.groups?.length) return result.groups;
    const grouped = new Map<string, NonNullable<Result["groups"]>[number]>();
    for (const row of result.rows) {
      const groupValues = Object.fromEntries(rowGroups.map((field) => [field, row[field] == null || row[field] === "" ? "(Blank)" : String(row[field])]));
      const group = Object.values(groupValues).join(" / ") || "All records";
      const current = grouped.get(group);
      if (current) {
        current.count += 1;
        current.rows = [...(current.rows || []), row];
      } else {
        grouped.set(group, { group, groupValues, count: 1, summary: {}, rows: [row] });
      }
    }
    return [...grouped.values()];
  }, [result, rowGroups]);
  const groupTree = displayGroups.length && rowGroups.length ? buildGroupTree(displayGroups, rowGroups) : [];
  const renderGroupTree = (nodes: GroupTreeNode[]): React.ReactNode[] => nodes.flatMap((node) => {
    const collapsed = Boolean(collapsedGroups[node.key] || collapsedGroups[node.field]);
    const summaryLabels = Object.keys(node.summary);
    const detailRows = showDetailRows && node.children.length === 0 && !collapsed
      ? node.rows.slice(0, hasRun ? node.rows.length : 20)
      : [];
    return [
      <tr key={node.key} className={`border-b border-slate-200 hover:bg-muted/50 ${node.depth === 0 ? "font-medium" : "text-slate-700"}`}>
        {rowGroups.map((field, index) => <td key={field} className="border-r border-slate-200 px-3 py-2" style={{ paddingLeft: `${12 + (node.depth > 0 && index === node.depth ? 20 : 0)}px` }}>
          {index === node.depth && <button type="button" onClick={() => setCollapsedGroups((current) => ({ ...current, [node.key]: !collapsed }))} className="mr-1 text-[11px]" aria-label={`${collapsed ? "Expand" : "Collapse"} ${node.value}`}>{collapsed ? "▶" : "▼"}</button>}
          {index === node.depth ? formatGroupedValue(field, node.value) : ""}
        </td>)}
        {showRowCounts && <td className="border-r border-slate-200 px-3 py-2 text-center">{node.count}</td>}
        {summaryLabels.map((label) => <td key={label} className="border-r border-slate-200 px-3 py-2 text-center">{node.summary[label] ?? 0}</td>)}
      </tr>,
      ...(!collapsed ? renderGroupTree(node.children) : []),
      ...detailRows.map((row, rowIndex) => <tr key={`${node.key}-detail-${rowIndex}`} className="border-b border-slate-100 bg-muted/40">
        <td colSpan={rowGroups.length + (showRowCounts ? 1 : 0) + summaryLabels.length} className="p-0">
          <div className="grid min-w-0 border-l-2 border-primary/20 text-xs text-slate-600" style={{ gridTemplateColumns: `repeat(${result?.columns.length || 1}, minmax(0, 1fr))` }}>
            {result?.columns.map((column) => <div key={column} className="border-r border-slate-100 px-3 py-1.5"><span className="mr-1 text-[11px] font-medium text-slate-400">{fieldLabel(column)}:</span>{formatReportCell(selectedObject, column, row[column])}</div>)}
          </div>
        </td>
      </tr>),
      ...(showSubtotals && node.children.length === 0 ? [<tr key={`${node.key}-subtotal`} className="border-b bg-muted/50 font-semibold"><td colSpan={rowGroups.length + (showRowCounts ? 1 : 0)} className="px-3 py-2 text-right">Subtotal</td>{summaryLabels.map((label) => <td key={label} className="px-3 py-2 text-center">{node.summary[label] ?? 0}</td>)}</tr>] : []),
    ];
  });
  const renderTabularGroupTree = (nodes: GroupTreeNode[]): React.ReactNode[] => nodes.flatMap((node) => {
    const collapsed = Boolean(collapsedGroups[node.key] || collapsedGroups[node.field]);
    return [
      <tr key={`${node.key}-header`} className="border-b border-slate-300 bg-primary/5 hover:bg-primary/10">
        {rowGroups.map((field, index) => <td key={field} className="border-r border-slate-200 px-3 py-2 font-semibold text-primary">
          {index === node.depth && <><button type="button" onClick={() => setCollapsedGroups((current) => ({ ...current, [node.key]: !collapsed }))} className="mr-2 text-[11px]" aria-label={`${collapsed ? "Expand" : "Collapse"} ${node.value}`}>{collapsed ? "▶" : "▼"}</button>{isSiteVisitStatusColumn(selectedObject, field) ? siteVisitStatusLabel(node.value) : node.value}{showRowCounts && <span className="ml-1 font-normal text-muted-foreground">({node.count})</span>}</>}
        </td>)}
        {(result?.columns || []).map((column) => <td key={column} className="border-r border-slate-200 px-3 py-2" />)}
      </tr>,
      ...(!collapsed ? renderTabularGroupTree(node.children) : []),
      ...(!collapsed && showDetailRows && node.children.length === 0 ? node.rows.slice(0, hasRun ? node.rows.length : 20).map((row, rowIndex) => <tr key={`${node.key}-detail-${rowIndex}`} className="border-b border-slate-200 hover:bg-muted/50">
        {rowGroups.map((field) => <td key={field} className="border-r border-slate-200 px-3 py-2" />)}
        {result?.columns.map((column) => <td key={column} className="border-r border-slate-200 px-3 py-2">{formatReportCell(selectedObject, column, row[column])}</td>)}
      </tr>) : []),
      ...(showSubtotals && node.children.length === 0 ? [<tr key={`${node.key}-subtotal`} className="border-b bg-muted/50 font-semibold"><td colSpan={rowGroups.length + (result?.columns.length || 0)} className="px-3 py-2 text-right">Subtotal: {node.count}</td></tr>] : []),
    ];
  });
  const renderSummaryGroupRows = (nodes: GroupTreeNode[]): React.ReactElement[] => nodes.flatMap((node) => {
    if (node.children.length) return renderSummaryGroupRows(node.children);
    return [
      <tr key={`${node.key}-summary`} className="border-b border-slate-200 hover:bg-muted/50">
        {rowGroups.map((field) => <td key={field} className="border-r border-slate-200 px-3 py-2 text-primary">{node.values[field] ? (isSiteVisitStatusColumn(selectedObject, field) ? siteVisitStatusLabel(node.values[field]) : node.values[field]) : "(Blank)"}</td>)}
        {showRowCounts && <td className="border-r border-slate-200 px-3 py-2 text-center">{node.count}</td>}
      </tr>,
    ];
  });

  if (loading)
    return (
      <div className="flex min-h-[520px] items-center justify-center text-sm text-muted-foreground">
        Loading report builder...
      </div>
    );

  return (
    <div className="-m-4 flex min-h-[calc(100vh-64px)] flex-col bg-background md:-m-6">
      <header className="border-b border-slate-200 bg-white">
        <div className="flex min-h-[104px] flex-wrap items-center justify-between gap-5 px-6 py-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Button variant="ghost" size="icon" asChild className="shrink-0">
              <Link href={editingReportId ? `/reports/${encodeURIComponent(editingReportId)}` : "/reports"} aria-label="Back to reports">
                <ArrowLeft className="h-5 w-5" />
              </Link>
            </Button>

            <div className="flex min-w-0 items-center gap-5">
              <div className="flex items-center gap-2 text-lg font-bold uppercase text-primary">
                <span>Report</span>
                <ChevronDown className="h-3.5 w-3.5" />
              </div>

              <div className="flex min-w-0 items-center gap-4">
                <h1 className="truncate text-xl font-semibold tracking-tight text-slate-900">
                  {reportName || "Untitled Report"}
                </h1>
                <span className="shrink-0 rounded-lg bg-slate-200 px-4 py-2 text-base font-semibold text-slate-600">
                  {object?.name || "Select a Report Type"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
            <div className="flex overflow-hidden rounded-full border border-slate-400 px-1">
              <Button key={`undo-${historyVersion}`} variant="ghost" size="icon" aria-label="Undo" title="Undo" onClick={undoBuilderChange} disabled={historyRef.current.length === 0}><Undo2 className="h-4 w-4" /></Button>
              <Button key={`redo-${historyVersion}`} variant="ghost" size="icon" aria-label="Redo" title="Redo" className="border-l" onClick={redoBuilderChange} disabled={futureRef.current.length === 0}><Redo2 className="h-4 w-4" /></Button>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-slate-400 bg-slate-50 px-1.5">
              <Button type="button" variant="ghost" size="sm" className="h-8 rounded-full px-2 text-xs" onClick={() => { setLeftPanelCollapsed(true); }} title="Minimize left panel (Alt+0)">
                <PanelLeftClose className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-8 rounded-full px-2 text-xs" onClick={() => { setLeftPanelCollapsed(false); setLeftPanelWidth(420); }} title="Maximize left panel (Alt+2)">
                <PanelLeftOpen className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 rounded-md px-4 text-[13px]"
              onClick={() => {
                if (editingReportId) {
                  void saveReport();
                } else {
                  setSaveOpen(true);
                }
              }}
              disabled={saving || running || !selectedFields.length}
            >Save &amp; Run</Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-md px-4 text-[13px]"
              onClick={() => {
                if (editingReportId) {
                  void saveReport();
                } else {
                  setSaveOpen(true);
                }
              }}
              disabled={saving || !selectedFields.length}
            >
              Save {!editingReportId && <ChevronDown className="ml-2 h-3.5 w-3.5" />}
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-9 rounded-md px-4 text-[13px]" onClick={closeReportBuilder}>Close</Button>
            <Button type="button" size="sm" className="h-9 rounded-md bg-primary px-4 text-[13px] hover:bg-primary/90" onClick={runAndPreviewReport} disabled={running || !selectedFields.length}><Play className="mr-2 h-4 w-4" />{running ? "Running..." : "Run"}</Button>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside
          className={`relative shrink-0 border-b bg-white transition-all duration-200 ease-out lg:border-b-0 lg:border-r ${leftPanelCollapsed ? "hidden lg:block lg:w-0 lg:overflow-hidden lg:border-r-0" : "w-full lg:w-auto"}`}
          style={
            leftPanelCollapsed
              ? { width: 0, minWidth: 0, maxWidth: 0 }
              : {
                  minWidth: 260,
                  width: leftPanelWidth,
                  fontSize: `${panelTextSize}px`,
                }
          }
        >
          {!leftPanelCollapsed && (
            <div
              aria-label="Resize left panel"
              title="Drag to resize or use Alt + arrow keys"
              onMouseDown={handleLeftPanelResize}
              className="absolute -right-1 top-0 z-20 hidden h-full w-3 cursor-col-resize items-center justify-center lg:flex"
            >
              <GripVertical className="h-4 w-4 text-slate-400" />
            </div>
          )}
          <div className="flex min-h-16 items-center justify-between border-b px-6 py-3">
            <span className="font-semibold uppercase tracking-wide text-slate-500" style={{ fontSize: `${panelTextSize + 1}px` }}>
              Fields
            </span>
            <div className="flex items-center gap-2" style={{ fontSize: `${panelTextSize - 1}px` }}>
              <button
                type="button"
                className="text-xs text-primary"
                onClick={() => setFieldSearch("")}
              >
                Reset
              </button>
              <button
                type="button"
                className="text-[10px] font-medium uppercase tracking-wide text-slate-500"
                onClick={() => setLeftPanelCollapsed((current) => !current)}
              >
                {leftPanelCollapsed ? "Expand" : "Minimize"}
              </button>
            </div>
          </div>
          <div className="flex border-b">
            <button
              className={`flex-1 px-4 py-5 font-semibold ${panel === "outline" ? "border-b-4 border-primary text-slate-700" : "text-slate-500"}`}
              style={{ fontSize: `${panelTextSize + 2}px` }}
              onClick={() => setPanel("outline")}
            >
              <span className="mr-1 text-base">☷</span>Outline
            </button>
            <button
              className={`flex-1 px-4 py-5 font-semibold ${panel === "filters" ? "border-b-4 border-primary text-slate-700" : "text-slate-500"}`}
              style={{ fontSize: `${panelTextSize + 2}px` }}
              onClick={() => setPanel("filters")}
            >
              <Filter className="mr-1 inline h-3.5 w-3.5" />
              Filters{" "}
              {validFilters.length > 0 && (
                <Badge className="ml-1 h-6 min-w-6 justify-center rounded-md bg-primary px-1.5 text-white">{validFilters.length}</Badge>
              )}
            </button>
          </div>
          {panel === "outline" ? (
            <div className="max-h-[calc(100vh-180px)] overflow-y-auto px-4 py-4">
              <section className="relative mb-7">
                <div className="mb-4 flex items-center justify-between text-lg font-semibold text-slate-500">
                  <span>Groups</span>
                  <button
                    type="button"
                    aria-label="Clear groups"
                    onClick={() => {
                      setRowGroups([]);
                      setColumnGroups([]);
                      setGroupBy("");
                      setGroupColumn("");
                      setRowGroupSearch("");
                      setColumnGroupSearch("");
                      setRowGroupPickerOpen(false);
                      setColumnGroupPickerOpen(false);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-slate-500">
                  <span className="text-base text-slate-500">▤</span> Group Rows
                </div>
                <div ref={rowGroupPickerRef} className="relative">
                  <div
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => handleGroupDrop(event, "rows")}
                    className={`flex h-9 items-center rounded-md border bg-white ${rowGroupPickerOpen ? "border-primary ring-1 ring-primary/20" : "border-slate-300"}`}
                  >
                    <Search className="ml-2.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                    value={rowGroupSearch}
                    onFocus={() => setRowGroupPickerOpen(true)}
                    onChange={(event) => setRowGroupSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRowGroupPickerOpen(false);
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setRowGroupHighlight((current) => Math.min(current + 1, Math.max(visibleRowGroupFields.length - 1, 0)));
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setRowGroupHighlight((current) => Math.max(current - 1, 0));
                      }
                      if (event.key === "Enter" && visibleRowGroupFields[rowGroupHighlight]) {
                        event.preventDefault();
                        addRowGroup(visibleRowGroupFields[rowGroupHighlight].key);
                        setRowGroupSearch("");
                      }
                    }}
                    placeholder="Add group..."
                    aria-label="Search row group fields"
                    className="h-8 min-w-0 flex-1 bg-transparent px-2 text-xs outline-none"
                  />
                  </div>
                </div>
                {rowGroupPickerOpen && (
                  <div data-group-picker="rows" className="absolute z-50 mt-1 max-h-56 w-[calc(100%-1.5rem)] overflow-y-auto rounded-md border bg-white p-1 shadow-lg">
                    {!rowGroupSearch && <div className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Available Fields</div>}
                    {visibleRowGroupFields.length === 0 ? <div className="px-2 py-2 text-xs text-muted-foreground">No matching fields</div> : visibleRowGroupFields.map((field) => (
                      <button key={field.key} type="button" draggable onDragStart={(event) => { event.dataTransfer.setData("text/plain", field.key); event.dataTransfer.setData("group-axis", "fields"); }} onMouseDown={(event) => { event.preventDefault(); addRowGroup(field.key); setRowGroupSearch(""); }} className={`flex w-full items-center rounded px-2 py-1.5 text-left text-xs ${visibleRowGroupFields[rowGroupHighlight]?.key === field.key ? "bg-primary/10" : "hover:bg-primary/10"}`}><span>{field.label}</span></button>
                    ))}
                  </div>
                )}
                {rowGroups.map((field, index) => (
                  <div
                    key={field}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", field);
                      event.dataTransfer.setData("group-axis", "rows");
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const draggedField = event.dataTransfer.getData("text/plain");
                      const from = event.dataTransfer.getData("group-axis") as "rows" | "columns";
                      if (draggedField && from === "rows") reorderGroup(draggedField, "rows", index);
                      if (draggedField && from === "columns") moveGroupBetweenAxes(draggedField, from, "rows");
                    }}
                    className="group mb-2 flex min-h-10 items-center justify-between rounded-lg border border-transparent bg-slate-100 px-3 py-2 text-sm text-[#5c211d] transition-colors hover:bg-slate-200"
                  >
                    <span className="min-w-0 truncate">{fieldLabel(field)}</span>
                    <button
                      title="Remove group"
                      type="button"
                      onClick={() => removeRowGroup(field)}
                      aria-label={`Remove ${fieldLabel(field)} row group`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {rowGroups.length > 0 && <div className="mb-3 mt-8 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-slate-500">
                  <span className="text-base text-slate-500">▥</span> Group Columns
                </div>}
                {rowGroups.length > 0 && <>
                <div ref={columnGroupPickerRef} className="relative">
                  <div
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => handleGroupDrop(event, "columns")}
                    className={`flex h-9 items-center rounded-md border bg-white ${columnGroupPickerOpen ? "border-primary ring-1 ring-primary/20" : "border-slate-300"}`}
                  >
                    <Search className="ml-2.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                    value={columnGroupSearch}
                    onFocus={() => setColumnGroupPickerOpen(true)}
                    onChange={(event) => setColumnGroupSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setColumnGroupPickerOpen(false);
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setColumnGroupHighlight((current) => Math.min(current + 1, Math.max(visibleColumnGroupFields.length - 1, 0)));
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setColumnGroupHighlight((current) => Math.max(current - 1, 0));
                      }
                      if (event.key === "Enter" && visibleColumnGroupFields[columnGroupHighlight]) {
                        event.preventDefault();
                        addColumnGroup(visibleColumnGroupFields[columnGroupHighlight].key);
                        setColumnGroupSearch("");
                      }
                    }}
                    placeholder="Add group..."
                    aria-label="Search column group fields"
                    className="h-8 min-w-0 flex-1 bg-transparent px-2 text-xs outline-none"
                  />
                  </div>
                </div>
                {columnGroupPickerOpen && (
                  <div data-group-picker="columns" className="absolute z-50 mt-1 max-h-56 w-[calc(100%-1.5rem)] overflow-y-auto rounded-md border bg-white p-1 shadow-lg">
                    {!columnGroupSearch && <div className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Available Fields</div>}
                    {visibleColumnGroupFields.length === 0 ? <div className="px-2 py-2 text-xs text-muted-foreground">No matching fields</div> : visibleColumnGroupFields.map((field) => (
                      <button key={field.key} type="button" draggable onDragStart={(event) => { event.dataTransfer.setData("text/plain", field.key); event.dataTransfer.setData("group-axis", "fields"); }} onMouseDown={(event) => { event.preventDefault(); addColumnGroup(field.key); setColumnGroupSearch(""); }} className={`flex w-full items-center rounded px-2 py-1.5 text-left text-xs ${visibleColumnGroupFields[columnGroupHighlight]?.key === field.key ? "bg-primary/10" : "hover:bg-primary/10"}`}><span>{field.label}</span></button>
                    ))}
                  </div>
                )}
                {columnGroups.map((field, index) => (
                  <div
                    key={field}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", field);
                      event.dataTransfer.setData("group-axis", "columns");
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const draggedField = event.dataTransfer.getData("text/plain");
                      const from = event.dataTransfer.getData("group-axis") as "rows" | "columns";
                      if (draggedField && from === "columns") reorderGroup(draggedField, "columns", index);
                      if (draggedField && from === "rows") moveGroupBetweenAxes(draggedField, from, "columns");
                    }}
                    className="group mb-2 flex min-h-10 items-center justify-between rounded-lg border border-transparent bg-slate-100 px-3 py-2 text-sm text-[#5c211d] transition-colors hover:bg-slate-200"
                  >
                    <span className="min-w-0 truncate">{fieldLabel(field)}</span>
                    <button type="button" onClick={() => removeColumnGroup(field)} aria-label={`Remove ${fieldLabel(field)} column group`}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                </>}
              </section>
              <section className="mb-4 border-t border-slate-300 pt-7">
                <div className="mb-3 flex items-center justify-between text-lg font-semibold text-slate-500">
                  <span>Columns ({selectedFields.length})</span>
                  <button
                    className="text-primary"
                    onClick={clearSelectedFields}
                  >
                    Clear
                  </button>
                </div>
                <div ref={columnPickerRef} className="relative">
                  <div className={`flex h-9 items-center rounded-md border bg-white ${columnPickerOpen ? "border-primary ring-1 ring-primary/20" : "border-slate-300"}`}>
                    <Search className="ml-2.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <input
                      value={fieldSearch}
                      onFocus={() => setColumnPickerOpen(true)}
                      onChange={(event) => setFieldSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setColumnPickerOpen(false);
                      }}
                      placeholder="Add column..."
                      aria-label="Search columns"
                      className="h-8 min-w-0 flex-1 bg-transparent px-2 text-xs outline-none"
                    />
                  </div>
                  {columnPickerOpen && (
                  <div data-column-picker="columns" className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-white p-1 shadow-lg">
                    {!fieldSearch && <div className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Available Fields</div>}
                    {visibleFields.filter((field) => !selectedFields.includes(field.key)).length === 0 ? <div className="px-2 py-2 text-xs text-muted-foreground">No matching fields</div> : visibleFields.filter((field) => !selectedFields.includes(field.key)).map((field) => (
                      <button
                        key={field.key}
                        type="button"
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/plain", field.key);
                          event.dataTransfer.setData("group-axis", "fields");
                        }}
                        onClick={() => {
                          toggleField(field.key);
                          setFieldSearch("");
                          setColumnPickerOpen(false);
                        }}
                        className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-primary/10"
                      >
                        <span>{field.label}</span>
                      </button>
                    ))}
                  </div>
                  )}
                </div>
                {selectedFields.map((key) => (
                  <div key={key} className="mb-2 rounded-lg border border-transparent bg-slate-100 px-3 py-2 text-sm text-[#5c211d]">
                    <div className="flex items-center justify-between gap-1">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{columnLabel(key)}</span>
                      <button type="button" onClick={() => toggleField(key)} aria-label={`Remove ${fieldLabel(key)}`}><X className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                ))}
                {selectedFields.length === 0 && !fieldSearch && (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    Add columns from the search above.
                  </p>
                )}
              </section>
            </div>
          ) : (
            <div className="max-h-[calc(100vh-180px)] overflow-y-auto p-2">
              <div className="relative mb-4 flex items-center justify-between px-1">
                <div>
                  <h3 className="text-base font-semibold text-slate-500">Filters</h3>
                  <p className="text-xs text-muted-foreground">{filterSummary}</p>
                </div>
                <button type="button" onClick={() => setFilterActionsOpen((current) => !current)} aria-label="Filter actions" className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-slate-500 text-primary hover:bg-muted/50">
                  <ChevronDown className={`h-4 w-4 transition-transform ${filterActionsOpen ? "rotate-180" : ""}`} />
                </button>
                  {filterActionsOpen && <div className="absolute right-0 top-11 z-50 w-52 rounded-lg border bg-white p-1 shadow-lg">
                    <button type="button" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted/50" onClick={() => { setFilterActionsOpen(false); setCrossFilterEditorOpen(true); }}>Add Cross Filter</button>
                    <button type="button" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted/50" onClick={() => { setFilterActionsOpen(false); setRowLimitEditorOpen(true); }}>Add Row Limit</button>
                </div>}
              </div>
              {rowLimitEditorOpen && (
                <div className="mb-3 rounded-lg border-2 border-blue-500 bg-white p-2.5">
                  <div className="flex items-center justify-between text-sm font-medium text-slate-600"><span>Row Limit</span><button type="button" onClick={() => { setRowLimitEditorOpen(false); setRowLimit(10000); }} aria-label="Remove row limit"><Trash2 className="h-4 w-4 text-red-500" /></button></div>
                  <input type="number" min={1} max={10000} value={rowLimit} onChange={(event) => setRowLimit(Math.max(1, Math.min(10000, Number(event.target.value) || 1)))} className="mt-1 h-9 w-full rounded border bg-white px-2 text-sm text-slate-700" aria-label="Row limit" />
                </div>
              )}
              {crossFilterEditorOpen && (
                <div className="mb-3 rounded-lg border bg-muted/50 p-3">
                  <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-600"><span>Cross Filter</span><button type="button" onClick={() => setCrossFilterEditorOpen(false)} aria-label="Close cross filter"><X className="h-4 w-4" /></button></div>
                  <select value={crossFilterObject} onChange={(event) => setCrossFilterObject(event.target.value)} className="mb-2 h-9 w-full rounded border bg-white px-2 text-sm">
                    <option value="">Select a related object</option>
                    {(crossFilterRelations[selectedObject] || []).map((relation) => <option key={relation} value={relation}>{relation}</option>)}
                  </select>
                  <select value={crossFilterMode} onChange={(event) => setCrossFilterMode(event.target.value as "with" | "without")} className="h-9 w-full rounded border bg-white px-2 text-sm">
                    <option value="with">With related records</option>
                    <option value="without">Without related records</option>
                  </select>
                </div>
              )}
              {crossFilterObject && <div className="mb-2 flex items-center justify-between rounded-lg border-2 border-slate-300 bg-white px-3 py-2.5 text-sm"><span><span className="block font-medium text-slate-500">Cross Filter</span><span className="text-[#5c211d]">{crossFilterMode === "with" ? "With" : "Without"} {crossFilterObject}</span></span><button type="button" onClick={() => { setCrossFilterObject(""); setCrossFilterEditorOpen(false); }} aria-label="Remove cross filter"><Trash2 className="h-4 w-4 text-red-500" /></button></div>}
              <div ref={filterFieldPickerRef} className="relative mb-3">
                <div className={`flex h-9 items-center rounded-md border bg-white ${filterFieldPickerOpen ? "border-primary ring-1 ring-primary/20" : "border-slate-300"}`}>
                  <Search className="ml-3 h-4 w-4 text-muted-foreground" />
                  <input
                    value={filterFieldPicker}
                    onFocus={() => setFilterFieldPickerOpen(true)}
                    onChange={(event) => { setFilterFieldPicker(event.target.value); setFilterFieldPickerOpen(true); }}
                    onKeyDown={(event) => { if (event.key === "Escape") setFilterFieldPickerOpen(false); }}
                    placeholder="Add filter..."
                    aria-label="Add filter"
                    className="h-9 min-w-0 flex-1 bg-transparent px-2 text-base text-slate-600 outline-none"
                  />
                </div>
                {filterFieldPickerOpen && (
                  <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border bg-white p-1 shadow-lg">
                    {fields.filter((field) => `${field.label} ${field.key}`.toLowerCase().includes(filterFieldPicker.toLowerCase())).length === 0 ? <div className="px-3 py-3 text-sm text-muted-foreground">No fields found</div> : Object.entries(fields.filter((field) => `${field.label} ${field.key}`.toLowerCase().includes(filterFieldPicker.toLowerCase())).reduce<Record<string, Field[]>>((groups, field) => {
                      const category = field.type.toLowerCase().includes("date") ? "DATE FIELDS" : field.type.toLowerCase() === "enum" ? "PICKLIST FIELDS" : "GENERAL FIELDS";
                      (groups[category] ||= []).push(field);
                      return groups;
                    }, {})).map(([category, categoryFields]) => <div key={category}>
                      <div className="px-3 py-2 text-[11px] font-bold tracking-wide text-slate-500">{category}</div>
                      {categoryFields.map((field) => <button key={field.key} type="button" onMouseDown={(event) => { event.preventDefault(); addFilter(field.key); setFilterFieldPicker(""); setFilterFieldPickerOpen(false); }} className="flex w-full items-center rounded px-3 py-2 text-left text-sm hover:bg-primary/10">{field.label}</button>)}
                    </div>)}
                  </div>
                )}
              </div>
              <div className="mb-2 rounded-lg border-2 border-slate-300 bg-white px-4 py-2.5">
                <label className="block text-sm text-slate-500">Show Me
                  <select value={showMe} onChange={(event) => setShowMe(event.target.value as "all" | "mine")} className="h-9 mt-0.5 block w-full appearance-none bg-transparent text-base font-medium text-[#5c211d] outline-none">
                    <option value="all">All records</option>
                    <option value="mine">My records</option>
                  </select>
                </label>
              </div>
              {filters.length === 0 && (
                <p className="rounded-md border border-dashed bg-muted/50 p-3 text-xs text-muted-foreground">
                  No filters. All records will be included.
                </p>
              )}
              {filters.map((filter, index) => (
                <div
                  key={index}
                  className="mb-2 cursor-pointer rounded-lg border-2 border-slate-300 bg-white p-2.5 shadow-sm transition hover:border-primary"
                  onClick={() => openFilterEditor(filter.field, index)}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-muted-foreground">
                    <span className="truncate text-sm font-semibold text-slate-500">{index + 1}. {fieldLabel(filter.field)}</span>
                    <button
                      type="button"
                      onClick={(event) => { event.stopPropagation(); setFilters((current) => current.filter((_, itemIndex) => itemIndex !== index)); setFilterExpression(""); }}
                      aria-label="Remove filter"
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </button>
                  </div>
                  <div className="mt-1 text-sm font-medium text-[#5c211d]">{filter.operator === "customRange" && typeof filter.value === "object" ? `${formatCustomDate(filter.value.start)} - ${formatCustomDate(filter.value.end)}` : relativeDateOperators.some((operator) => operator.value === filter.operator) ? relativeDateSummary(filter.operator) : `${operatorLabels[filter.operator] || filter.operator}${filter.operator !== "isBlank" && filter.operator !== "isNotBlank" ? ` ${formatFilterValue(filter.field, filter.value)}` : ""}`}</div>
                </div>
              ))}
              {filterEditorOpen && filterEditorIndex === null && filterDraft && (
                <div className="mb-2 rounded-lg border-2 border-blue-500 bg-white px-3 py-2.5 shadow-sm">
                  <div className="flex items-center justify-between text-sm font-medium text-slate-500">
                    <span>{fieldLabel(filterDraft.field)}</span>
                    <span className="text-blue-600">Editing</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-8 items-center justify-between border-b bg-slate-100 px-2 text-xs text-slate-700">
            <div className="flex min-w-0 items-center gap-2">
              {result && !hasRun && result.totalRows > 20 && <><span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-green-500 text-[11px] font-bold text-white">✓</span><span className="truncate font-semibold">Previewing a limited number of records. Run the report to see everything.</span></>}
            </div>
            <label className="ml-3 flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap">
              <span>Update Preview Automatically</span>
              <input type="checkbox" checked={autoPreview} onChange={(event) => setAutoPreview(event.target.checked)} className="peer sr-only" aria-label="Update Preview Automatically" />
              <span className="relative h-5 w-9 rounded-full bg-slate-400 transition-colors peer-checked:bg-red-500 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
            </label>
          </div>
          {error && (
            <div className="m-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto bg-white p-0">
            {!result ? (
              <div className="flex min-h-[330px] flex-col items-center justify-center text-center text-muted-foreground">
                <h2 className="text-lg font-semibold text-slate-700">
                  Preview your report
                </h2>
                <p className="mt-1 text-sm">
                  Choose fields and click Run to see results.
                </p>
              </div>
            ) : result.rows.length === 0 ? (
              <div className="flex min-h-[330px] items-center justify-center text-lg text-muted-foreground">
                No results found
              </div>
            ) : rowGroups.length > 0 && !columnGroups.length ? (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-700">Summary</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">Grouped by {rowGroups.map(fieldLabel).join(" · ")}</p>
                  </div>
                  <Badge variant="secondary">{result.totalRows} records</Badge>
                </div>
                <div className="overflow-x-auto rounded-sm border border-slate-300">
                  <table className="w-full min-w-[900px] border-collapse text-left text-sm">
                    <thead><tr className="border-b border-slate-300 bg-muted/50">
                      {rowGroups.map((field) => <th key={field} className="border-r border-slate-300 px-3 py-2 font-semibold text-primary">{fieldLabel(field)}</th>)}
                      {showDetailRows && result.columns.map((column) => <th key={column} className="border-r border-slate-300 px-3 py-2 font-semibold">{fieldLabel(column)}</th>)}
                      {!showDetailRows && showRowCounts && <th className="border-r border-slate-300 px-3 py-2 text-center font-semibold">Record Count</th>}
                    </tr></thead>
                    <tbody>
                      {showDetailRows ? renderTabularGroupTree(groupTree) : renderSummaryGroupRows(groupTree)}
                      {showGrandTotal && <tr className="bg-slate-100 font-semibold"><td colSpan={rowGroups.length + (showDetailRows ? result.columns.length : showRowCounts ? 1 : 0)} className="px-3 py-2">Grand Total: {result.totalRows} records</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : result.pivot ? (
              <div className="space-y-4">
                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-700">Summary</h3>
                      {result.pivot.aggregateLabel && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{result.pivot.aggregateLabel}</p>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">Grouped by {rowGroups.map(fieldLabel).join(" / ") || "rows"}</span>
                  </div>
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full min-w-[650px] border-collapse text-left text-sm">
                      <thead>
                        {columnGroups.length > 1 ? <>
                          <tr className="border-b bg-muted/50">
                            <th rowSpan={2} className="whitespace-nowrap px-3 py-2 font-semibold">{rowGroups.map(fieldLabel).join(" / ") || "Group"}</th>
                            {pivotColumnHeaders.reduce<{ label: string; span: number }[]>((headers, column) => {
                              const existing = headers.find((header) => header.label === column.primary);
                              if (existing) existing.span += 1;
                              else headers.push({ label: column.primary, span: 1 });
                              return headers;
                            }, []).map((header) => <th key={header.label} colSpan={header.span} className="whitespace-nowrap border-l px-3 py-2 text-center font-semibold">{header.label}</th>)}
                            {showSubtotals && <th rowSpan={2} className="whitespace-nowrap px-3 py-2 text-center font-semibold">Total</th>}
                          </tr>
                          <tr className="border-b bg-muted/80">{pivotColumnHeaders.map((column) => <th key={column.label} className="whitespace-nowrap border-l px-3 py-1.5 text-center text-xs font-medium text-muted-foreground">{column.secondary}</th>)}</tr>
                        </> : <tr className="border-b bg-muted/50">
                          <th className="whitespace-nowrap px-3 py-2 font-semibold">{rowGroups.map(fieldLabel).join(" / ") || "Group"}</th>
                          {result.pivot.columns.map((column) => <th key={column} className="whitespace-nowrap px-3 py-2 text-center font-semibold">{column}</th>)}
                          {showSubtotals && <th className="whitespace-nowrap px-3 py-2 text-center font-semibold">Total</th>}
                        </tr>}
                      </thead>
                      <tbody>
                        {result.pivot.rows.map((row, rowIndex) => {
                          const total = result.pivot!.columns.reduce((sum, column) => sum + Number(row.values[column] || 0), 0);
                          const rowKey = `pivot-${row.group}-${rowIndex}`;
                          const collapsed = Boolean(collapsedGroups[rowKey]);
                          return <React.Fragment key={rowKey}><tr className="border-b hover:bg-muted/50"><td className="px-3 py-2 font-medium text-primary"><button type="button" onClick={() => setCollapsedGroups((current) => ({ ...current, [rowKey]: !collapsed }))} className="mr-1 text-[11px]" aria-label={`${collapsed ? "Expand" : "Collapse"} ${row.group}`}>{collapsed ? "▶" : "▼"}</button>{rowGroups.map((field) => row.groupValues?.[field] || "(Blank)").join(" / ") || row.group}{showRowCounts && <span className="ml-1 font-normal text-muted-foreground">({total})</span>}</td>{result.pivot!.columns.map((column) => <td key={column} className="px-3 py-2 text-center">{row.values[column] || 0}</td>)}{showSubtotals && <td className="px-3 py-2 text-center font-semibold">{total}</td>}</tr></React.Fragment>;
                        })}
                        {showGrandTotal && <tr className="bg-muted/50 font-semibold">
                          <td className="px-3 py-2">Total</td>
                          {result.pivot.columns.map((column) => <td key={column} className="px-3 py-2 text-center">{result.pivot!.rows.reduce((sum, row) => sum + Number(row.values[column] || 0), 0)}</td>)}
                          {showSubtotals && <td className="px-3 py-2 text-center">{result.pivot.rows.reduce((sum, row) => sum + Object.values(row.values).reduce((rowSum, value) => rowSum + Number(value || 0), 0), 0)}</td>}
                        </tr>}
                      </tbody>
                    </table>
                  </div>
                </section>
                {showDetailRows && <section>
                  <div className="mb-2 flex items-center gap-2 border-t pt-3">
                    <h3 className="text-sm font-semibold text-slate-700">Details</h3>
                    <Badge variant="secondary">{result.totalRows} Rows</Badge>
                  </div>
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full min-w-[650px] border-collapse text-left text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50">
                          {result.columns.map((column) => <th key={column} className="whitespace-nowrap px-3 py-2 font-semibold">{fieldLabel(column)}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.slice(0, hasRun ? result.rows.length : 20).map((row, index) => <tr key={index} className="border-b hover:bg-muted/50">{result.columns.map((column) => <td key={column} className="whitespace-nowrap px-3 py-2">{formatReportCell(selectedObject, column, row[column])}</td>)}</tr>)}
                      </tbody>
                    </table>
                  </div>
                </section>}
              </div>
            ) : (
              <table className="w-full min-w-[650px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {result.columns.map((column) => (
                      <th
                        key={column}
                        className="whitespace-nowrap px-3 py-2 font-semibold"
                      >
                        {fieldLabel(column)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groupBy && result.groups?.length
                    ? result.groups.flatMap((group, groupIndex) => [
                        <tr key={`group-${groupIndex}`} className="bg-primary/5">
                          <td colSpan={result.columns.length} className="px-3 py-2 font-semibold text-primary">
                            {rowGroups.map((field) => formatGroupedValue(field, group.groupValues?.[field] || "Unknown")).join(" / ") || `${fieldLabel(groupBy)}: ${group.group}`} <span className="font-normal text-muted-foreground">({group.count} records)</span>
                          </td>
                        </tr>,
                        ...(showDetailRows ? (group.rows || []).slice(0, hasRun ? group.rows?.length : 20) : [null]).map((row, rowIndex) => (
                          <tr key={`group-${groupIndex}-row-${rowIndex}`} className="border-b hover:bg-muted/50">
                            {result.columns.map((column) => (
                              <td key={column} className="whitespace-nowrap px-3 py-2">
                                {formatReportCell(selectedObject, column, row?.[column])}
                              </td>
                            ))}
                          </tr>
                        )),
                      ])
                    : result.rows.slice(0, hasRun ? result.rows.length : 20).map((row, index) => (
                        <tr key={index} className="border-b hover:bg-muted/50">
                          {result.columns.map((column) => (
                            <td key={column} className="whitespace-nowrap px-3 py-2">
                              {formatReportCell(selectedObject, column, row[column])}
                            </td>
                          ))}
                        </tr>
                      ))}
                </tbody>
              </table>
            )}
          </div>
          {result?.columnGroups && result.columnGroups.length > 0 && (
            <div className="flex flex-wrap gap-2 border-t bg-muted/50 p-4">
              <span className="w-full text-xs font-semibold uppercase tracking-wide text-muted-foreground">Group Columns</span>
              {result.columnGroups.map((group) => <Badge key={group.group} variant="outline">{group.group}: {group.count}</Badge>)}
            </div>
          )}
        </main>
      </div>
      <footer className="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-3 border-t bg-white px-4 py-3 text-xs text-muted-foreground shadow-[0_-2px_8px_rgba(15,23,42,0.08)]">
        <div className="flex flex-wrap items-center gap-4">
          {hasGrouping && <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap">Row Counts<input type="checkbox" checked={showRowCounts} onChange={(event) => setShowRowCounts(event.target.checked)} className="h-4 w-4 accent-red-600" /></label>}
          {hasGrouping && <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap">Detail Rows<input type="checkbox" checked={showDetailRows} onChange={(event) => setShowDetailRows(event.target.checked)} className="h-4 w-4 accent-red-600" /></label>}
          {hasGrouping && <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap">Subtotals<input type="checkbox" checked={showSubtotals} onChange={(event) => setShowSubtotals(event.target.checked)} className="h-4 w-4 accent-red-600" /></label>}
          {hasGrouping && <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap">Grand Total<input type="checkbox" checked={showGrandTotal} onChange={(event) => setShowGrandTotal(event.target.checked)} className="h-4 w-4 accent-red-600" /></label>}
        </div>
        <span className="hidden lg:inline">
          {selectedFields.length} columns · {validFilters.length} filters ·{" "}
          {groupBy ? `Grouped by ${fieldLabel(groupBy)}` : "No grouping"}
          {groupColumn ? ` · Columns: ${fieldLabel(groupColumn)}` : ""}
        </span>
      </footer>
      {filterEditorOpen && filterDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-lg font-medium text-[#5c211d]">Filter by {fieldLabel(filterDraft.field)}</h2>
              <button type="button" onClick={() => setFilterEditorOpen(false)} aria-label="Close filter editor"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-4 p-5">
              <label className="block text-sm font-semibold text-slate-700">Field
                <div className="relative mt-1"><select value={filterDraft.field} onChange={(event) => setFilterDraft({ ...filterDraft, field: event.target.value, operator: fieldType(event.target.value).includes("date") ? "thisMonth" : "equals", value: "" })} className="h-9 w-full appearance-none rounded-md border border-slate-500 bg-white px-3 pr-10 text-sm">
                  {fields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
                </select><button type="button" onClick={() => setFilterEditorOpen(false)} aria-label="Clear selected field" className="absolute right-2 top-1/2 -translate-y-1/2 text-primary"><X className="h-5 w-5" /></button></div>
              </label>
              {fieldType(filterDraft.field).includes("date") ? <>
                <label className="block text-sm font-semibold text-slate-700">Range
                  <select value={filterDraft.operator} onChange={(event) => setFilterDraft({ ...filterDraft, operator: event.target.value, value: event.target.value === "customRange" ? { start: "", end: "" } : "" })} className="mt-1 h-9 w-full rounded-md border border-slate-500 bg-white px-3 text-sm">
                    {relativeDateOperators.map((operator) => <option key={operator.value} value={operator.value}>{operator.value === "customRange" ? "Custom" : operator.label}</option>)}
                  </select>
                </label>
                {filterDraft.operator === "customRange" ? <div className="space-y-3">
                  <label className="block text-sm font-semibold text-slate-700">Start Date<input type="date" value={typeof filterDraft.value === "object" ? filterDraft.value.start : ""} onChange={(event) => setFilterDraft({ ...filterDraft, value: { start: event.target.value, end: typeof filterDraft.value === "object" ? filterDraft.value.end : "" } })} className="mt-1 h-9 w-full rounded-md border border-slate-500 px-3 text-sm" /></label>
                  <label className="block text-sm font-semibold text-slate-700">End Date<input type="date" value={typeof filterDraft.value === "object" ? filterDraft.value.end : ""} onChange={(event) => setFilterDraft({ ...filterDraft, value: { start: typeof filterDraft.value === "object" ? filterDraft.value.start : "", end: event.target.value } })} className="mt-1 h-9 w-full rounded-md border border-slate-500 px-3 text-sm" /></label>
                </div> : <div className="flex items-center gap-2 text-sm font-semibold text-slate-700"><span>{relativeDateSummary(filterDraft.operator)}</span><button type="button" onClick={() => setFilterDraft({ ...filterDraft, operator: "customRange", value: { start: "", end: "" } })} className="text-primary">Customize</button></div>}
              </> : <label className="block text-sm font-semibold text-slate-700">Operator
                <select value={filterDraft.operator} onChange={(event) => setFilterDraft({ ...filterDraft, operator: event.target.value, value: "" })} className="mt-1 h-9 w-full rounded-md border border-slate-500 bg-white px-3 text-sm">
                  <optgroup label="Comparison">{getAvailableOperators(fieldType(filterDraft.field)).map((operator) => <option key={operator} value={operator}>{operatorLabels[operator] || operator}</option>)}</optgroup>
                </select>
              </label>}
              {!['isBlank', 'isNotBlank', ...relativeDateOperators.map((item) => item.value)].includes(filterDraft.operator) && (
                filterDraft.operator === "customRange" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <input type="date" value={typeof filterDraft.value === "object" ? filterDraft.value.start : ""} onChange={(event) => setFilterDraft({ ...filterDraft, value: { start: event.target.value, end: typeof filterDraft.value === "object" ? filterDraft.value.end : "" } })} className="h-9 rounded-md border border-slate-500 px-3 text-sm" />
                    <input type="date" value={typeof filterDraft.value === "object" ? filterDraft.value.end : ""} onChange={(event) => setFilterDraft({ ...filterDraft, value: { start: typeof filterDraft.value === "object" ? filterDraft.value.start : "", end: event.target.value } })} className="h-9 rounded-md border border-slate-500 px-3 text-sm" />
                  </div>
                ) : fieldType(filterDraft.field) === "enum" ? (
                  <select value={typeof filterDraft.value === "object" ? "" : filterDraft.value} onChange={(event) => setFilterDraft({ ...filterDraft, value: event.target.value })} className="h-9 w-full rounded-md border border-slate-500 bg-white px-3 text-[13px]">
                    <option value="">Select a value</option>
                    {picklistValues.map((value) => (
                      <option key={value} value={value}>
                        {selectedObject === "Lead" && filterDraft.field === "status" ? getLeadStatusLabel(value) : value}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input type={fieldType(filterDraft.field).includes("number") ? "number" : fieldType(filterDraft.field).includes("date") ? "date" : "text"} value={typeof filterDraft.value === "object" ? "" : filterDraft.value} onChange={(event) => setFilterDraft({ ...filterDraft, value: event.target.value })} placeholder="Enter a value" className="h-9 w-full rounded-md border border-slate-500 px-3 text-[13px]" autoFocus />
                )
              )}
              {relativeDateOperators.some((operator) => operator.value === filterDraft.operator) && <div className="rounded border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">The date range is calculated from today when the report runs.</div>}
              <div className="flex justify-end gap-2 border-t bg-muted/50 pt-4"><Button type="button" variant="outline" onClick={() => setFilterEditorOpen(false)} className="rounded-md border-border text-primary">Cancel</Button><Button type="button" onClick={applyFilterDraft} className="rounded-md bg-primary px-4">Apply</Button></div>
            </div>
          </div>
        </div>
      )}
      {filterLogicOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-semibold">Edit Filter Logic</h2>
              <button
                onClick={() => setFilterLogicOpen(false)}
                aria-label="Close filter logic"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <p className="text-sm text-muted-foreground">Use filter numbers with AND, OR, NOT, and parentheses.</p>
              <textarea value={filterLogicDraft} onChange={(event) => { setFilterLogicDraft(event.target.value); setFilterLogicError(validateFilterExpression(event.target.value, validFilters.length) || ""); }} placeholder="Example: 1 AND (2 OR 3)" className={`min-h-28 w-full rounded border px-3 py-2 text-sm outline-none ${filterLogicError ? "border-red-500" : ""}`} />
              {filterLogicError && <p className="text-sm text-red-600">{filterLogicError}</p>}
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setFilterLogicOpen(false)}>Cancel</Button><Button disabled={Boolean(filterLogicError) || !filterLogicDraft.trim()} onClick={() => { const expression = filterLogicDraft.trim(); const errorMessage = validateFilterExpression(expression, validFilters.length); if (errorMessage) { setFilterLogicError(errorMessage); return; } setFilterExpression(expression); setFilterLogic(expression.includes("OR") ? "OR" : "AND"); setFilterLogicOpen(false); }}>Apply</Button></div>
            </div>
          </div>
        </div>
      )}
      {saveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4">
          <div className="w-full max-w-5xl overflow-hidden rounded-[22px] border border-slate-200 bg-background shadow-[0_20px_45px_rgba(15,23,42,0.15)]">
            <div className="flex items-center justify-center border-b border-slate-200 px-6 py-4">
              <h2 className="text-xl font-semibold tracking-tight text-slate-800">Save Report</h2>
            </div>

            <div className="space-y-5 p-6">
              <label className="block text-[12px] font-semibold text-slate-800">
                <span className="text-red-600">*</span> Report Name
                <input
                  value={reportName}
                  onChange={(event) => setReportName(event.target.value)}
                  placeholder="New Notes With leads Report"
                  className="mt-2 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-[13px] text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </label>

              <label className="block text-[12px] font-semibold text-slate-800">
                Report Unique Name
                <div className="relative mt-2">
                  <input
                    value={reportUniqueName}
                    onChange={(event) => setReportUniqueName(event.target.value)}
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-[13px] text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                  <span className="absolute right-3 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-red-600 text-[11px] font-bold text-white">
                    i
                  </span>
                </div>
              </label>

              <label className="block text-[12px] font-semibold text-slate-800">
                Report Description
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={4}
                  className="mt-2 h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </label>

              <div className="block text-[12px] font-semibold text-slate-800">
                <span>Folder</span>
                <div className="mt-2 flex gap-3">
                  <input
                    value={selectedFolderName}
                    readOnly
                    placeholder="Private Reports"
                    className="h-9 flex-1 rounded-md border border-slate-300 bg-white px-3 text-[13px] text-slate-800 outline-none"
                  />
                  <button
                    type="button"
                    onClick={openFolderPicker}
                    className="h-9 min-w-[110px] rounded-md border border-red-500 bg-white px-3 text-[13px] font-medium text-red-600 transition hover:bg-red-50"
                  >
                    Select Folder
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 bg-background px-6 py-4">
              <button
                type="button"
                onClick={openFolderPicker}
                className="h-9 min-w-[110px] rounded-md border border-slate-300 bg-white px-3 text-[13px] font-medium text-slate-700 transition hover:bg-muted/50"
              >
                New Folder
              </button>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setSaveOpen(false)}
                  className="h-9 min-w-[96px] rounded-md border border-slate-300 bg-white px-3 text-[13px] font-medium text-slate-700 transition hover:bg-muted/50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void saveReport()}
                  disabled={saving}
                  className="h-9 min-w-[96px] rounded-md bg-red-600 px-3 text-[13px] font-medium text-white shadow-sm transition hover:bg-red-700 disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showFolderPicker && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/40 p-3 sm:p-6">
          <div className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-md border border-slate-300 bg-background shadow-[0_24px_70px_rgba(15,23,42,0.28)] sm:max-h-[calc(100vh-3rem)]">
            <div className="flex shrink-0 items-center justify-center border-b border-slate-300 bg-white px-6 py-5">
              <h2 className="text-xl font-semibold tracking-tight text-slate-800">Select Folder</h2>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
              <div className="mx-auto mb-5 w-full rounded-lg border border-slate-300 bg-white px-4 py-3 shadow-sm">
                <div className="flex h-8 items-center gap-3">
                  <Search className="h-5 w-5 shrink-0 text-slate-500" />
                  <input
                    value={folderPickerSearch}
                    onChange={(event) => setFolderPickerSearch(event.target.value)}
                    placeholder="Search folders..."
                    className="h-9 w-full border-0 bg-transparent text-base text-slate-700 placeholder:text-slate-400 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid min-h-[420px] grid-cols-1 overflow-hidden rounded-md border border-slate-300 bg-white shadow-sm md:grid-cols-[260px_minmax(0,1fr)]">
                <div className="border-b border-border bg-muted/50 p-2 md:border-b-0 md:border-r">
                  {[
                    { key: "all", label: "All Folders" },
                    { key: "createdByMe", label: "Created by Me" },
                  ].map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => { setFolderPickerCategory(tab.key as "all" | "createdByMe"); setFolderPickerSearch(""); }}
                      className={`flex min-h-9 w-full items-center justify-between rounded-md px-3 py-2 text-left text-[13px] font-medium transition ${folderPickerCategory === tab.key ? "bg-white text-primary shadow-sm" : "text-slate-700 hover:bg-white/70"}`}
                    >
                      <span>{tab.label}</span>
                      <span className="text-slate-400">›</span>
                    </button>
                  ))}
                </div>

                <div className="min-w-0 bg-white p-0">
                  {filteredPickerFolders.length === 0 ? (
                    <div className="flex min-h-[360px] items-center justify-center text-base text-slate-500">
                      No folders found
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-200">
                      {filteredPickerFolders.map((folder) => (
                        <button
                          key={folder.id}
                          type="button"
                          onClick={() => {
                            setPendingFolderId(folder.id);
                          }}
                          className={`flex min-h-20 w-full items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 text-left transition hover:bg-muted/50 ${pendingFolderId === folder.id ? "bg-blue-50 ring-2 ring-inset ring-blue-500" : ""}`}
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex h-5 w-5 items-center justify-center rounded-sm bg-slate-200 text-[11px] text-slate-600">
                              <span>▣</span>
                            </div>
                            <span className="truncate text-lg font-semibold text-red-700 sm:text-xl">{folder.name}</span>
                          </div>
                          <span className="text-slate-400">›</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 flex-col gap-3 border-t border-slate-200 bg-background px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <button
                type="button"
                onClick={() => { setNewFolderName(""); setNewFolderUniqueName(""); setNewFolderDialogOpen(true); }}
                className="h-9 rounded-md border border-slate-300 bg-white px-5 text-base font-medium text-slate-700 transition hover:bg-muted/50 sm:min-w-[140px] sm:text-lg"
              >
                New Folder
              </button>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => { setPendingFolderId(selectedFolderId); setShowFolderPicker(false); }}
                  className="h-9 min-w-[96px] rounded-md border border-slate-300 bg-white px-3 text-[13px] font-medium text-slate-700 transition hover:bg-muted/50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedFolderId(pendingFolderId); const folder = folders.find((item) => item.id === pendingFolderId); if (folder) setFolderSearch(folder.name); setShowFolderPicker(false); }}
                  className="h-9 min-w-[96px] rounded-md bg-red-600 px-3 text-[13px] font-semibold text-white shadow-sm transition hover:bg-red-700"
                >
                  Select
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {newFolderDialogOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4 py-6 sm:px-8">
          <div className="relative w-full max-w-[1280px] overflow-hidden rounded-md border border-slate-200 bg-white shadow-[0_22px_60px_rgba(15,23,42,0.28)]">
            <div className="flex items-center justify-center border-b-4 border-slate-300 px-6 py-8">
              <h2 className="text-xl font-semibold tracking-tight text-[#092b5c]">Create folder</h2>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); void createFolderFromPicker(); }} className="space-y-9 px-8 py-9 sm:px-12">
              <label className="block text-base font-medium text-slate-800"><span className="text-[#c9004b]">*</span> Folder Label
                <input autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} className="mt-3 h-9 w-full rounded-md border px-3 text-[13px] outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
              </label>
              <label className="block text-base font-medium text-slate-800"><span className="text-[#c9004b]">*</span> Folder Unique Name
                <input value={newFolderUniqueName} onChange={(event) => setNewFolderUniqueName(event.target.value)} className="mt-3 h-9 w-full rounded-md border px-3 text-[13px] outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
              </label>
              <div className="-mx-8 flex justify-end gap-4 border-t-4 border-slate-300 px-8 pb-1 pt-7 sm:-mx-12 sm:px-12">
                <button type="button" onClick={() => setNewFolderDialogOpen(false)} className="h-9 min-w-24 rounded-md border border-border bg-white px-4 text-[13px] font-medium text-[#a52c2c] transition hover:bg-muted/50">Cancel</button>
                <button type="submit" disabled={!newFolderName.trim() || !newFolderUniqueName.trim()} className="h-9 min-w-24 rounded-md bg-primary px-4 text-[13px] font-medium text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
import { getTenantTimezone } from "@/lib/date-format";

export type AxisFieldType = "string" | "number" | "date" | "enum";

export type AxisField = {
  key: string;
  label: string;
  type: AxisFieldType;
};

export type AxisMode =
  | "category-metric"
  | "metric-category"
  | "scatter"
  | "category-value"
  | "gauge"
  | "kpi"
  | "table";

export type DateGrouping = "day" | "week" | "month" | "quarter" | "year";

export type AxisSort =
  | "none"
  | "labelAsc"
  | "labelDesc"
  | "valueAsc"
  | "valueDesc";

const AGGREGATIONS = ["count", "sum", "avg", "min", "max"] as const;

export type AxisAggregation = (typeof AGGREGATIONS)[number];

export function axisMode(chartType: string | undefined): AxisMode {
  switch (chartType) {
    case "bar":
    case "stackedBar":
    case "horizontalBar":
      return "metric-category";
    case "scatter":
      return "scatter";
    case "pie":
    case "donut":
    case "funnel":
      return "category-value";
    case "gauge":
      return "gauge";
    case "number":
    case "metric":
    case "kpi":
      return "kpi";
    case "table":
      return "table";
    default:
      return "category-metric";
  }
}

export function cartesianAxes(chartType: string | undefined) {
  const mode = axisMode(chartType);
  return (
    mode === "category-metric" ||
    mode === "metric-category" ||
    mode === "scatter"
  );
}

export function labelFromKey(key: string) {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return key;
  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function isDateLike(value: unknown) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return false;
  return !Number.isNaN(new Date(text).getTime());
}

export function toNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || isDateLike(text)) return null;
    if (Number.isFinite(Number(text))) return Number(text);
  }
  return null;
}

export function inferFieldType(
  key: string,
  rows: Record<string, unknown>[],
): AxisFieldType {
  const values = rows
    .map((row) => row[key])
    .filter((value) => value !== null && value !== undefined && value !== "");
  if (!values.length) return "string";
  if (values.every((value) => isDateLike(value))) return "date";
  if (values.every((value) => toNumeric(value) !== null)) return "number";
  return "string";
}

export function fieldsFromSource(input: {
  metadata?: AxisField[];
  reportColumns?: string[];
  previewColumns?: string[];
  sampleRows?: Record<string, unknown>[];
}): AxisField[] {
  const sampleRows = input.sampleRows || [];
  const previewKeys = (input.previewColumns || []).filter(Boolean);
  const reportColumns = (input.reportColumns || []).filter(Boolean);
  const exposed = reportColumns.length ? reportColumns : previewKeys;
  if (!exposed.length) return [];
  const allowed = new Set(exposed.map((key) => key.toLowerCase()));
  const metadata = (input.metadata || []).filter(
    (field) =>
      allowed.has(field.key.toLowerCase()) ||
      allowed.has(field.label.toLowerCase()),
  );
  const known = new Set(
    metadata.flatMap((field) => [field.key.toLowerCase(), field.label.toLowerCase()]),
  );
  const extras = exposed
    .filter((key) => !known.has(key.toLowerCase()))
    .map((key) => ({
      key,
      label: labelFromKey(key),
      type: inferFieldType(key, sampleRows),
    }));
  const merged = [...metadata, ...extras];
  const seen = new Set<string>();
  return merged.filter((field) => {
    const id = field.key.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return Boolean(field.key);
  });
}

export function fieldsForRole(
  fields: AxisField[],
  role: "category" | "numeric" | "any",
) {
  if (role === "numeric") return fields.filter((field) => field.type === "number");
  if (role === "category")
    return fields.filter((field) => field.type !== "number");
  return fields;
}

export function aggregationChoices(field: AxisField | undefined) {
  const count = { value: "count" as const, label: "Record Count" };
  if (field?.type !== "number") return [count];
  return [
    count,
    { value: "sum" as const, label: "Sum" },
    { value: "avg" as const, label: "Average" },
    { value: "min" as const, label: "Minimum" },
    { value: "max" as const, label: "Maximum" },
  ];
}

export function axisSelectionPatch(
  chartType: string,
  draft: Record<string, any>,
  fields: AxisField[],
) {
  if (!fields.length) return {};
  const mode = axisMode(chartType);
  const numeric = new Set(fieldsForRole(fields, "numeric").map((field) => field.key));
  const category = new Set(fieldsForRole(fields, "category").map((field) => field.key));
  const patch: Record<string, any> = {};
  const clearMetric = (key: "xAxis" | "yAxis") => {
    if (draft.aggregation !== "count" && draft[key] && !numeric.has(draft[key])) {
      patch[key] = "";
      patch.aggregation = "count";
    }
  };
  if (mode === "scatter") {
    if (draft.xAxis && !numeric.has(draft.xAxis)) patch.xAxis = "";
    if (draft.yAxis && !numeric.has(draft.yAxis)) patch.yAxis = "";
    return patch;
  }
  if (mode === "metric-category") {
    if (draft.yAxis && !category.has(draft.yAxis)) patch.yAxis = "";
    clearMetric("xAxis");
    return patch;
  }
  if (mode === "table" || mode === "kpi") return patch;
  if (draft.xAxis && !category.has(draft.xAxis) && mode !== "gauge") patch.xAxis = "";
  clearMetric("yAxis");
  return patch;
}

export function canonicalAxisConfig(
  config: Record<string, any> | undefined,
  chartType: string | undefined,
) {
  const source = config || {};
  if (source.axesVersion === 2) return source;
  if (axisMode(chartType || source.chartType) !== "metric-category") {
    return { ...source, axesVersion: 2 };
  }
  const aggregation = source.aggregation || "count";
  return {
    ...source,
    axesVersion: 2,
    xAxis: aggregation === "count" ? "" : source.yAxis || "",
    yAxis: source.xAxis || "",
    xFieldType: source.yFieldType,
    yFieldType: source.xFieldType,
    xAxisTitle: source.yAxisTitle || "",
    yAxisTitle: source.xAxisTitle || "",
  };
}

export function remapChartType(
  nextType: string,
  draft: Record<string, any>,
  fields: AxisField[],
): Record<string, any> {
  const current = canonicalAxisConfig(draft, draft.chartType || nextType);
  const previous = axisMode(String(current.chartType || draft.chartType || "column"));
  const next = axisMode(nextType);
  const category = previous === "metric-category" ? current.yAxis : current.xAxis;
  const metric = previous === "metric-category" ? current.xAxis : current.yAxis;
  const fieldType = (key: unknown, stored: unknown) => {
    if (stored === "string" || stored === "number" || stored === "date" || stored === "enum") {
      return stored;
    }
    return fields.find((field) => field.key === key)?.type;
  };
  const categoryType = fieldType(
    category,
    previous === "metric-category" ? current.yFieldType : current.xFieldType,
  );
  const metricType = fieldType(
    metric,
    previous === "metric-category" ? current.xFieldType : current.yFieldType,
  );
  const moved: Record<string, any> = {
    ...current,
    chartType: nextType,
    useReportTable: false,
    axesVersion: 2,
  };
  if (next === "table") {
    return { ...moved, ...axisSelectionPatch(nextType, moved, fields) };
  }
  if (next === "scatter") {
    moved.xAxis = metricType === "number" ? metric || "" : "";
    moved.yAxis = categoryType === "number" ? category || "" : "";
    moved.xFieldType = moved.xAxis ? "number" : undefined;
    moved.yFieldType = moved.yAxis ? "number" : undefined;
  } else if (next === "metric-category") {
    moved.yAxis = category || "";
    moved.xAxis = current.aggregation === "count" ? "" : metric || "";
    moved.yFieldType = categoryType;
    moved.xFieldType = current.aggregation === "count" ? undefined : metricType;
  } else {
    moved.xAxis = category || "";
    moved.yAxis = current.aggregation === "count" ? "" : metric || "";
    moved.xFieldType = categoryType;
    moved.yFieldType = current.aggregation === "count" ? undefined : metricType;
  }
  return { ...moved, ...axisSelectionPatch(nextType, moved, fields) };
}

export function widgetTypeFromChart(chartType: string) {
  const map: Record<string, string> = {
    number: "metric",
    table: "table",
    pie: "pie",
    donut: "donut",
    bar: "chart",
    column: "column",
    stackedBar: "stackedBar",
    stackedColumn: "stackedColumn",
    line: "line",
    area: "area",
    funnel: "funnel",
    gauge: "gauge",
    scatter: "chart",
  };
  return map[chartType] || "chart";
}

function resolveKey(keys: string[], requested: unknown) {
  if (typeof requested !== "string" || !requested.trim()) return undefined;
  const normalized = requested.trim().toLowerCase();
  return keys.find((key) => key.toLowerCase() === normalized);
}

function tenantDateParts(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: getTenantTimezone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  if (!year || !month || !day) return null;
  return { year, month, day };
}

export function bucketDate(value: unknown, grouping: DateGrouping) {
  if (value == null || value === "") return "(Blank)";
  const parts = tenantDateParts(value);
  if (!parts) return String(value);
  const { year, month, day } = parts;
  if (grouping === "year") return String(year);
  if (grouping === "quarter") return `Q${Math.floor((month - 1) / 3) + 1} ${year}`;
  if (grouping === "month") return `${year}-${String(month).padStart(2, "0")}`;
  if (grouping === "week") {
    const utc = new Date(Date.UTC(year, month - 1, day));
    const dayNum = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const week = Math.ceil(
      ((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
    return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function optionalNumber(value: unknown) {
  if (value === "" || value == null) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatChartNumber(
  value: number,
  config?: Record<string, any>,
) {
  if (!Number.isFinite(value)) return "";
  const requested = config?.numberFormat || config?.displayUnits || "short";
  const decimals =
    config?.decimals === undefined || config?.decimals === "auto"
      ? undefined
      : Number(config.decimals);
  const fraction =
    decimals === undefined || !Number.isFinite(decimals)
      ? undefined
      : Math.max(0, Math.min(4, decimals));
  if (requested === "percent") {
    const digits = fraction ?? 0;
    return `${value.toLocaleString("en-IN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}%`;
  }
  if (requested === "currency") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: fraction ?? 0,
      maximumFractionDigits: fraction ?? 0,
    }).format(value);
  }
  if (requested === "full") {
    return value.toLocaleString("en-IN", {
      minimumFractionDigits: fraction ?? 0,
      maximumFractionDigits: fraction ?? 2,
    });
  }
  let scaled = value;
  let suffix = "";
  if (Math.abs(value) >= 1e6) {
    scaled = value / 1e6;
    suffix = "M";
  } else if (Math.abs(value) >= 1e3) {
    scaled = value / 1e3;
    suffix = "K";
  }
  const digits = fraction ?? (suffix ? 1 : 0);
  return (
    scaled.toLocaleString("en-IN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }) + suffix
  );
}

export function truncateLabel(value: unknown, max = 18) {
  const text = value == null || value === "" ? "(Blank)" : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function categoryTickInterval(count: number, rotation: number) {
  if (rotation !== 0 || count <= 6) return 0;
  return Math.max(0, Math.ceil(count / 6) - 1);
}

function sortSeries(
  rows: Array<{ category: string; value: number }>,
  sort: AxisSort,
) {
  const next = [...rows];
  if (sort === "labelAsc")
    next.sort((a, b) => a.category.localeCompare(b.category));
  else if (sort === "labelDesc")
    next.sort((a, b) => b.category.localeCompare(a.category));
  else if (sort === "valueAsc") next.sort((a, b) => a.value - b.value);
  else if (sort === "valueDesc") next.sort((a, b) => b.value - a.value);
  return next;
}

function aggregateRows(
  rows: Record<string, any>[],
  categoryKey: string | undefined,
  valueKey: string | undefined,
  aggregation: string,
  grouping: DateGrouping | "none",
) {
  const groups = new Map<string, { count: number; values: number[] }>();
  const order: string[] = [];
  rows.forEach((row) => {
    const raw = categoryKey ? row[categoryKey] : undefined;
    const label =
      grouping !== "none"
        ? bucketDate(raw, grouping)
        : raw == null || raw === ""
          ? "(Blank)"
          : String(raw);
    if (!groups.has(label)) {
      groups.set(label, { count: 0, values: [] });
      order.push(label);
    }
    const group = groups.get(label)!;
    group.count += 1;
    const numeric = valueKey ? toNumeric(row[valueKey]) : null;
    if (numeric != null) group.values.push(numeric);
  });
  return order.map((category) => {
    const group = groups.get(category)!;
    let value = group.count;
    if (aggregation !== "count") {
      if (!group.values.length) value = 0;
      else if (aggregation === "sum")
        value = group.values.reduce((sum, item) => sum + item, 0);
      else if (aggregation === "avg")
        value = group.values.reduce((sum, item) => sum + item, 0) / group.values.length;
      else if (aggregation === "min") value = Math.min(...group.values);
      else if (aggregation === "max") value = Math.max(...group.values);
    }
    return { category, value };
  });
}

function metricDomain(
  values: number[],
  minRaw: unknown,
  maxRaw: unknown,
  intervalRaw: unknown,
) {
  const finite = values.filter((value) => Number.isFinite(value));
  const dataMin = finite.length ? Math.min(...finite) : 0;
  const dataMax = finite.length ? Math.max(...finite) : 0;
  let min = optionalNumber(minRaw);
  let max = optionalNumber(maxRaw);
  if (min != null && max != null && min >= max) {
    min = null;
    max = null;
  }
  const lo = min ?? Math.min(0, dataMin);
  const hi = max ?? (dataMax <= lo ? lo + 1 : dataMax);
  const interval = optionalNumber(intervalRaw);
  let ticks: number[] | undefined;
  if (interval && interval > 0 && hi >= lo) {
    const count = Math.floor((hi - lo) / interval + 1e-6);
    if (count >= 0 && count <= 12) {
      ticks = [];
      for (let index = 0; index <= count; index += 1) {
        ticks.push(Number((lo + index * interval).toFixed(6)));
      }
      const last = ticks[ticks.length - 1];
      if (last < hi) ticks.push(hi);
    }
  }
  return { domain: [lo, hi] as [number, number], ticks };
}

function axisTitle(custom: unknown, fallback: string) {
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  return fallback;
}

function rotationOf(config: Record<string, any>) {
  const rotation = Number(config.labelRotation ?? config.xLabelRotation ?? 0);
  return rotation === 45 || rotation === 90 || rotation === -45 ? rotation : 0;
}

function sortOf(config: Record<string, any>, dateAxis: boolean): AxisSort {
  const requested = config.axisSort;
  if (
    requested === "labelAsc" ||
    requested === "labelDesc" ||
    requested === "valueAsc" ||
    requested === "valueDesc" ||
    requested === "none"
  ) {
    if (requested === "none" && dateAxis) return "labelAsc";
    return requested;
  }
  if (config.sortValues) return "valueDesc";
  if (dateAxis) return "labelAsc";
  return "none";
}

export type PreparedChart = {
  mode: AxisMode;
  data: Array<Record<string, string | number>>;
  categoryKey: "category";
  valueKey: "value";
  xNumeric: boolean;
  yNumeric: boolean;
  showXAxis: boolean;
  showYAxis: boolean;
  showXLabels: boolean;
  showYLabels: boolean;
  xTitle: string;
  yTitle: string;
  categoryAxis: "x" | "y" | "none";
  labelRotation: number;
  margin: { top: number; right: number; bottom: number; left: number };
  format: (value: number) => string;
  xDomain?: [number, number];
  yDomain?: [number, number];
  xTicks?: number[];
  yTicks?: number[];
  message?: string;
  metricTotal: number;
  gauge: { min: number; max: number; target?: number; value: number };
  tableColumns: string[];
  reference?: number;
};

const emptyGauge = { min: 0, max: 1, value: 0 };

export function prepareWidgetChart(input: {
  rows?: Record<string, any>[];
  chartType?: string;
  config?: Record<string, any>;
  preAggregated?: boolean;
}): PreparedChart {
  const chartType = input.chartType || "column";
  const config = canonicalAxisConfig(input.config, chartType);
  const mode = axisMode(chartType);
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  const format = (value: number) => formatChartNumber(value, config);
  const showXAxis = config.xAxisEnabled !== false;
  const showYAxis = config.yAxisEnabled !== false;
  const showXLabels = config.showXLabels !== false;
  const showYLabels = config.showYLabels !== false;
  const labelRotation = rotationOf(config);
  const categoryOnY = mode === "metric-category";
  const categoryField = categoryOnY ? config.yAxis : config.xAxis;
  const metricField = categoryOnY ? config.xAxis : config.yAxis;
  const categoryType = categoryOnY ? config.yFieldType : config.xFieldType;
  const aggregation = AGGREGATIONS.includes(config.aggregation)
    ? config.aggregation
    : "count";
  const base: PreparedChart = {
    mode,
    data: [],
    categoryKey: "category",
    valueKey: "value",
    xNumeric: mode === "scatter" || categoryOnY,
    yNumeric: mode === "scatter" || !categoryOnY,
    showXAxis,
    showYAxis,
    showXLabels,
    showYLabels,
    xTitle: "",
    yTitle: "",
    categoryAxis: mode === "scatter" ? "none" : categoryOnY ? "y" : "x",
    labelRotation,
    margin: { top: 12, right: 16, bottom: 24, left: 16 },
    format,
    message: undefined,
    metricTotal: 0,
    gauge: emptyGauge,
    tableColumns: [],
    reference:
      config.showReferenceLine && Number.isFinite(Number(config.referenceValue))
        ? Number(config.referenceValue)
        : undefined,
  };

  if (mode === "table") {
    const selected = Array.isArray(config.tableColumns)
      ? config.tableColumns.map(String)
      : [];
    const columns = selected.length
      ? selected
          .map((key) => resolveKey(keys, key))
          .filter((key): key is string => Boolean(key))
      : keys;
    base.tableColumns = columns.length ? columns : keys;
    return base;
  }

  const missingField = (requested: unknown, resolved: string | undefined) =>
    typeof requested === "string" &&
    requested.trim() &&
    !resolved &&
    !input.preAggregated;

  if (mode === "scatter") {
    const xKey = resolveKey(keys, config.xAxis);
    const yKey = resolveKey(keys, config.yAxis);
    if (missingField(config.xAxis, xKey) || missingField(config.yAxis, yKey)) {
      base.message = "The selected axis field is not in this report.";
      return base;
    }
    if (!xKey || !yKey) {
      base.message = rows.length ? "Choose numeric fields for both axes." : undefined;
      return base;
    }
    const data = rows.flatMap((row) => {
      const x = toNumeric(row[xKey]);
      const y = toNumeric(row[yKey]);
      if (x == null || y == null) return [];
      return [{ x, y }];
    });
    const xScale = metricDomain(
      data.map((row) => Number(row.x)),
      config.xMin,
      config.xMax,
      config.xTickInterval,
    );
    const yScale = metricDomain(
      data.map((row) => Number(row.y)),
      config.yMin,
      config.yMax,
      config.yTickInterval,
    );
    return {
      ...base,
      data,
      xNumeric: true,
      yNumeric: true,
      xTitle: axisTitle(config.xAxisTitle, labelFromKey(xKey)),
      yTitle: axisTitle(config.yAxisTitle, labelFromKey(yKey)),
      xDomain: xScale.domain,
      yDomain: yScale.domain,
      xTicks: xScale.ticks,
      yTicks: yScale.ticks,
      margin: { top: 8, right: 16, bottom: 8, left: 8 },
      message: data.length ? undefined : rows.length ? "No numeric pairs to plot." : undefined,
    };
  }

  const categoryKey = input.preAggregated
    ? resolveKey(keys, "category") || resolveKey(keys, categoryField) || keys[0]
    : resolveKey(keys, categoryField);
  const valueKey =
    aggregation === "count"
      ? undefined
      : input.preAggregated
        ? resolveKey(keys, "value") || resolveKey(keys, metricField)
        : resolveKey(keys, metricField);

  if (
    !input.preAggregated &&
    ((categoryField && !categoryKey && mode !== "gauge" && mode !== "kpi") ||
      (aggregation !== "count" && metricField && !valueKey))
  ) {
    base.message = "The selected axis field is not in this report.";
    return base;
  }

  const dateAxis =
    categoryType === "date" ||
    Boolean(
      !categoryType &&
        categoryKey &&
        rows.some((row) => isDateLike(row[categoryKey])),
    );
  const grouping: DateGrouping | "none" =
    dateAxis && !input.preAggregated
      ? config.dateGrouping === "week" ||
        config.dateGrouping === "month" ||
        config.dateGrouping === "quarter" ||
        config.dateGrouping === "year" ||
        config.dateGrouping === "day"
        ? config.dateGrouping
        : "day"
      : "none";

  const autoCategory =
    categoryKey ||
    keys.find((key) => rows.some((row) => row[key] != null && toNumeric(row[key]) == null)) ||
    keys[0];

  let series = input.preAggregated
    ? rows.map((row) => ({
        category: String(
          (categoryKey && row[categoryKey] != null && row[categoryKey] !== ""
            ? row[categoryKey]
            : row.category) ?? "(Blank)",
        ),
        value:
          aggregation === "count"
            ? toNumeric(row.value) ?? toNumeric(row.count) ?? 0
            : toNumeric(valueKey ? row[valueKey] : row.value) ?? 0,
      }))
    : aggregateRows(rows, autoCategory, valueKey, aggregation, grouping);

  if (mode !== "gauge" && mode !== "kpi") {
    series = sortSeries(series, sortOf(config, dateAxis && grouping !== "none"));
  }

  const metricTotal = metricValue(rows, valueKey, aggregation, input.preAggregated, series);
  const categoryLabel = axisTitle(
    categoryOnY ? config.yAxisTitle : config.xAxisTitle,
    categoryField ? labelFromKey(String(categoryField)) : "Category",
  );
  const metricLabel = axisTitle(
    categoryOnY ? config.xAxisTitle : config.yAxisTitle,
    aggregation === "count"
      ? "Record Count"
      : metricField
        ? `${aggregationLabel(aggregation)} of ${labelFromKey(String(metricField))}`
        : aggregationLabel(aggregation),
  );
  const values = series.map((row) => row.value);
  const numericScale = metricDomain(
    values,
    categoryOnY ? config.xMin : config.yMin,
    categoryOnY ? config.xMax : config.yMax,
    categoryOnY ? config.xTickInterval : config.yTickInterval,
  );
  const categoryHeight =
    (labelRotation === 90 ? 78 : labelRotation === 0 ? 28 : 64) +
    ((categoryOnY ? config.yAxisTitle : config.xAxisTitle) ? 16 : 0);

  const gaugeMin = optionalNumber(config.gaugeMin) ?? 0;
  let gaugeMax = optionalNumber(config.gaugeMax);
  if (gaugeMax == null || gaugeMax <= gaugeMin) {
    gaugeMax = Math.max(gaugeMin + 1, metricTotal, optionalNumber(config.gaugeTarget) ?? 0);
  }
  const gaugeTarget = optionalNumber(config.gaugeTarget);

  return {
    ...base,
    data: series.map((row) => ({ category: row.category, value: row.value })),
    xNumeric: categoryOnY,
    yNumeric: !categoryOnY,
    xTitle: categoryOnY ? metricLabel : categoryLabel,
    yTitle: categoryOnY ? categoryLabel : metricLabel,
    xDomain: categoryOnY ? numericScale.domain : undefined,
    yDomain: categoryOnY ? undefined : numericScale.domain,
    xTicks: categoryOnY ? numericScale.ticks : undefined,
    yTicks: categoryOnY ? undefined : numericScale.ticks,
    metricTotal,
    margin: {
      top: 8,
      right: 12,
      bottom: categoryOnY ? 4 : Math.max(4, categoryHeight - 24),
      left: 4,
    },
    gauge: {
      min: gaugeMin,
      max: gaugeMax,
      target: gaugeTarget ?? undefined,
      value: metricTotal,
    },
  };
}

function aggregationLabel(aggregation: string) {
  if (aggregation === "avg") return "Average";
  if (aggregation === "sum") return "Sum";
  if (aggregation === "min") return "Minimum";
  if (aggregation === "max") return "Maximum";
  return "Record Count";
}

function metricValue(
  rows: Record<string, any>[],
  valueKey: string | undefined,
  aggregation: string,
  preAggregated: boolean | undefined,
  series: Array<{ value: number }>,
) {
  if (preAggregated) {
    if (aggregation === "avg" && series.length)
      return series.reduce((sum, row) => sum + row.value, 0) / series.length;
    if (aggregation === "min" && series.length)
      return Math.min(...series.map((row) => row.value));
    if (aggregation === "max" && series.length)
      return Math.max(...series.map((row) => row.value));
    return series.reduce((sum, row) => sum + row.value, 0);
  }
  if (aggregation === "count") return rows.length;
  const values = rows
    .map((row) => (valueKey ? toNumeric(row[valueKey]) : null))
    .filter((value): value is number => value != null);
  if (!values.length) return 0;
  if (aggregation === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (aggregation === "avg")
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (aggregation === "min") return Math.min(...values);
  if (aggregation === "max") return Math.max(...values);
  return rows.length;
}

export function rowsForWidget(
  result:
    | {
        result?: {
          rows?: Record<string, any>[];
          groups?: Array<{
            groupValues?: Record<string, string>;
            count?: number;
            summary?: Record<string, any>;
          }>;
        };
      }
    | null
    | undefined,
  config?: Record<string, any>,
) {
  const groups = result?.result?.groups || [];
  const detail = result?.result?.rows || [];
  const grouped = groups.map((group) => {
    const groupValues = group.groupValues || {};
    const firstKey = Object.keys(groupValues)[0];
    const summaryValue = Object.values(group.summary || {}).find(
      (value) => typeof value === "number" && Number.isFinite(value),
    );
    return {
      category: firstKey ? groupValues[firstKey] || "(Blank)" : "(Blank)",
      value:
        config?.aggregation && config.aggregation !== "count"
          ? Number(summaryValue ?? group.count ?? 0)
          : Number(group.count || 0),
    };
  });
  if (config?.useReportChart && grouped.length) {
    return { rows: grouped, preAggregated: true };
  }
  if (detail.length) return { rows: detail, preAggregated: false };
  if (grouped.length) return { rows: grouped, preAggregated: true };
  return { rows: [] as Record<string, any>[], preAggregated: false };
}

export function selectTableRows(
  rows: Record<string, any>[],
  selected?: string[],
) {
  if (!rows.length) return [] as Record<string, any>[];
  const keys = Object.keys(rows[0]);
  const columns = (selected || [])
    .map((key) => resolveKey(keys, key))
    .filter((key): key is string => Boolean(key));
  const used = columns.length ? columns : keys;
  return rows.map((row) => {
    const next: Record<string, any> = {};
    used.forEach((key) => {
      next[key] = row[key];
    });
    return next;
  });
}

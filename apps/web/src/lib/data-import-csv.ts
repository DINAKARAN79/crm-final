export function parseCsvPreview(csv: string): { rows: string[][]; error: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const content = csv.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(content);

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === delimiter) {
      row.push(value.trim());
      value = "";
    } else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(value.trim());
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (quoted) return { rows: [], error: "CSV contains an unterminated quoted field." };
  row.push(value.trim());
  if (row.some((cell) => cell !== "")) rows.push(row);
  return { rows, error: "" };
}

export async function parseCsvPreviewAsync(
  csv: string,
  shouldContinue: () => boolean = () => true,
): Promise<{ rows: string[][]; error: string } | null> {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const content = csv.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(content);

  for (let index = 0; index < content.length; index += 1) {
    if (index > 0 && index % 262_144 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!shouldContinue()) return null;
    }
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === delimiter) {
      row.push(value.trim());
      value = "";
    } else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(value.trim());
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (!shouldContinue()) return null;
  if (quoted) return { rows: [], error: "CSV contains an unterminated quoted field." };
  row.push(value.trim());
  if (row.some((cell) => cell !== "")) rows.push(row);
  return { rows, error: "" };
}

export function serializeCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => {
    const value = cell.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join(",")).join("\n");
}

export function getCsvColumns(rows: string[][], hasHeaderRow: boolean): string[] {
  if (!rows.length) return [];
  if (hasHeaderRow) return rows[0].map((header, index) => header || `Column ${index + 1}`);
  const columnCount = Math.max(...rows.map((row) => row.length));
  return Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
}

export function suggestCsvFieldMappings(
  columns: string[],
  fields: Array<{ name: string; label: string }>,
): Record<number, string> {
  const mappings: Record<number, string> = {};
  const usedFields = new Set<string>();
  columns.forEach((column, index) => {
    const normalizedColumn = normalizeFieldName(column);
    const match = fields.find((field) =>
      !usedFields.has(field.name) &&
      [
        field.name,
        field.label,
        ...(field.name === "ownerId" ? ["Owner", "Owner Email", "Owner ID"] : []),
      ].some((candidate) => normalizeFieldName(candidate) === normalizedColumn),
    );
    if (match) {
      mappings[index] = match.name;
      usedFields.add(match.name);
    }
  });
  return mappings;
}

export function buildMappedImportRows(
  rows: string[][],
  hasHeaderRow: boolean,
  mappings: Record<number, string>,
): string[][] {
  const columnMappings = Object.entries(mappings)
    .map(([index, field]) => ({ index: Number(index), field }))
    .filter(({ index, field }) => Number.isInteger(index) && index >= 0 && field)
    .sort((left, right) => left.index - right.index);
  const selectedFields = new Set<string>();
  for (const { field } of columnMappings) {
    if (selectedFields.has(field)) throw new Error(`The ${field} field is mapped to more than one CSV column.`);
    selectedFields.add(field);
  }

  const dataRows = hasHeaderRow ? rows.slice(1) : rows;
  return [
    columnMappings.map(({ field }) => field),
    ...dataRows.map((row) => columnMappings.map(({ index }) => row[index] ?? "")),
  ];
}

function normalizeFieldName(value: string): string {
  return value.trim().replace(/^_+/, "").replace(/__c$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function detectDelimiter(content: string): string {
  const counts = new Map([[",", 0], ["\t", 0], [";", 0], ["|", 0]]);
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (character === "\n" || character === "\r")) {
      break;
    } else if (!quoted && counts.has(character)) {
      counts.set(character, (counts.get(character) || 0) + 1);
    }
  }

  return [...counts].reduce((best, candidate) => candidate[1] > best[1] ? candidate : best)[0];
}

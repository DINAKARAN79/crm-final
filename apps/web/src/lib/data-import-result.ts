export type ImportFeedback = {
  kind: "success" | "partial" | "error";
  title: string;
  description: string;
};

export type ImportRowOutcome = {
  index: number;
  status: "success" | "failed";
  error?: string;
  leadNumber?: string;
  projectName?: string;
  leadStatus?: string;
  assignedOwner?: string;
  assignmentGroup?: string;
};

type ImportResult = {
  success?: boolean;
  error?: string;
  row?: number;
  data?: {
    count?: number;
    created?: number;
    updated?: number;
    linkedEnquiries?: number;
    errors?: Array<{ index?: number; error?: string }>;
    rowResults?: ImportRowOutcome[];
  };
};

export function buildImportRowOutcomes(rowCount: number, result: ImportResult): ImportRowOutcome[] {
  const serverOutcomes = new Map((result.data?.rowResults ?? []).map((outcome) => [outcome.index, outcome]));
  const errors = new Map((result.data?.errors ?? [])
    .filter((entry): entry is { index: number; error?: string } => typeof entry.index === "number")
    .map((entry) => [entry.index, entry.error || "The row could not be imported."]));
  if (typeof result.row === "number") errors.set(result.row - 2, result.error || "The row could not be imported.");
  const importedCount = result.data?.updated !== undefined
    ? result.data.count ?? ((result.data.created ?? 0) + result.data.updated)
    : (result.data?.created ?? result.data?.count ?? 0) + (result.data?.linkedEnquiries ?? 0);
  const importConfirmed = result.success === true && importedCount > 0;

  return Array.from({ length: rowCount }, (_, index) => {
    const outcome = serverOutcomes.get(index);
    if (outcome) return outcome;

    const error = errors.get(index);
    if (error) return { index, status: "failed", error };
    if (!importConfirmed) {
      return {
        index,
        status: "failed",
        error: result.error || "The server did not confirm that this row was imported.",
      };
    }
    return { index, status: "success" };
  });
}

export function summarizeImportResult(
  objectName: string,
  result: ImportResult,
  operation: "import" | "update" = "import",
): ImportFeedback {
  const created = result.data?.created ?? (operation === "update" ? 0 : result.data?.count ?? 0);
  const updated = operation === "update"
    ? result.data?.updated ?? (result.data?.count ?? 0) - created
    : 0;
  const linked = objectName.trim().toLowerCase() === "lead" ? result.data?.linkedEnquiries ?? 0 : 0;
  const processed = operation === "update" ? result.data?.count ?? created + updated : created + linked;
  const errors = result.data?.errors ?? [];
  const firstError = errors.find((entry) => !entry.error?.startsWith("Not imported because")) || errors[0];

  if (result.success === false || processed === 0) {
    return {
      kind: "error",
      title: operation === "update" ? "Update failed" : "Import failed",
      description: firstError?.error
        ? `${operation === "update" ? "No records were updated." : "No records were imported."} ${firstError.error}`
        : `The server did not confirm that any records were ${operation === "update" ? "updated" : "imported"}.`,
    };
  }

  const summary = operation === "update"
    ? created > 0
      ? `Upserted ${processed.toLocaleString()} Lead${processed === 1 ? "" : "s"}: ${created.toLocaleString()} created and ${updated.toLocaleString()} updated.`
      : `Updated ${updated.toLocaleString()} Lead${updated === 1 ? "" : "s"}.`
    : objectName.trim().toLowerCase() === "lead"
    ? `Processed ${processed.toLocaleString()} row${processed === 1 ? "" : "s"}: ${created.toLocaleString()} new lead${created === 1 ? "" : "s"} created and ${linked.toLocaleString()} row${linked === 1 ? "" : "s"} matched to existing leads.`
    : `Successfully uploaded ${created.toLocaleString()} record${created === 1 ? "" : "s"}.`;

  if (errors.length) {
    return {
      kind: "partial",
      title: operation === "update" ? "Update partially complete" : "Import partially complete",
      description: `${summary} ${errors.length} row${errors.length === 1 ? "" : "s"} failed. First error: ${firstError?.error || "Check the failed row data."}`,
    };
  }

  return {
    kind: "success",
    title: operation === "update" ? "Data updated successfully" : "Data uploaded successfully",
    description: summary,
  };
}

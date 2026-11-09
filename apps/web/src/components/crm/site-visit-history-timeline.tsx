"use client";

import * as React from "react";
import { CheckCircle2, ChevronDown, History, Loader2, RefreshCw } from "lucide-react";
import { siteVisitApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTenantTimezone } from "@/lib/date-format";

interface SiteVisitHistoryTimelineProps {
  siteVisitId: string;
  siteVisitNumber: string;
  leadName: string;
  createdAt: string;
  createdBy?: { firstName: string; lastName: string } | null;
  scheduledAt?: string;
  refreshKey?: number;
}

interface HistoryEntry {
  id: string;
  action: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  createdAt: string;
  user?: { firstName: string; lastName: string; profile?: { name: string } | null } | null;
  impersonatedByName?: string | null;
}

function displayValue(value: unknown, field: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" && /(At|Date)$/.test(field)) {
    const parsedDate = new Date(value);
    if (!Number.isNaN(parsedDate.getTime())) {
      return new Intl.DateTimeFormat(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: getTenantTimezone(),
      }).format(parsedDate);
    }
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).replace(/_/g, " ");
}

function fieldLabel(field: string): string {
  return field
    .replace(/Id$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function historyTitle(action: string): string {
  const titles: Record<string, string> = {
    SITE_VISIT_CREATED: "Site Visit Created",
    SITE_VISIT_REVISIT_CREATED: "Revisit Created",
    SITE_VISIT_RESCHEDULED: "Site Visit Rescheduled",
    SITE_VISIT_COMPLETED: "Site Visit Completed",
    SITE_VISIT_CANCELLED: "Site Visit Cancelled",
    SITE_VISIT_MISSED: "Site Visit Missed",
    UPDATE: "Site Visit Updated",
    DELETE: "Site Visit Deleted",
  };
  return titles[action] || action.replace(/_/g, " ").toLowerCase().replace(/^./, (character) => character.toUpperCase());
}

function historyDetails(entry: HistoryEntry): string {
  const oldValues = entry.oldValues || {};
  const newValues = entry.newValues || {};
  const ignoredFields = new Set([
    "id", "tenantId", "leadId", "createdAt", "updatedAt", "creatorId", "cancelledById", "completedById",
  ]);
  const fields = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
  const changes = [...fields]
    .filter((field) => !ignoredFields.has(field))
    .filter((field) => JSON.stringify(oldValues[field] ?? null) !== JSON.stringify(newValues[field] ?? null))
    .map((field) => {
      const label = fieldLabel(field);
      if (oldValues[field] === undefined) {
        return `${label}: ${displayValue(newValues[field], field)}`;
      }
      return `${label}: ${displayValue(oldValues[field], field)} → ${displayValue(newValues[field], field)}`;
    });

  return changes.length ? changes.join(" · ") : historyTitle(entry.action);
}

function monthLabel(date: string): string {
  if (Number.isNaN(new Date(date).getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: getTenantTimezone() }).format(new Date(date));
}

function dayLabel(date: string): string {
  if (Number.isNaN(new Date(date).getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", timeZone: getTenantTimezone() }).format(new Date(date));
}

function fullDateLabel(date: string): string {
  if (Number.isNaN(new Date(date).getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: getTenantTimezone() }).format(new Date(date));
}

export function SiteVisitHistoryTimeline({
  siteVisitId,
  siteVisitNumber,
  leadName,
  createdAt,
  createdBy,
  scheduledAt,
  refreshKey = 0,
}: SiteVisitHistoryTimelineProps) {
  const [entries, setEntries] = React.useState<HistoryEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await siteVisitApi.getHistory(siteVisitId, { page: 1, limit: 100 });
      if (!response.data.success) {
        throw new Error(response.data.error || "Site visit history could not be loaded.");
      }
      const historyEntries = response.data.data || [];
      setEntries(historyEntries.length
        ? historyEntries
        : [{
            id: `created-${siteVisitId}`,
            action: "SITE_VISIT_CREATED",
            newValues: { siteVisitNumber, scheduledAt },
            createdAt,
            user: createdBy || null,
          }]);
    } catch (reason: any) {
      setEntries([]);
      setError(
        reason?.response?.data?.error ||
          reason?.message ||
          "Site visit history could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [createdAt, createdBy, refreshKey, scheduledAt, siteVisitId, siteVisitNumber]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const groupedEntries = React.useMemo(() => {
    const groups = new Map<string, HistoryEntry[]>();
    for (const entry of entries) {
      const month = monthLabel(entry.createdAt);
      groups.set(month, [...(groups.get(month) || []), entry]);
    }
    return [...groups.entries()];
  }, [entries]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-sm bg-pink-500">
            <History className="h-5 w-5 text-white" aria-hidden="true" />
          </span>
          <CardTitle className="text-base">Site Visit History</CardTitle>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full bg-sky-700 text-white hover:bg-sky-800 hover:text-white"
          aria-label="Refresh site visit history"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </CardHeader>
      <CardContent className="border-t p-3">
        <div className="max-h-[420px] overflow-y-auto" aria-live="polite" aria-busy={loading}>
          {loading && entries.length === 0 ? (
            <div className="flex min-h-20 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading site visit history...
            </div>
          ) : error ? (
            <p role="alert" className="py-5 text-center text-sm text-destructive">
              Unable to load site visit history: {error}
            </p>
          ) : entries.length === 0 ? (
            <p className="py-5 text-center text-sm text-muted-foreground">
              No site visit history found.
            </p>
          ) : (
            <>
              {groupedEntries.map(([month, monthEntries]) => (
                <section key={month} className="mb-2">
                  <div className="sticky top-0 z-10 flex items-center gap-1 border-b bg-background py-1.5 text-[11px] text-muted-foreground">
                    <ChevronDown className="h-3 w-3" aria-hidden="true" />
                    <span className="font-medium">{month}</span>
                  </div>
                  <div className="pt-2">
                    {monthEntries.map((entry, index) => {
                      const userName = entry.user
                        ? `${entry.user.firstName} ${entry.user.lastName}`.trim()
                        : "System";
                      const actorName = entry.impersonatedByName
                        ? `${(entry.action === "SITE_VISIT_COMPLETED" ? entry.user?.profile?.name || userName : userName)} (via Superadmin: ${entry.impersonatedByName})`
                        : entry.action === "SITE_VISIT_COMPLETED"
                          ? entry.user?.profile?.name || userName
                          : userName;
                      return (
                        <div key={entry.id} className="relative min-h-14 pb-3 pl-7 last:pb-0">
                          {index < monthEntries.length - 1 && (
                            <span
                              className="absolute bottom-0 left-[7px] top-4 border-l-2 border-emerald-500"
                              aria-hidden="true"
                            />
                          )}
                          <span
                            className="absolute left-0 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-white ring-2 ring-background"
                            aria-hidden="true"
                          >
                            <CheckCircle2 className="h-3 w-3" />
                          </span>
                          <details className="group">
                            <summary className="flex cursor-pointer list-none items-start gap-2 rounded-sm pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              <span className="min-w-0 flex-1">
                                <span className="block text-[11px] font-medium leading-4 text-rose-700 underline decoration-dotted underline-offset-2">
                                  {historyTitle(entry.action)}
                                </span>
                                <span className="block text-[10px] leading-4 text-muted-foreground">
                                  <span className="text-rose-700 underline decoration-dotted underline-offset-2">
                                    {actorName}
                                  </span>
                                  {" "}
                                  {entry.action === "SITE_VISIT_CREATED"
                                    ? "created this site visit"
                                    : entry.action === "SITE_VISIT_COMPLETED"
                                      ? "marked this visit as completed"
                                      : entry.action === "SITE_VISIT_CANCELLED"
                                        ? "cancelled this site visit"
                                        : entry.action === "SITE_VISIT_REVISIT_CREATED"
                                          ? "created a revisit"
                                              : entry.action === "SITE_VISIT_RESCHEDULED"
                                                ? "rescheduled this site visit"
                                              : "updated this site visit"}
                                </span>
                              </span>
                              <time
                                dateTime={Number.isNaN(new Date(entry.createdAt).getTime()) ? undefined : entry.createdAt}
                                title={fullDateLabel(entry.createdAt)}
                                className="shrink-0 pt-0.5 text-[9px] text-muted-foreground"
                              >
                                {dayLabel(entry.createdAt)}
                              </time>
                              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/60 text-muted-foreground">
                                <ChevronDown
                                  className="h-2.5 w-2.5 transition-transform group-open:rotate-180"
                                  aria-hidden="true"
                                />
                              </span>
                            </summary>
                            <div className="mt-2 rounded-sm border-l-2 border-emerald-500 bg-muted/30 py-2 pl-3 pr-2 text-[11px]">
                              <p className="font-medium">{siteVisitNumber}</p>
                              <p className="mt-1 text-muted-foreground">Lead: {leadName}</p>
                              <p className="mt-1 text-muted-foreground">{historyDetails(entry)}</p>
                              <p className="mt-1 text-muted-foreground">
                                {fullDateLabel(entry.createdAt)}
                              </p>
                            </div>
                          </details>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
              <p className="py-2 text-center text-[10px] text-muted-foreground">
                No more past activities to load.
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

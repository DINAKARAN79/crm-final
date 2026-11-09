"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/crm/data-table";
import { CommonFilterPanel, FilterDate, FilterSearch, FilterSelect } from "@/components/crm/common-filter-panel";
import { useListView } from "@/components/crm/list-view-control";
import { ListPageHeader, listPageActionClassName } from "@/components/crm/list-page-header";
import { Plus, MoreHorizontal, Eye, Edit, Trash2, Layers3, MapPin } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { leadApi, projectApi, siteVisitApi } from "@/lib/api";
import { dateKey, dateTimeInputValue, formatDateTime, getTenantTimezone } from "@/lib/date-format";
import { crmLocalDateTimeToDate } from "@dct-crm/shared";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";
import { subscribeToSiteVisitListUpdates } from "@/lib/site-visit-list-events";

interface SiteVisit {
  id: string;
  siteVisitNumber?: string;
  leadId: string;
  leadName: string;
  projectName: string;
  visitDate: string;
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED" | "MISSED" | "RESCHEDULED";
  assignedTo: string;
  leadNumber?: string;
  createdAt: string;
  createdBy: string;
  feedback?: string;
  cancellationReason?: string;
}

const istDayKey = (value: string | Date): string => {
  return dateKey(value);
};

const timingBadge = (
  visit: SiteVisit
): { label: string; className: string } | null => {
  if (visit.status === "COMPLETED") return null;
  if (visit.status === "MISSED") {
    return { label: "Missed", className: "bg-red-100 text-red-800" };
  }
  if (visit.status === "CANCELLED") {
    return visit.cancellationReason?.startsWith("Automatically cancelled")
      ? { label: "Overdue (Auto-cancelled)", className: "bg-amber-100 text-amber-800" }
      : null;
  }
  const visitDay = istDayKey(visit.visitDate);
  const today = istDayKey(new Date());
  if (!visitDay) return null;
  if (visitDay < today)
    return { label: "Overdue", className: "bg-amber-100 text-amber-800" };
  if (visitDay === today)
    return { label: "Today", className: "bg-blue-100 text-blue-800" };
  return { label: "Upcoming", className: "bg-slate-100 text-slate-700" };
};

const statusColors: Record<string, string> = {
  SCHEDULED: "bg-blue-100 text-blue-800",
  COMPLETED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
  MISSED: "bg-red-100 text-red-800",
  RESCHEDULED: "bg-violet-100 text-violet-800",
};

const statusLabels: Record<string, string> = {
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  MISSED: "Missed",
  RESCHEDULED: "Rescheduled",
};

const columns: ColumnDef<SiteVisit>[] = [
  {
    accessorKey: "siteVisitNumber",
    header: "SV Number",
    cell: ({ row }) => (
      <Link
        href={`/site-visits/${row.original.id}`}
        className="font-mono text-sm font-medium text-[#1479a8] hover:text-[#075d91] hover:underline"
      >
        {row.getValue("siteVisitNumber") || "—"}
      </Link>
    ),
  },
  {
    accessorKey: "leadNumber",
    header: "Lead Number",
    cell: ({ row }) => (
      <Link
        href={`/leads/${row.original.leadId}`}
        className="font-mono text-sm text-primary hover:underline"
      >
        {row.getValue("leadNumber") || "—"}
      </Link>
    ),
  },
  {
    accessorKey: "leadName",
    header: "Lead",
    cell: ({ row }) => (
      <Link href={`/leads/${row.original.leadId}`} className="font-semibold text-[#075d91] hover:text-[#1479a8] hover:underline">
        {row.getValue("leadName")}
      </Link>
    ),
  },
  {
    accessorKey: "projectName",
    header: "Project",
  },
  {
    accessorKey: "visitDate",
    header: "Visit Date",
    cell: ({ row }) => {
      const date = new Date(row.getValue("visitDate"));
      return formatDateTime(date);
    },
  },
  {
    id: "timing",
    header: "Timing",
    cell: ({ row }) => {
      const timing = timingBadge(row.original);
      if (!timing) return <span className="text-muted-foreground">—</span>;
      return <Badge className={timing.className}>{timing.label}</Badge>;
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const status = row.getValue("status") as string;
      return (
        <Badge className={statusColors[status] || "bg-gray-100 text-gray-800"}>
          {statusLabels[status] || status}
        </Badge>
      );
    },
  },
  {
    accessorKey: "assignedTo",
    header: "Assigned To",
  },
  {
    accessorKey: "createdAt",
    header: "Created At",
    cell: ({ row }) => formatDateTime(row.getValue("createdAt")),
  },
  {
    accessorKey: "createdBy",
    header: "Created By",
  },
  {
    id: "actions",
    cell: ({ row }) => {
      const visit = row.original;
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/site-visits/${visit.id}`}>
                <Eye className="mr-2 h-4 w-4" />
                View
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/leads/${visit.leadId}`}>
                <Edit className="mr-2 h-4 w-4" />
                Edit Lead
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
  },
];

export default function SiteVisitsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { hasEffectivePermission } = useAuth();
  const listViews = useListView("SITE_VISIT");
  const [currentPage, setCurrentPage] = React.useState(1);
  const [filters, setFilters] = React.useState({ status: "" });
  const [search, setSearch] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [dateError, setDateError] = React.useState("");
  const [siteVisits, setSiteVisits] = React.useState<SiteVisit[]>([]);
  const [totalItems, setTotalItems] = React.useState(0);
  const [isLoading, setIsLoading] = React.useState(true);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const [scheduleLoading, setScheduleLoading] = React.useState(false);
  const [scheduleSaving, setScheduleSaving] = React.useState(false);
  const [scheduleError, setScheduleError] = React.useState("");
  const [leads, setLeads] = React.useState<any[]>([]);
  const [projects, setProjects] = React.useState<any[]>([]);
  const [selectedLeadId, setSelectedLeadId] = React.useState("");
  const [selectedProjectId, setSelectedProjectId] = React.useState("");
  const [scheduledDate, setScheduledDate] = React.useState("");
  const [scheduledTime, setScheduledTime] = React.useState("");
  const [scheduleNotes, setScheduleNotes] = React.useState("");
  const canScheduleSiteVisit =
    hasEffectivePermission("SITE_VISIT_CREATE") &&
    hasEffectivePermission("LEAD_READ");

  const scheduleOpenRef = React.useRef(scheduleOpen);
  scheduleOpenRef.current = scheduleOpen;

  React.useEffect(() => {
    const fetchSiteVisits = async (silent = false) => {
      if (!listViews.ready) return;
      try {
        if (!silent) setIsLoading(true);
        const params: Record<string, any> = { page: currentPage, limit: 20 };
        if (filters.status) params.status = filters.status;
        if (search.trim()) params.search = search.trim();
        if (dateFrom) params.startDate = dateFrom;
        if (dateTo) params.endDate = dateTo;
        Object.assign(params, listViews.params);
        const res = await siteVisitApi.list(params);
        if (res.data.success && res.data.data) {
          const mapped = res.data.data.map((item: any) => ({
            id: item.id,
            siteVisitNumber: item.siteVisitNumber || undefined,
            leadId: item.lead?.id || item.leadId || "",
            leadNumber: item.lead?.leadNumber || "—",
            leadName: item.lead
              ? `${item.lead.firstName} ${item.lead.lastName}`.trim()
              : "—",
            projectName: item.project?.name || "—",
            visitDate: item.scheduledAt || item.visitDate || item.createdAt,
            status: (item.status || "SCHEDULED") as SiteVisit["status"],
            assignedTo: item.assignee
              ? `${item.assignee.firstName} ${item.assignee.lastName}`.trim()
              : "—",
            createdAt: item.createdAt,
            createdBy: item.creator
              ? `${item.creator.firstName} ${item.creator.lastName}`.trim()
              : "—",
            feedback: item.feedback || undefined,
            cancellationReason: item.cancellationReason || undefined,
          }));
          setSiteVisits(mapped);
          setTotalItems(res.data.pagination?.total ?? mapped.length);
        } else if (!silent) {
          setSiteVisits([]);
          setTotalItems(0);
        }
      } catch {
        if (!silent) {
          toast({ title: "Error", description: "Failed to load site visits", variant: "destructive" as any });
          setSiteVisits([]);
          setTotalItems(0);
        }
      } finally {
        if (!silent) setIsLoading(false);
      }
    };
    void fetchSiteVisits(false);
    const refreshTimer = window.setInterval(() => {
      if (!scheduleOpenRef.current) void fetchSiteVisits(true);
    }, 60_000);
    return () => window.clearInterval(refreshTimer);
  }, [currentPage, dateFrom, dateTo, filters.status, listViews.ready, listViews.queryKey, search, reloadKey, toast]);

  React.useEffect(() => subscribeToSiteVisitListUpdates(() => {
    setReloadKey((current) => current + 1);
  }), []);

  const openScheduleDialog = async () => {
    setScheduleError("");
    setLeads([]);
    setProjects([]);
    setSelectedLeadId("");
    setSelectedProjectId("");
    setScheduleOpen(true);
    setScheduleLoading(true);
    try {
      const [leadResponse, projectResults] = await Promise.all([
        leadApi.list({ page: 1, limit: 100 }),
        projectApi.listAll({ isActive: true }),
      ]);
      const availableLeads = leadResponse.data.data || [];
      setLeads(availableLeads);
      setProjects(projectResults);
      setSelectedLeadId(availableLeads[0]?.id || "");
      setSelectedProjectId(projectResults[0]?.id || "");
      if (!availableLeads.length) setScheduleError("Create or assign a lead before scheduling a site visit.");
      else if (!projectResults.length) setScheduleError("Add an active project before scheduling a site visit.");
      const localDateTime = dateTimeInputValue();
      setScheduledDate(localDateTime.slice(0, 10));
      setScheduledTime(localDateTime.slice(11, 16));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load leads and projects.";
      setScheduleError(message);
    } finally {
      setScheduleLoading(false);
    }
  };

  const submitSiteVisit = async () => {
    if (!selectedLeadId || !selectedProjectId || !scheduledDate || !scheduledTime || !scheduleNotes.trim()) {
      setScheduleError("Select a lead and project, then enter the visit date, time, and reason.");
      return;
    }
    try {
      setScheduleSaving(true);
      setScheduleError("");
      await siteVisitApi.create({
        leadId: selectedLeadId,
        projectId: selectedProjectId,
        scheduledAt: crmLocalDateTimeToDate(scheduledDate, scheduledTime, getTenantTimezone()).toISOString(),
        notes: scheduleNotes.trim(),
      });
      setScheduleOpen(false);
      setScheduleNotes("");
      setReloadKey((current) => current + 1);
      toast({ title: "Site visit scheduled", description: "The visit was added to the schedule." });
    } catch (error: any) {
      setScheduleError(error?.response?.data?.error || error?.message || "Unable to schedule the site visit.");
    } finally {
      setScheduleSaving(false);
    }
  };

  const changeScheduledDate = (field: "from" | "to", value: string) => {
    const nextFrom = field === "from" ? value : dateFrom;
    const nextTo = field === "to" ? value : dateTo;
    if (nextFrom && nextTo && nextFrom > nextTo) {
      setDateError("To Date cannot be earlier than From Date.");
      return;
    }
    setDateError("");
    if (field === "from") setDateFrom(value);
    else setDateTo(value);
    setCurrentPage(1);
  };

  return (
    <div className="space-y-4">
      <ListPageHeader
        icon={<MapPin className="h-6 w-6" />}
        title="Site Visits"
        subtitle="Schedule and track project site visits"
        view={listViews.control}
        actions={canScheduleSiteVisit ? (
          <Button className={`${listPageActionClassName} bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-sm shadow-blue-200 hover:from-blue-700 hover:to-blue-600`} onClick={() => void openScheduleDialog()}>
            <Plus className="h-4 w-4" />
            Schedule Visit
          </Button>
        ) : null}
      />

      {listViews.dialog}
      <div className="space-y-4">
        <CommonFilterPanel
          onReset={() => {
            setFilters({ status: "" });
            setSearch("");
            setDateFrom("");
            setDateTo("");
            setDateError("");
            setCurrentPage(1);
          }}
        >
          <FilterSearch
            value={search}
            onChange={(value) => {
              setSearch(value);
              setCurrentPage(1);
            }}
            placeholder="Search visits, leads, or companies..."
          />
          <FilterSelect
            label="Status"
            icon={Layers3}
            value={filters.status}
            onChange={(value) => {
              setFilters({ status: value });
              setCurrentPage(1);
            }}
            options={[
              { label: "All Statuses", value: "" },
              { label: "Scheduled", value: "SCHEDULED" },
              { label: "Completed", value: "COMPLETED" },
              { label: "Cancelled", value: "CANCELLED" },
              { label: "Missed", value: "MISSED" },
              { label: "Rescheduled", value: "RESCHEDULED" },
            ]}
          />
          <FilterDate
            id="site-visit-from"
            label="From Date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(value) => changeScheduledDate("from", value)}
          />
          <FilterDate
            id="site-visit-to"
            label="To Date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(value) => changeScheduledDate("to", value)}
          />
        </CommonFilterPanel>
        {dateError && <p role="alert" className="text-xs font-medium text-rose-700">{dateError}</p>}

        <DataTable
          columns={columns}
          data={siteVisits}
            isLoading={isLoading}
            totalItems={totalItems}
            currentPage={currentPage}
            onPageChange={setCurrentPage}
            serverPagination
            theme="blue"
            sorting={listViews.sorting ? [listViews.sorting] : []}
            onSortingChange={(next) => {
              listViews.onSortingChange(next[0] || null);
              setCurrentPage(1);
            }}
          />
      </div>

      <Dialog open={scheduleOpen} onOpenChange={(open) => !scheduleSaving && setScheduleOpen(open)}>
        <DialogContent className="crm-sky border-sky-100 bg-white [&_button.border]:border-sky-200 [&_button.border]:text-[#075d91] [&_label]:font-semibold [&_label]:text-[#1479a8] [&_[role=combobox]]:border-sky-200 [&_input]:border-sky-200">
          <DialogHeader>
            <DialogTitle className="font-bold text-[#075d91]">Schedule Site Visit</DialogTitle>
            <DialogDescription className="text-[#1479a8]">Choose the lead, project, and visit time.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="schedule-lead">Lead</Label>
              <select id="schedule-lead" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={selectedLeadId} onChange={(event) => setSelectedLeadId(event.target.value)} disabled={scheduleLoading || !leads.length}>
                <option value="">Select a lead</option>
                {leads.map((lead) => <option key={lead.id} value={lead.id}>{[lead.leadNumber, lead.firstName, lead.lastName].filter(Boolean).join(" ")}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="schedule-project">Project</Label>
              <select id="schedule-project" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)} disabled={scheduleLoading || !projects.length}>
                <option value="">Select a project</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </div>
            <div className="crm-pair">
              <div className="space-y-2">
                <Label htmlFor="schedule-date">Visit date</Label>
                <Input id="schedule-date" type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="schedule-time">Visit time</Label>
                <Input id="schedule-time" type="time" value={scheduledTime} onChange={(event) => setScheduledTime(event.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="schedule-notes">Reason / notes</Label>
              <textarea id="schedule-notes" className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm" value={scheduleNotes} onChange={(event) => setScheduleNotes(event.target.value)} maxLength={2000} />
            </div>
            {scheduleLoading && <p className="text-sm text-muted-foreground">Loading leads and projects…</p>}
            {scheduleError && <p role="alert" className="text-sm text-destructive">{scheduleError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setScheduleOpen(false)} disabled={scheduleSaving}>Cancel</Button>
            <Button onClick={() => void submitSiteVisit()} disabled={scheduleLoading || scheduleSaving || !leads.length || !projects.length}>
              {scheduleSaving ? "Scheduling…" : "Schedule Visit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

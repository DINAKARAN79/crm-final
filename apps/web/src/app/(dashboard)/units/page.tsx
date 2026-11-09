"use client";

import * as React from "react";
import Link from "next/link";
import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/crm/data-table";
import { Building2, Layers3 } from "lucide-react";
import { CommonFilterPanel, FilterSearch, FilterSelect } from "@/components/crm/common-filter-panel";
import { useListView } from "@/components/crm/list-view-control";
import { ListPageHeader } from "@/components/crm/list-page-header";
import { projectApi, unitApi } from "@/lib/api";
import { subscribeToUnitInventoryUpdates } from "@/lib/unit-inventory-events";
import { useToast } from "@/hooks/use-toast";

interface Unit {
  id: string;
  unitCode?: string | null;
  number: string;
  type: string | null;
  floor: number | null;
  area: number | null;
  price: number | null;
  status: string;
  project: { id: string; name: string } | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
}

const formatCurrency = (amount: number | null) =>
  amount == null
    ? "—"
    : new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
      }).format(amount);

const statusColors: Record<string, string> = {
  AVAILABLE: "bg-green-100 text-green-800",
  HOLD: "bg-amber-100 text-amber-800",
  RESERVED: "bg-blue-100 text-blue-800",
  BOOKED: "bg-violet-100 text-violet-800",
  SOLD: "bg-slate-100 text-slate-800",
  BLOCKED: "bg-red-100 text-red-800",
};

const STATUS_OPTIONS = ["AVAILABLE", "RESERVED", "BOOKED"];

const columns: ColumnDef<Unit>[] = [
  {
    accessorKey: "number",
    header: "Unit",
    cell: ({ row }) => (
      <Link href={`/units/${row.original.id}`} className="font-semibold text-[#075d91] hover:underline">
        {row.original.unitCode || row.original.number}
      </Link>
    ),
  },
  {
    id: "project",
    header: "Project",
    cell: ({ row }) => {
      const project = row.original.project;
      return project ? (
        <Link href={`/projects/${project.id}`} className="text-[#1479a8] hover:underline">
          {project.name}
        </Link>
      ) : "—";
    },
  },
  { accessorKey: "type", header: "Type", cell: ({ row }) => row.original.type || "—" },
  { accessorKey: "floor", header: "Floor", cell: ({ row }) => row.original.floor ?? "—" },
  {
    accessorKey: "area",
    header: "Area",
    cell: ({ row }) => row.original.area == null ? "—" : `${row.original.area} sq ft`,
  },
  {
    accessorKey: "price",
    header: "Price",
    cell: ({ row }) => formatCurrency(row.original.price),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge className={statusColors[row.original.status] || "bg-gray-100 text-gray-800"}>
        {row.original.status.replace(/_/g, " ")}
      </Badge>
    ),
  },
];

export default function UnitsPage() {
  const { toast } = useToast();
  const listViews = useListView("UNIT");
  const [units, setUnits] = React.useState<Unit[]>([]);
  const [pagination, setPagination] = React.useState<Pagination>({ page: 1, limit: 20, total: 0 });
  const [search, setSearch] = React.useState("");
  const [projectFilter, setProjectFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [projectOptions, setProjectOptions] = React.useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    projectApi
      .listAll()
      .then((all) => setProjectOptions(all.map((p: any) => ({ id: p.id, name: p.name }))))
      .catch(() => setProjectOptions([]));
  }, []);

  const loadUnits = React.useCallback(async (page: number, query: string) => {
    if (!listViews.ready) return;
    setLoading(true);
    setError("");
    try {
      const response = await unitApi.list({ page, limit: pagination.limit, search: query || undefined, projectId: projectFilter || undefined, status: statusFilter || undefined, ...listViews.params });
      setUnits(response.data.data || []);
      setPagination(response.data.pagination || { page, limit: pagination.limit, total: 0 });
    } catch (requestError: any) {
      const message = requestError?.response?.data?.error || "Unable to load units.";
      setError(message);
      toast({ title: "Unable to load units", description: message, variant: "destructive" as any });
    } finally {
      setLoading(false);
    }
  }, [pagination.limit, toast, projectFilter, statusFilter, listViews.ready, listViews.queryKey]);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      void loadUnits(1, search.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [loadUnits, search]);

  React.useEffect(
    () => subscribeToUnitInventoryUpdates(() => void loadUnits(pagination.page, search.trim())),
    [loadUnits, pagination.page, search],
  );

  return (
    <div className="space-y-4">
      <ListPageHeader
        icon={<Building2 className="h-6 w-6" />}
        title="Units"
        subtitle="Browse inventory across your projects."
        view={listViews.control}
      />

      {listViews.dialog}
      <CommonFilterPanel
        onReset={() => {
          setSearch("");
          setProjectFilter("");
          setStatusFilter("");
        }}
      >
        <FilterSearch
          id="unit-search"
          value={search}
          onChange={setSearch}
          placeholder="Search unit number or type..."
        />
        <FilterSelect
          label="Project"
          icon={Building2}
          value={projectFilter}
          onChange={setProjectFilter}
          options={[
            { label: "All Projects", value: "" },
            ...projectOptions.map((project) => ({ label: project.name, value: project.id })),
          ]}
        />
        <FilterSelect
          label="Status"
          icon={Layers3}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { label: "All Statuses", value: "" },
            ...STATUS_OPTIONS.map((status) => ({
              label: status.charAt(0) + status.slice(1).toLowerCase(),
              value: status,
            })),
          ]}
        />
      </CommonFilterPanel>

      <Card className="rounded-xl border-sky-100 shadow-sm">
        <CardContent className="space-y-4 p-4">
          {error ? (
            <div className="space-y-3 py-6 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" onClick={() => void loadUnits(pagination.page, search.trim())}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="[&_th]:bg-sky-50 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:text-[#1479a8] [&_tbody_td]:text-[#075d91]">
              <DataTable
                columns={columns}
                data={units}
                isLoading={loading}
                pageSize={pagination.limit}
                currentPage={pagination.page}
                totalItems={pagination.total}
                serverPagination
                onPageChange={(page) => void loadUnits(page, search.trim())}
                sorting={listViews.sorting ? [listViews.sorting] : []}
                onSortingChange={(next) => listViews.onSortingChange(next[0] || null)}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

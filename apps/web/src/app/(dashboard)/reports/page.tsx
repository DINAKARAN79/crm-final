"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FileBarChart2, Folder, FolderOpen, Loader2, MoreHorizontal, Plus, RefreshCw, Search, X } from "lucide-react";
import { CommonFilterPanel, FilterSearch } from "@/components/crm/common-filter-panel";
import { Button } from "@/components/ui/button";
import { exportReportCsv } from "@/lib/report-export";
import { useAuth } from "@/contexts/auth-context";
import { companyApi } from "@/lib/api";
import { formatDateShort, formatDateTime } from "@/lib/date-format";

type ReportView = "recent" | "createdByMe" | "private" | "public" | "all" | "favorites";
type FolderView = "all" | "createdByMe" | "sharedWithMe" | "favorites";

interface CompanyOption { id: string; name: string; }
interface ReportFolder { id: string; tenantId: string; tenant?: CompanyOption; name: string; description?: string | null; isShared: boolean; visibility?: "PRIVATE" | "PUBLIC" | "SHARED"; createdBy: string; createdByName?: string; ownerName?: string; modifiedBy?: string | null; modifiedByName?: string; isFavorite?: boolean; isDeleted?: boolean; deletedAt?: string | null; createdAt: string; updatedAt: string; _count?: { reports: number }; }
interface Report { id: string; tenantId: string; tenant?: CompanyOption; name: string; description?: string | null; type: string; objectName: string; isShared: boolean; createdBy: string; createdByName?: string; createdAt: string; updatedAt?: string; isFavorite?: boolean; folder?: { id: string; name: string } | null; }
interface ReportPage { items: Report[]; pagination: { page: number; limit: number; total: number; totalPages: number }; }
interface ReportType { name: string; object?: string; label: string; category: string; fields: { key: string; label: string; type: string }[]; }

function formatReportDate(value: string | null | undefined, withTime = false) {
  if (!value) return "—";
  return withTime ? formatDateTime(value) : formatDateShort(value);
}

const viewLabels: Record<ReportView, string> = { recent: "Recent", createdByMe: "Created by Me", private: "Private Reports", public: "Public Reports", all: "All Reports", favorites: "All Favorites" };
const reportViewLabels: Record<Exclude<ReportView, "favorites">, string> = { recent: "Recent", createdByMe: "Created by Me", private: "Private Reports", public: "Public Reports", all: "All Reports" };

async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
    throw new Error("Authentication required");
  }
  const text = await response.text();
  let data: { success?: boolean; data?: T; error?: string; message?: string } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `Request failed (${response.status})`);
  }
  if (!response.ok || !data.success) throw new Error(data.error || data.message || "Request failed");
  return data.data as T;
}

function withTenantId(path: string, tenantId?: string) {
  if (!tenantId) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("tenantId", tenantId);
  return `${url.pathname}${url.search}`;
}

export default function ReportsPage() {
  return (
    <React.Suspense fallback={<div className="min-h-[620px] rounded-lg border bg-card" />}>
      <ReportsContent />
    </React.Suspense>
  );
}

function ReportsContent() {
  const { hasEffectivePermission, hasFullAccess, isSuperAdmin, tenant } = useAuth();
  const canCreateReports = isSuperAdmin || hasFullAccess || hasEffectivePermission("REPORT_CREATE");
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isFoldersPage = searchParams.get("section") === "folders";
  const [reports, setReports] = React.useState<Report[]>([]);
  const [folders, setFolders] = React.useState<ReportFolder[]>([]);
  const viewParam = searchParams.get("view");
  const view: ReportView = viewParam && viewParam in viewLabels ? viewParam as ReportView : isSuperAdmin ? "all" : "recent";
  const folderViewParam = searchParams.get("folderView");
  const folderView: FolderView = folderViewParam === "createdByMe" || folderViewParam === "sharedWithMe" || folderViewParam === "favorites" ? folderViewParam : "all";
  const selectedFolderId = searchParams.get("folderId");
  const [search, setSearch] = React.useState("");
  const [reportPage, setReportPage] = React.useState(1);
  const [reportTotal, setReportTotal] = React.useState(0);
  const [reportTotalPages, setReportTotalPages] = React.useState(1);
  const [reportSort, setReportSort] = React.useState<{ field: "name" | "createdBy" | "createdAt" | "updatedAt"; order: "asc" | "desc" }>({ field: "createdAt", order: "desc" });
  const [pageSize] = React.useState(25);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [companies, setCompanies] = React.useState<CompanyOption[]>([]);
  const [createTenantId, setCreateTenantId] = React.useState("");
  const createCompanyId = isSuperAdmin ? createTenantId : tenant?.id || "";
  const [activeMenu, setActiveMenu] = React.useState<string | null>(null);
  const [folderMenu, setFolderMenu] = React.useState<string | null>(null);
  const [movingReport, setMovingReport] = React.useState<Report | null>(null);
  const [showFolderModal, setShowFolderModal] = React.useState(false);
  const [showMoveModal, setShowMoveModal] = React.useState(false);
  const [folderName, setFolderName] = React.useState("");
  const [folderUniqueName, setFolderUniqueName] = React.useState("");
  const [folderError, setFolderError] = React.useState("");
  const [folderSuccess, setFolderSuccess] = React.useState("");
  const [savingFolder, setSavingFolder] = React.useState(false);
  const [showCreateModal, setShowCreateModal] = React.useState(false);
  const [reportTypes, setReportTypes] = React.useState<ReportType[]>([]);
  const [reportTypeCategory, setReportTypeCategory] = React.useState("All");
  const [reportTypeSearch, setReportTypeSearch] = React.useState("");
  const [loadingReportTypes, setLoadingReportTypes] = React.useState(false);
  const [sharingReport, setSharingReport] = React.useState<Report | null>(null);
  const [shareUserId, setShareUserId] = React.useState("");
  const [shareRoleId, setShareRoleId] = React.useState("");
  const [shareAccessLevel, setShareAccessLevel] = React.useState<"VIEWER" | "EDITOR">("VIEWER");
  const [shareError, setShareError] = React.useState("");
  const [savingShare, setSavingShare] = React.useState(false);

  React.useEffect(() => {
    if (!isSuperAdmin) return;
    let active = true;
    void (async () => {
      try {
        const allCompanies: CompanyOption[] = [];
        let page = 1;
        let totalPages = 1;
        do {
          const response = await companyApi.list({ page, limit: 100, sortBy: "name", sortOrder: "asc" });
          if (!response.data.success) throw new Error(response.data.error || "Unable to load companies");
          allCompanies.push(...(response.data.data || []));
          totalPages = response.data.pagination?.totalPages || 1;
          page += 1;
        } while (page <= totalPages);
        if (!active) return;
        setCompanies(allCompanies);
        setCreateTenantId((current) => current || allCompanies[0]?.id || "");
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load companies");
      }
    })();
    return () => { active = false; };
  }, [isSuperAdmin]);

  const loadReportTypes = async (tenantId: string) => {
    if (!tenantId) {
      setError(isSuperAdmin ? "Select a company before creating a report." : "Unable to determine your company for report creation.");
      return;
    }
    try {
      setLoadingReportTypes(true);
      const response = await fetch(withTenantId("/api/proxy/api/reports/metadata", tenantId), { cache: "no-store" });
      const data = await readResponse<{ objects?: ReportType[] } | ReportType[]>(response);
      const rawTypes = Array.isArray(data) ? data : data.objects || [];
      const types = rawTypes
        .map((type: any) => ({
          ...type,
          name: type.name || type.objectName || type.object,
          object: type.object || type.objectName || type.name,
          label: type.label || type.name || type.object,
          category: type.category || type.label || type.object,
        }))
        .filter((type) => Boolean(type.name));
      setReportTypes(types);
    } catch (loadError) {
      window.alert(loadError instanceof Error ? loadError.message : "Unable to load report types");
    } finally {
      setLoadingReportTypes(false);
    }
  };

  const openCreateModal = async () => {
    setShowCreateModal(true);
    if (reportTypes.length > 0) return;
    await loadReportTypes(createCompanyId);
  };

  const reportCategories = ["Recently Used", "All", ...Array.from(new Set(reportTypes.map((type) => type.category)))];
  const visibleReportTypes = reportTypes.filter((type) => {
    const matchesCategory = reportTypeCategory === "All" || reportTypeCategory === "Recently Used" || type.category === reportTypeCategory;
    const query = reportTypeSearch.trim().toLowerCase();
    return matchesCategory && (!query || type.label.toLowerCase().includes(query) || type.name.toLowerCase().includes(query));
  });

  const loadReports = React.useCallback(async (showLoading = true) => {
    if (isFoldersPage) {
      setReports([]);
      if (showLoading) setLoading(false);
      return;
    }
    try {
      if (showLoading) setLoading(true);
      setError("");
      const params = new URLSearchParams({ view, page: String(reportPage), limit: String(pageSize), sortBy: reportSort.field, sortOrder: reportSort.order });
      if (isSuperAdmin) params.set("scope", "allCompanies");
      if (search.trim()) params.set("search", search.trim());
      if (selectedFolderId) params.set("folderId", selectedFolderId);
      const data = await readResponse<ReportPage>(await fetch(`/api/proxy/api/reports?${params}`, { cache: "no-store" }));
      setReports(Array.isArray(data?.items) ? data.items : []);
      setReportTotal(data?.pagination?.total || 0);
      setReportTotalPages(data?.pagination?.totalPages || 1);
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to load reports"); setReports([]); }
    finally { if (showLoading) setLoading(false); }
  }, [isFoldersPage, search, selectedFolderId, view, reportPage, pageSize, reportSort, isSuperAdmin]);

  const loadFolders = React.useCallback(async () => {
    try {
      const params = new URLSearchParams({ view: folderView });
      if (isSuperAdmin) params.set("scope", "allCompanies");
      const folderQuery = search.trim();
      if (folderQuery) params.set("search", folderQuery);
      const data = await readResponse<ReportFolder[]>(await fetch(`/api/proxy/api/report-folders?${params}`, { cache: "no-store" }));
      setFolders(Array.isArray(data) ? data : []);
    } catch { setFolders([]); }
  }, [folderView, search, isSuperAdmin]);

  React.useEffect(() => { const timer = window.setTimeout(() => void loadReports(), 350); return () => window.clearTimeout(timer); }, [loadReports]);
  React.useEffect(() => { setReportPage(1); }, [search, view, selectedFolderId, folderViewParam]);
  React.useEffect(() => { void loadFolders(); }, [loadFolders]);
  React.useEffect(() => { const close = () => setActiveMenu(null); window.addEventListener("click", close); return () => window.removeEventListener("click", close); }, []);

  const deleteReport = async (report: Report) => {
    if (!window.confirm(`Delete "${report.name}"?`)) return;
    try { await readResponse(await fetch(withTenantId(`/api/proxy/api/reports/${report.id}`, report.tenantId), { method: "DELETE" })); setReports((current) => current.filter((item) => item.id !== report.id)); void loadFolders(); }
    catch (err) { window.alert(err instanceof Error ? err.message : "Unable to delete report"); }
  };

  const cloneReport = async (report: Report) => {
    try {
      const cloned = await readResponse<Report>(await fetch(withTenantId(`/api/proxy/api/reports/${report.id}/clone`, report.tenantId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }));
      setReports((current) => [cloned, ...current]);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to clone report"); }
  };

  const toggleReportFavorite = async (report: Report) => {
    try {
      const method = report.isFavorite ? "DELETE" : "POST";
      await readResponse(await fetch(withTenantId(`/api/proxy/api/reports/${report.id}/favorite`, report.tenantId), { method }));
      setReports((current) => current.map((item) => item.id === report.id ? { ...item, isFavorite: !report.isFavorite } : item).filter((item) => view !== "favorites" || item.isFavorite));
      setActiveMenu(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to update favorite"); }
  };

  const toggleFolderFavorite = async (folder: ReportFolder) => {
    try {
      const method = folder.isFavorite ? "DELETE" : "POST";
      await readResponse(await fetch(withTenantId(`/api/proxy/api/report-folders/${folder.id}/favorite`, folder.tenantId), { method }));
      setFolders((current) => current.map((item) => item.id === folder.id ? { ...item, isFavorite: !folder.isFavorite } : item).filter((item) => folderView !== "favorites" || item.isFavorite));
      setFolderMenu(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to update favorite"); }
  };

  const shareReport = async () => {
    if (!sharingReport || (!shareUserId.trim() && !shareRoleId.trim())) {
      setShareError("Enter a user ID or role ID.");
      return;
    }
    try {
      setSavingShare(true); setShareError("");
      await readResponse(await fetch(withTenantId(`/api/proxy/api/reports/${sharingReport.id}/share`, sharingReport.tenantId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: shareUserId.trim() || undefined, roleId: shareRoleId.trim() || undefined, accessLevel: shareAccessLevel }) }));
      setSharingReport(null); setShareUserId(""); setShareRoleId(""); setShareAccessLevel("VIEWER");
    } catch (err) { setShareError(err instanceof Error ? err.message : "Unable to share report"); }
    finally { setSavingShare(false); }
  };

  const createFolder = async () => {
    const trimmedName = folderName.trim();
    const trimmedUniqueName = folderUniqueName.trim();
    if (!trimmedName || !trimmedUniqueName) {
      setFolderError("Folder Label and Folder Unique Name are required.");
      return;
    }
    try {
      setSavingFolder(true);
      setFolderError("");
      await readResponse(await fetch(withTenantId("/api/proxy/api/report-folders", createCompanyId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: trimmedName, uniqueName: trimmedUniqueName }) }));
      setFolderName(""); setFolderUniqueName(""); setShowFolderModal(false); setFolderSuccess("Folder created successfully"); void loadFolders();
      window.setTimeout(() => setFolderSuccess(""), 3500);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to create folder";
      setFolderError(message.includes("already exists") ? "A folder with this name already exists. Choose a different name." : "Unable to create folder. Please try again.");
    }
    finally { setSavingFolder(false); }
  };

  const moveReport = async (folderId: string | null) => {
    if (!movingReport) return;
    try {
      await readResponse(await fetch(withTenantId(`/api/proxy/api/reports/${movingReport.id}/move`, movingReport.tenantId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderId }) }));
      setShowMoveModal(false); setMovingReport(null); void loadReports(); void loadFolders();
    } catch (err) { window.alert(err instanceof Error ? err.message : "Unable to move report"); }
  };

  const navigateTo = (params: Record<string, string | null>) => {
    const nextParams = new URLSearchParams(searchParams.toString());
    Object.entries(params).forEach(([key, value]) => {
      if (value) nextParams.set(key, value);
      else nextParams.delete(key);
    });
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false });
  };

  const deleteFolder = async (folder: ReportFolder) => {
    if (!window.confirm(`Delete "${folder.name}"? Reports inside will be kept.`)) return;
    try {
      await readResponse(await fetch(withTenantId(`/api/proxy/api/report-folders/${folder.id}`, folder.tenantId), { method: "DELETE" }));
      setFolderMenu(null);
      void loadFolders();
    } catch (err) { window.alert(err instanceof Error ? err.message : "Unable to delete folder"); }
  };

  const renameFolder = async (folder: ReportFolder) => {
    const name = window.prompt("Folder name", folder.name)?.trim();
    if (!name || name === folder.name) return;
    try {
      await readResponse(await fetch(withTenantId(`/api/proxy/api/report-folders/${folder.id}`, folder.tenantId), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }));
      setFolderMenu(null);
      void loadFolders();
    } catch (err) { window.alert(err instanceof Error ? err.message : "Unable to rename folder"); }
  };

  const sidebarButton = (active: boolean) => `flex w-full items-center gap-2 border-l-4 px-4 py-2.5 text-left text-sm transition ${active ? "border-blue-600 bg-sky-100/70 font-semibold text-[#075d91]" : "border-transparent text-[#1479a8] hover:bg-sky-50"}`;
  const formatDate = (value: string) => formatReportDate(value, true);

  return <div className="space-y-4">
    {folderSuccess && <div role="status" className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{folderSuccess}</div>}
    <div className="flex flex-col gap-4 rounded-xl border border-sky-100 bg-gradient-to-br from-white to-sky-50 p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
      <div><p className="text-sm text-[#1479a8]">Reports</p><h1 className="text-xl font-bold tracking-tight text-[#075d91]">{isFoldersPage ? "All Folders" : viewLabels[view]}</h1><p className="mt-1 text-xs text-[#1479a8]">{isFoldersPage ? folders.length : reports.length} {(isFoldersPage ? folders.length : reports.length) === 1 ? "item" : "items"}</p></div>
      <div className="flex flex-wrap gap-2">
        {isSuperAdmin && <label className="flex items-center gap-2 text-sm text-[#075d91]">Create in
          <select aria-label="Company for new reports and folders" value={createTenantId} onChange={(event) => {
            const tenantId = event.target.value;
            setCreateTenantId(tenantId);
            setReportTypes([]);
            if (showCreateModal) void loadReportTypes(tenantId);
          }} className="h-9 max-w-56 rounded-md border border-sky-200 bg-white px-2 text-[13px]">
            {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>}
        {canCreateReports && <Button disabled={!createCompanyId} className="bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-sm shadow-blue-200 hover:from-blue-700 hover:to-blue-600" onClick={() => void openCreateModal()}><Plus className="mr-2 h-4 w-4" />New Report</Button>}{canCreateReports && <Button disabled={!createCompanyId} variant="outline" className="border-sky-200 bg-white text-[#075d91] hover:bg-sky-50" onClick={() => { setFolderError(""); setShowFolderModal(true); }}><Folder className="mr-2 h-4 w-4" />New Folder</Button>}
        <Button variant="outline" className="border-sky-200 bg-white text-[#075d91] hover:bg-sky-50" aria-label="Refresh reports" onClick={() => window.location.reload()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
      </div>
    </div>

    <CommonFilterPanel onReset={() => setSearch("")}>
      <FilterSearch
        value={search}
        onChange={setSearch}
        placeholder={isFoldersPage ? "Search all folders..." : "Search reports and folders..."}
      />
    </CommonFilterPanel>

    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-sky-100 bg-card shadow-sm lg:min-h-[620px] lg:flex-row">
      <aside className="w-full shrink-0 border-b border-sky-100 bg-[#f5fbff] py-4 lg:w-56 lg:border-b-0 lg:border-r">
        <NavHeading label="Reports" />
        {(Object.keys(reportViewLabels) as Exclude<ReportView, "favorites">[]).map((item) => (
          <button
            key={item}
            type="button"
            aria-current={view === item && !selectedFolderId && !folderViewParam ? "page" : undefined}
            className={sidebarButton(view === item && !selectedFolderId && !folderViewParam)}
            onClick={() => navigateTo({ section: null, view: item, folderView: null, folderId: null })}
          >
            {reportViewLabels[item]}
          </button>
        ))}

        <NavHeading label="Folders" />
        {([ ["all", "All Folders"], ["createdByMe", "Created by Me"], ["sharedWithMe", "Shared with Me"] ] as const).map(([item, label]) => (
          <button
            key={item}
            type="button"
            aria-current={folderViewParam === item && !selectedFolderId ? "page" : undefined}
            className={sidebarButton(folderViewParam === item && !selectedFolderId)}
            onClick={() => navigateTo({ section: "folders", view: "all", folderView: item, folderId: null })}
          >
            {label}
          </button>
        ))}
        <button type="button" aria-current={folderViewParam === "favorites" ? "page" : undefined} className={sidebarButton(folderViewParam === "favorites")} onClick={() => navigateTo({ section: "folders", view: "all", folderView: "favorites", folderId: null })}>Favorite Folders</button>

        <NavHeading label="Favorites" />
        <button
          type="button"
          aria-current={view === "favorites" ? "page" : undefined}
          className={sidebarButton(view === "favorites")}
          onClick={() => navigateTo({ section: null, view: "favorites", folderView: null, folderId: null })}
        >
          {viewLabels.favorites}
        </button>

      </aside>
      <main className="min-w-0 flex-1">{error && <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}{isFoldersPage ? <FolderTable folders={folders} folderMenu={folderMenu} onMenuChange={setFolderMenu} onOpen={(folder) => navigateTo({ section: null, view: "all", folderView: null, folderId: folder.id })} onRename={(folder) => void renameFolder(folder)} onDelete={(folder) => void deleteFolder(folder)} onFavorite={(folder) => void toggleFolderFavorite(folder)} /> : <div className="overflow-x-auto"><table className="w-full min-w-0 text-left text-sm"><thead><tr className="border-b border-sky-100 bg-sky-50 text-[#1479a8]"><th className="px-4 py-3 font-semibold">Report Name</th>{isSuperAdmin && <th className="px-4 py-3 font-semibold">Company</th>}<th className="px-4 py-3 font-semibold">Description</th><th className="px-4 py-3 font-semibold">Folder</th><th className="px-4 py-3 font-semibold">Created By</th><th className="px-4 py-3 font-semibold">Created On</th><th className="w-16 px-4 py-3" /></tr></thead><tbody>
        {loading && <tr><td colSpan={isSuperAdmin ? 7 : 6} className="px-4 py-16 text-center text-muted-foreground"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />Loading reports...</td></tr>}
        {!loading && reports.length === 0 && <tr><td colSpan={isSuperAdmin ? 7 : 6} className="px-4 py-16 text-center"><FileBarChart2 className="mx-auto mb-3 h-9 w-9 text-muted-foreground/40" /><p className="font-medium">{view === "favorites" ? "No favorite reports yet." : search ? "No reports match your search." : "No reports found."}</p></td></tr>}
        {!loading && reports.map((report) => {
          const detailHref = `/reports/${report.id}?tenantId=${encodeURIComponent(report.tenantId)}`;
          const editParams = new URLSearchParams({ edit: report.id, tenantId: report.tenantId });
          return <tr key={report.id} className="border-b transition hover:bg-sky-50/60"><td className="px-4 py-3"><Link href={detailHref} className="font-semibold text-[#075d91] hover:underline">{report.name}</Link></td>{isSuperAdmin && <td className="px-4 py-3 text-[#075d91]">{report.tenant?.name || "Company"}</td>}<td className="max-w-[240px] truncate px-4 py-3 text-[#075d91]">{report.description || `${report.objectName} ${report.type} report`}</td><td className="px-4 py-3">{report.folder ? <span className="flex items-center gap-2 text-primary"><FolderOpen className="h-4 w-4" />{report.folder.name}</span> : <span className="text-muted-foreground">-</span>}</td><td className="px-4 py-3 text-primary">{report.createdByName || report.createdBy}</td><td className="px-4 py-3 text-[#075d91]">{formatDate(report.createdAt)}</td><td className="relative px-4 py-3"><button type="button" aria-label={`Actions for ${report.name}`} onClick={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === report.id ? null : report.id); }} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-sky-200 text-[#075d91] hover:bg-sky-50"><MoreHorizontal className="h-4 w-4" /></button>{activeMenu === report.id && <div onClick={(event) => event.stopPropagation()} className="absolute right-4 top-11 z-20 w-48 rounded-md border bg-popover py-1 shadow-lg"><MenuItem label="Run" onClick={() => window.location.assign(detailHref)} /><MenuItem label="Open" onClick={() => window.location.assign(detailHref)} /><MenuItem label="Edit" onClick={() => window.location.assign(`/reports/new?${editParams.toString()}`)} /><MenuItem label="Clone" onClick={() => void cloneReport(report)} /><MenuItem label="Share" onClick={() => { setSharingReport(report); setActiveMenu(null); }} /><MenuItem label={report.isFavorite ? "Remove from Favorites" : "Add to Favorites"} onClick={() => void toggleReportFavorite(report)} /><MenuItem label="Export CSV" onClick={() => window.open(withTenantId(`/api/proxy/api/reports/${report.id}/export?format=csv`, report.tenantId), "_blank")} /><MenuItem label="Export Excel" onClick={() => window.open(withTenantId(`/api/proxy/api/reports/${report.id}/export?format=excel`, report.tenantId), "_blank")} /><MenuItem label="Export PDF" onClick={() => window.open(withTenantId(`/api/proxy/api/reports/${report.id}/export?format=pdf`, report.tenantId), "_blank")} /><MenuItem label="Delete" danger onClick={() => void deleteReport(report)} /><MenuItem label="Move" onClick={() => { setMovingReport(report); setShowMoveModal(true); }} /></div>}</td></tr>;
        })}
      </tbody></table></div>}</main>
    </div>

    {!isFoldersPage && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="font-medium">Sort:</span>{([ ["name", "Name"], ["createdBy", "Created By"], ["createdAt", "Created Date"], ["updatedAt", "Modified Date"] ] as const).map(([field, label]) => <button key={field} type="button" onClick={() => setReportSort((current) => current.field === field ? { field, order: current.order === "asc" ? "desc" : "asc" } : { field, order: "asc" })} className={`rounded-md border px-2.5 py-1.5 ${reportSort.field === field ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>{label} {reportSort.field === field ? (reportSort.order === "asc" ? "↑" : "↓") : ""}</button>)}</div>
      <div className="flex items-center gap-2"><span className="text-muted-foreground">{reportTotal === 0 ? "0 of 0" : `${(reportPage - 1) * pageSize + 1}-${Math.min(reportPage * pageSize, reportTotal)} of ${reportTotal}`}</span><Button variant="outline" size="sm" disabled={reportPage <= 1} onClick={() => setReportPage((page) => page - 1)}>Previous</Button><span className="min-w-16 text-center">Page {reportPage} of {reportTotalPages}</span><Button variant="outline" size="sm" disabled={reportPage >= reportTotalPages} onClick={() => setReportPage((page) => page + 1)}>Next</Button></div>
    </div>}

    {sharingReport && <Modal title={`Share ${sharingReport.name}`} onClose={() => { setSharingReport(null); setShareError(""); }}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Share this report with a user or role.</p>
        <Field label="User ID"><input value={shareUserId} onChange={(event) => setShareUserId(event.target.value)} className="mt-2 h-9 w-full rounded-md border px-3 text-[13px]" placeholder="Optional user ID" /></Field>
        <Field label="Role ID"><input value={shareRoleId} onChange={(event) => setShareRoleId(event.target.value)} className="mt-2 h-9 w-full rounded-md border px-3 text-[13px]" placeholder="Optional role ID" /></Field>
        <Field label="Permission"><select value={shareAccessLevel} onChange={(event) => setShareAccessLevel(event.target.value as "VIEWER" | "EDITOR")} className="mt-2 h-9 w-full rounded-md border px-3 text-[13px]"><option value="VIEWER">Viewer</option><option value="EDITOR">Editor</option></select></Field>
        {shareError && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{shareError}</p>}
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setSharingReport(null)}>Cancel</Button><Button disabled={savingShare} onClick={() => void shareReport()}>{savingShare ? "Sharing..." : "Share"}</Button></div>
      </div>
    </Modal>}
    {showFolderModal && (
      <Modal title="Create folder" onClose={() => { setShowFolderModal(false); setFolderError(""); }}>
        <div className="space-y-5">
          <Field label="Folder Label">
            <input
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createFolder(); } }}
              className="mt-2 h-9 w-full rounded-md border border-input bg-white px-3 text-[13px] text-slate-800 outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
              placeholder="Sales Reports"
              required
            />
          </Field>

          <Field label="Folder Unique Name">
            <input
              value={folderUniqueName}
              onChange={(event) => setFolderUniqueName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createFolder(); } }}
              className="mt-2 h-9 w-full rounded-md border border-input bg-white px-3 text-[13px] text-slate-800 outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
              placeholder="sales_reports"
              required
            />
          </Field>

          {folderError && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{folderError}</p>}

          <div className="flex justify-end gap-3 pt-4">
            <Button variant="outline" onClick={() => setShowFolderModal(false)} className="h-9 min-w-[96px] rounded-md border border-slate-300 bg-white text-[13px] font-medium text-slate-700">
              Cancel
            </Button>
            <Button disabled={savingFolder} onClick={() => void createFolder()} className="h-9 min-w-[96px] rounded-md bg-blue-600 text-[13px] font-medium text-white hover:bg-blue-700">
              {savingFolder ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </Modal>
    )}
    {showMoveModal && movingReport && <Modal title={`Move "${movingReport.name}"`} onClose={() => { setShowMoveModal(false); setMovingReport(null); }}><div className="space-y-2"><button className="flex w-full items-center gap-3 rounded-md border p-3 text-left text-sm hover:bg-muted" onClick={() => void moveReport(null)}><Folder className="h-4 w-4" />No Folder</button>{folders.filter((folder) => folder.tenantId === movingReport.tenantId).map((folder) => <button key={folder.id} className="flex w-full items-center justify-between rounded-md border p-3 text-left text-sm hover:bg-muted" onClick={() => void moveReport(folder.id)}><span className="flex items-center gap-3"><FolderOpen className="h-4 w-4 text-primary" />{folder.name}</span><span className="text-xs text-muted-foreground">{folder._count?.reports || 0}</span></button>)}</div></Modal>}
    {showCreateModal && <CreateReportWizard categories={reportCategories} selectedCategory={reportTypeCategory} onCategoryChange={setReportTypeCategory} search={reportTypeSearch} onSearchChange={setReportTypeSearch} reportTypes={visibleReportTypes} loading={loadingReportTypes} tenantId={createCompanyId} onClose={() => setShowCreateModal(false)} />}
  </div>;
}

function NavHeading({ label }: { label: string }) { return <p className="mb-2 mt-5 px-4 text-xs font-semibold uppercase tracking-wide text-[#278db8] first:mt-0">{label}</p>; }
function FolderTable({ folders, folderMenu, onMenuChange, onOpen, onRename, onDelete, onFavorite }: { folders: ReportFolder[]; folderMenu: string | null; onMenuChange: (id: string | null) => void; onOpen: (folder: ReportFolder) => void; onRename: (folder: ReportFolder) => void; onDelete: (folder: ReportFolder) => void; onFavorite: (folder: ReportFolder) => void }) {
  const formatDate = (value: string) => formatReportDate(value);
  return <div className="overflow-x-auto"><table className="w-full min-w-0 text-left text-sm"><thead><tr className="border-b border-sky-100 bg-sky-50 text-[#1479a8]"><th className="px-4 py-3 font-semibold">Name</th><th className="px-4 py-3 font-semibold">Company</th><th className="px-4 py-3 font-semibold">Created By</th><th className="px-4 py-3 font-semibold">Created On</th><th className="px-4 py-3 font-semibold">Last Modified By</th><th className="px-4 py-3 font-semibold">Last Modified Date</th><th className="w-16 px-4 py-3" /></tr></thead><tbody>{folders.length === 0 ? <tr><td colSpan={7} className="px-4 py-16 text-center"><Folder className="mx-auto mb-3 h-9 w-9 text-muted-foreground/40" /><p className="font-medium">No folders found.</p></td></tr> : folders.map((folder) => <tr key={folder.id} className="border-b transition hover:bg-muted/40"><td className="px-4 py-3"><button type="button" onClick={() => onOpen(folder)} className="font-medium text-primary hover:underline">{folder.name}</button><p className="mt-1 text-xs text-muted-foreground">{folder.visibility || (folder.isShared ? "PUBLIC" : "PRIVATE")} · {folder._count?.reports || 0} reports</p></td><td className="px-4 py-3 text-[#075d91]">{folder.tenant?.name || "Company"}</td><td className="px-4 py-3 text-primary">{folder.createdByName || folder.createdBy}</td><td className="px-4 py-3 text-muted-foreground">{formatDate(folder.createdAt)}</td><td className="px-4 py-3 text-primary">{folder.modifiedByName || folder.createdByName || folder.createdBy}</td><td className="px-4 py-3 text-muted-foreground">{formatDate(folder.updatedAt || folder.createdAt)}</td><td className="relative px-4 py-3"><button type="button" aria-label={`Actions for ${folder.name}`} onClick={(event) => { event.stopPropagation(); onMenuChange(folderMenu === folder.id ? null : folder.id); }} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-sky-200 text-[#075d91] hover:bg-sky-50"><MoreHorizontal className="h-4 w-4" /></button>{folderMenu === folder.id && <div onClick={(event) => event.stopPropagation()} className="absolute right-4 top-11 z-20 w-44 rounded-md border bg-popover py-1 shadow-lg"><MenuItem label="Open reports" onClick={() => onOpen(folder)} /><MenuItem label="Rename" onClick={() => onRename(folder)} /><MenuItem label={folder.isFavorite ? "Remove from Favorites" : "Add to Favorites"} onClick={() => onFavorite(folder)} /><MenuItem label="Delete" danger onClick={() => onDelete(folder)} /></div>}</td></tr>)}</tbody></table></div>;
}
function MenuItem({ label, onClick, danger = false, disabled = false }: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  if (label === "Open" || label === "Export Excel" || label === "Export PDF") return null;
  return <button type="button" disabled={disabled} className={`block w-full px-3 py-1.5 text-left text-sm ${disabled ? "cursor-not-allowed text-muted-foreground/50" : `hover:bg-muted ${danger ? "text-destructive" : ""}`}`} onClick={onClick}>{label}{disabled && <span className="ml-2 text-xs">Soon</span>}</button>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] font-semibold text-slate-800">{label}</label>
      {children}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-3xl rounded-md border border-slate-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.12)]">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-[16px] font-semibold tracking-[-0.03em] text-slate-800">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="text-slate-500 hover:text-slate-700">
            <X className="h-6 w-6" />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
function CreateReportWizard({ categories, selectedCategory, onCategoryChange, search, onSearchChange, reportTypes, loading, tenantId, onClose }: { categories: string[]; selectedCategory: string; onCategoryChange: (category: string) => void; search: string; onSearchChange: (value: string) => void; reportTypes: ReportType[]; loading: boolean; tenantId: string; onClose: () => void }) {
  const [selectedType, setSelectedType] = React.useState<ReportType | null>(null);
  const [format] = React.useState<"TABULAR" | "SUMMARY" | "MATRIX" | "JOINED">("TABULAR");
  const startBuilder = () => {
    const objectName = selectedType?.name || selectedType?.object || "";
    if (!objectName) return;
    const params = new URLSearchParams({ object: objectName, format, tenantId });
    window.location.assign(`/reports/new?${params.toString()}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Create Report</p><h2 className="text-xl font-semibold">Select Report Type</h2></div>
          <button type="button" aria-label="Close" onClick={onClose}><X className="h-5 w-5 text-muted-foreground" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <p className="mb-4 text-sm text-muted-foreground">Choose the data source for your report.</p>
          <div className="grid gap-4 md:grid-cols-[180px_1fr]">
            <aside className="space-y-1">{categories.map((category) => <button key={category} type="button" onClick={() => onCategoryChange(category)} className={`w-full rounded-md px-3 py-2 text-left text-sm ${selectedCategory === category ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"}`}>{category}</button>)}</aside>
            <main>
              <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#278db8]" /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search Report Types..." className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-[13px] outline-none focus:border-primary" /></div>
              {loading ? <p className="py-10 text-center text-sm text-muted-foreground">Loading report types...</p> : <div className="mt-3 grid gap-2">{reportTypes.map((type) => <button key={type.name} type="button" onClick={() => setSelectedType(type)} className={`flex items-center justify-between rounded-md border px-4 py-2 text-left text-sm ${selectedType?.name === type.name ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted"}`}><span className="font-medium">{type.label}</span><span className="text-xs text-muted-foreground">{type.category}</span></button>)}</div>}
            </main>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t px-6 py-4"><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!selectedType} onClick={startBuilder}>Open Report Builder</Button></div>
      </div>
    </div>
  );
}

function CreateReportModal({ categories, selectedCategory, onCategoryChange, search, onSearchChange, reportTypes, loading, onClose }: { categories: string[]; selectedCategory: string; onCategoryChange: (category: string) => void; search: string; onSearchChange: (value: string) => void; reportTypes: ReportType[]; loading: boolean; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div className="flex max-h-[min(680px,calc(100vh-2rem))] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-card shadow-2xl"><div className="flex items-center justify-between border-b px-6 py-4"><div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reports</p><h2 className="text-xl font-semibold">Create Report</h2></div><button type="button" aria-label="Close" onClick={onClose}><X className="h-5 w-5 text-muted-foreground" /></button></div><div className="grid min-h-0 flex-1 md:grid-cols-[190px_1fr]"><aside className="border-b bg-muted/30 p-3 md:border-b-0 md:border-r"><p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Category</p>{categories.map((category) => <button key={category} type="button" onClick={() => onCategoryChange(category)} className={`w-full rounded-md px-3 py-2 text-left text-sm ${selectedCategory === category ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"}`}>{category}</button>)}</aside><main className="min-h-0 overflow-y-auto p-5"><h3 className="text-lg font-semibold">Select a Report Type</h3><p className="mt-1 text-sm text-muted-foreground">Choose the data source for your report.</p><div className="relative mt-4"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#278db8]" /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search Report Types..." className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" /></div><div className="mt-5 grid grid-cols-[1fr_120px] border-b px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><span>Report Type Name</span><span>Category</span></div>{loading ? <div className="flex items-center justify-center py-12 text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading report types...</div> : reportTypes.length === 0 ? <div className="py-12 text-center text-sm text-muted-foreground">No report types found.</div> : reportTypes.map((type) => <Link key={type.name} href={`/reports/new?object=${encodeURIComponent(type.name)}`} onClick={onClose} className="grid grid-cols-[1fr_120px] items-center border-b px-3 py-2 text-sm transition hover:bg-muted"><span className="font-medium text-primary">{type.label}</span><span className="text-muted-foreground">{type.category}</span></Link>)}</main></div></div></div>;
}
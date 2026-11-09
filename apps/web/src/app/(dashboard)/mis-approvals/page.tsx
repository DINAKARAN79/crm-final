"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { Check, Clock3, ExternalLink, Layers3, Loader2, RefreshCw, X } from "lucide-react";
import { CommonFilterPanel, FilterDate, FilterSearch, FilterSelect } from "@/components/crm/common-filter-panel";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { crmDateRangeBounds, quotationDueLabel } from "@dct-crm/shared";
import { receiptApi } from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BookingCancellationRequests } from "@/components/crm/booking-cancellation-requests";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/date-format";
import { matchesApprovalPacketSearch } from "@/lib/mis-approval-search";
import { ListSortHeader, useListView, useRecordView } from "@/components/crm/list-view-control";

type ApprovalStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
type JsonRecord = Record<string, unknown>;

interface ApprovalPacket {
  id: string;
  receiptNumber: string;
  receiptDate: string;
  receivedFrom: string;
  amount: number;
  paymentMode: string;
  transactionId?: string | null;
  receivedDate: string;
  approvalStatus: ApprovalStatus;
  approvalSubmittedAt: string;
  approvalReviewedAt?: string | null;
  approvalNote?: string | null;
  lead: {
    id: string;
    leadNumber?: string | null;
    firstName?: string | null;
    lastName: string;
    company: string;
    mobile?: string | null;
    email?: string | null;
    status: string;
    owner?: { firstName: string; lastName: string; profile?: { name: string } | null } | null;
  };
  booking: {
    id: string;
    bookingNumber: string;
    status: string;
    bookingAmount: number;
    createdAt: string;
    referredBy?: string | null;
    firstApplicant: JsonRecord;
    secondApplicant?: JsonRecord | null;
    profession: JsonRecord;
    plotDetails: JsonRecord;
    project: { name: string; address?: string | null; city?: string | null };
    unit: { number: string; type?: string | null; area?: number | null; status: string };
    quotation: {
      quotationNumber: string;
      customerName: string;
      customerPhone?: string | null;
      customerEmail?: string | null;
      customerAddress?: string | null;
      projectName: string;
      unitNumber: string;
      unitType?: string | null;
      area: number;
      pricePerSqFt: number;
      basePrice: number;
      plcAmount: number;
      discountAmount: number;
      totalPrice: number;
      paymentPlanName: string;
      paymentPlan: { installments?: { milestone: string; percentage: number; dueMonths?: number; dueDays?: number }[] };
      terms?: string | null;
      siteVisit: { status: string; completedAt?: string | null; scheduledAt?: string | null };
    };
  };
  createdBy: { firstName: string; lastName: string };
  reviewedBy?: { firstName: string; lastName: string } | null;
}

interface RefundApproval {
  id: string;
  amount: number;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  reason: string;
  refundReference: string;
  status: ApprovalStatus;
  submittedAt: string;
  reviewedAt?: string | null;
  reviewedBy?: { firstName: string; lastName: string } | null;
  booking: { bookingNumber: string; status: string; project: { name: string }; unit: { number: string } };
  lead: { id: string; leadNumber?: string | null; firstName?: string | null; lastName: string };
  createdBy: { firstName: string; lastName: string };
  reviewNote?: string | null;
}

type QueueFilter = "PENDING_APPROVAL" | "REVIEWED" | "ALL";

const PAGE_SIZE = 10;

function statusLabel(status: ApprovalStatus) {
  if (status === "PENDING_APPROVAL") return "Pending";
  if (status === "APPROVED") return "Approved";
  return "Rejected";
}

function statusVariant(status: ApprovalStatus): "success" | "destructive" | "warning" {
  if (status === "APPROVED") return "success";
  if (status === "REJECTED") return "destructive";
  return "warning";
}

function customerName(packet: ApprovalPacket) {
  return packet.booking.quotation.customerName
    || `${packet.lead.firstName || ""} ${packet.lead.lastName}`.trim()
    || "—";
}

function siteVisitText(packet: ApprovalPacket) {
  const visit = packet.booking.quotation.siteVisit;
  const when = dateText(visit.completedAt || visit.scheduledAt);
  return when === "—" ? visit.status : `${visit.status} · ${when}`;
}

const currency = (amount: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount);
const dateText = (value?: string | null) => value ? formatDate(value) : "—";
const text = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return "—";
  return String(value);
};
const fullName = (applicant?: JsonRecord | null) =>
  [applicant?.salutation, applicant?.name].filter(Boolean).map(String).join(" ") || "—";

function Detail({ label, value, wide = false }: { label: string; value: unknown; wide?: boolean }) {
  return (
    <div className={`min-w-0 border-b border-slate-100 py-2 ${wide ? "sm:col-span-2 lg:col-span-3" : ""}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[#1479a8]">{label}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm font-medium text-slate-800">{text(value)}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-sky-100 bg-white p-4">
      <h3 className="mb-3 border-b border-sky-100 pb-2 text-sm font-semibold text-[#075d91]">{title}</h3>
      <div className="grid gap-x-5 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

const applicantFields: Array<[string, string]> = [
  ["Date of birth", "dateOfBirth"],
  ["Relationship", "relationType"],
  ["Relationship name", "relationshipName"],
  ["Nationality", "nationality"],
  ["Aadhaar number", "aadhaarNumber"],
  ["PAN number", "panNumber"],
  ["Email", "email"],
  ["Mobile number", "mobileNumber"],
  ["Alternate number", "alternateNumber"],
  ["Marital status", "maritalStatus"],
  ["State", "state"],
  ["District", "district"],
];

function ApplicantSection({ title, applicant }: { title: string; applicant?: JsonRecord | null }) {
  if (!applicant || !Object.values(applicant).some((value) => value !== null && value !== undefined && value !== "" && value !== false)) {
    return <Section title={title}><Detail label="Applicant" value="Not provided" /></Section>;
  }
  const photoUrl = typeof applicant.photoUrl === "string" && applicant.photoUrl.startsWith("data:image/")
    ? applicant.photoUrl
    : null;

  return (
    <Section title={`${title} · ${fullName(applicant)}`}>
      {photoUrl && (
        <div className="row-span-4 flex items-start py-2 lg:col-span-1 lg:row-span-5">
          <Image src={photoUrl} alt={`${title} photo`} width={96} height={112} unoptimized className="h-28 w-24 rounded-md border object-cover" />
        </div>
      )}
      {applicantFields.map(([label, key]) => (
        <Detail key={key} label={label} value={key === "dateOfBirth" && applicant[key] ? dateText(String(applicant[key])) : applicant[key]} />
      ))}
      <Detail label="Same as corresponding address" value={applicant.sameAddress} />
      <Detail label="Corresponding address" value={applicant.correspondingAddress} wide />
      <Detail label="Permanent address" value={applicant.permanentAddress} wide />
    </Section>
  );
}

const plotFields: Array<[string, string, "currency" | "area" | "number" | "text"]> = [
  ["Plot / unit number", "plotNumber", "text"],
  ["Project", "projectName", "text"],
  ["Unit type", "unitType", "text"],
  ["Facing direction", "facingDirection", "text"],
  ["Area", "areaSqFt", "area"],
  ["Area (cents)", "areaCent", "number"],
  ["Basic price", "basicPrice", "currency"],
  ["Total cost", "totalCostOfFlat", "currency"],
  ["Quotation number", "quotationNumber", "text"],
  ["Booking amount", "bookingAmount", "currency"],
];

function BookingPlotDetails({ details }: { details: JsonRecord }) {
  return (
    <Section title="Plot / Unit Details">
      {plotFields.map(([label, key, format]) => {
        const value = details[key];
        const formatted = value === null || value === undefined || value === ""
          ? "—"
          : format === "currency"
            ? currency(Number(value))
            : format === "area"
              ? `${Number(value).toLocaleString("en-IN")} sq ft`
              : format === "number"
                ? Number(value).toLocaleString("en-IN", { maximumFractionDigits: 3 })
                : value;
        return <Detail key={key} label={label} value={formatted} />;
      })}
    </Section>
  );
}

export default function MISApprovalsPage() {
  const { toast } = useToast();
  const { getLeadStatusLabel } = useAuth();
  const listViews = useListView("MIS_APPROVAL");
  const [packets, setPackets] = React.useState<ApprovalPacket[]>([]);
  const [refundPackets, setRefundPackets] = React.useState<RefundApproval[]>([]);
  const [filter, setFilter] = React.useState<QueueFilter>("ALL");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [dateError, setDateError] = React.useState("");
  const [currentPage, setCurrentPage] = React.useState(1);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  useRecordView("MIS_APPROVAL", selectedId || undefined);
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");
  const [reviewingId, setReviewingId] = React.useState<string | null>(null);

  const loadPackets = React.useCallback(async () => {
    if (!listViews.ready) return;
    setLoading(true);
    setLoadError("");
    try {
      const [response, refundResponse] = await Promise.all([
        receiptApi.listApprovals(listViews.params),
        receiptApi.listRefundApprovals(),
      ]);
      setPackets((response.data.data || []) as ApprovalPacket[]);
      setRefundPackets((refundResponse.data.data || []) as RefundApproval[]);
    } catch (cause) {
      console.error("Failed to load MIS approval packets:", cause);
      const message = (cause as { response?: { data?: { error?: string } } }).response?.data?.error;
      setLoadError(message || "Approval packets could not be loaded. Please retry.");
    } finally {
      setLoading(false);
    }
  }, [listViews.ready, listViews.queryKey]);

  React.useEffect(() => {
    void loadPackets();
  }, [loadPackets]);

  const filteredPackets = React.useMemo(() => {
    const range = crmDateRangeBounds(dateFrom || undefined, dateTo || undefined);
    const bounds = "error" in range ? null : range;
    return packets.filter((packet) => {
      const matchesStatus = filter === "ALL"
        || (filter === "REVIEWED" && packet.approvalStatus !== "PENDING_APPROVAL")
        || (filter === "PENDING_APPROVAL" && packet.approvalStatus === "PENDING_APPROVAL");
      if (!matchesStatus || !matchesApprovalPacketSearch(packet, searchQuery)) return false;
      if (!bounds?.gte && !bounds?.lt) return true;
      const submitted = new Date(packet.approvalSubmittedAt).getTime();
      if (Number.isNaN(submitted)) return false;
      if (bounds.gte && submitted < bounds.gte.getTime()) return false;
      if (bounds.lt && submitted >= bounds.lt.getTime()) return false;
      return true;
    });
  }, [packets, filter, searchQuery, dateFrom, dateTo]);

  const totalPages = Math.max(1, Math.ceil(filteredPackets.length / PAGE_SIZE));
  const page = Math.min(currentPage, totalPages);
  const pagePackets = filteredPackets.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selected = packets.find((packet) => packet.id === selectedId) || null;

  const changeSubmittedDate = (field: "from" | "to", value: string) => {
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

  const resetFilters = () => {
    setFilter("ALL");
    setSearchQuery("");
    setDateFrom("");
    setDateTo("");
    setDateError("");
    setCurrentPage(1);
  };

  const review = async (packet: ApprovalPacket, decision: "APPROVE" | "REJECT") => {
    setReviewingId(packet.id);
    try {
      const response = await receiptApi.reviewApproval(packet.id, {
        decision,
        note: notes[packet.id]?.trim() || undefined,
      });
      const assignedCRMUserId = response.data.data?.assignment?.assignedUserId as string | undefined;
      const bucketAssignment = response.data.data?.bucketAssignment;
      const bucketOwnerName = [bucketAssignment?.owner?.firstName, bucketAssignment?.owner?.lastName]
        .filter((name: unknown): name is string => typeof name === "string" && name.length > 0)
        .join(" ");
      setPackets((current) => current.map((item) => item.id === packet.id
        ? {
            ...item,
            approvalStatus: decision === "APPROVE" ? "APPROVED" : "REJECTED",
            approvalReviewedAt: new Date().toISOString(),
            approvalNote: notes[packet.id]?.trim() || null,
          }
        : item));
      toast({
        title: decision === "APPROVE" ? "Packet approved" : "Packet rejected",
        description: decision === "APPROVE"
          ? bucketAssignment?.moved && bucketOwnerName
            ? `Lead moved to Booked Bucket owner ${bucketOwnerName}. The original CRM booking owner remains recorded.`
            : `The lead was assigned to CRM${assignedCRMUserId ? ` (${assignedCRMUserId})` : ""} by round robin.`
          : "The packet was rejected and the reserved unit was released.",
      });
    } catch (cause) {
      console.error(`Failed to ${decision.toLowerCase()} approval packet:`, cause);
      const message = (cause as { response?: { data?: { error?: string } } }).response?.data?.error;
      toast({
        title: decision === "APPROVE" ? "Could not approve packet" : "Could not reject packet",
        description: message || "Please refresh and try again.",
        variant: "destructive",
      });
    } finally {
      setReviewingId(null);
    }
  };

  const reviewRefund = async (packet: RefundApproval, decision: "APPROVE" | "REJECT") => {
    setReviewingId(packet.id);
    try {
      const response = await receiptApi.reviewRefundApproval(packet.id, {
        decision,
        note: notes[packet.id]?.trim() || undefined,
      });
      const updated = response.data.data as RefundApproval;
      setRefundPackets((current) => current.map((item) => item.id === packet.id ? updated : item));
      toast({
        title: decision === "APPROVE" ? "Refund approved" : "Refund rejected",
        description: decision === "APPROVE"
          ? `${currency(packet.amount)} was approved. The booking remains unchanged.`
          : "The request was rejected and no payment balance was changed.",
      });
    } catch (cause) {
      console.error(`Failed to ${decision.toLowerCase()} refund request:`, cause);
      const message = (cause as { response?: { data?: { error?: string } } }).response?.data?.error;
      toast({ title: "Could not review refund", description: message || "Please refresh and try again.", variant: "destructive" });
    } finally {
      setReviewingId(null);
    }
  };

  return (
    <div className="crm-sky mx-auto w-full max-w-none space-y-5 p-4 md:p-6 [&_button.border]:border-sky-200 [&_button.border]:text-[#075d91] [&_button.border:hover]:bg-sky-50">
      <BookingCancellationRequests />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#1479a8]">MIS Team</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-[#075d91]">Commercial Approvals</h1>
            {listViews.control}
          </div>
          <p className="mt-1 text-sm text-[#1479a8]">Review the quotation, booking, and receipt together before handing an approved lead to CRM.</p>
        </div>
        <Button type="button" variant="outline" onClick={() => void loadPackets()} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Refresh
        </Button>
      </div>

      {loadError && (
        <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <p role="alert" className="text-sm text-rose-700">{loadError}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadPackets()}>Retry</Button>
        </CardContent></Card>
      )}

      {listViews.dialog}
      <CommonFilterPanel className="crm-filter-panel-inline" onReset={resetFilters}>
        <FilterSearch
          id="mis-approval-search"
          value={searchQuery}
          onChange={(value) => {
            setSearchQuery(value);
            setCurrentPage(1);
          }}
          placeholder="Search receipt, lead, booking, customer..."
        />
        <FilterSelect
          id="mis-approval-status"
          label="Status"
          icon={Layers3}
          value={filter}
          onChange={(value) => {
            setFilter(value as QueueFilter);
            setCurrentPage(1);
          }}
          options={([
            ["ALL", "All packets"],
            ["PENDING_APPROVAL", "Pending"],
            ["REVIEWED", "Reviewed"],
          ] as const).map(([value, label]) => {
            const count = value === "PENDING_APPROVAL"
              ? packets.filter((packet) => packet.approvalStatus === value).length
              : value === "REVIEWED"
                ? packets.filter((packet) => packet.approvalStatus !== "PENDING_APPROVAL").length
                : packets.length;
            return { label: `${label} (${count})`, value };
          })}
        />
        <FilterDate
          id="mis-approval-from"
          label="From Date"
          value={dateFrom}
          max={dateTo || undefined}
          onChange={(value) => changeSubmittedDate("from", value)}
        />
        <FilterDate
          id="mis-approval-to"
          label="To Date"
          value={dateTo}
          min={dateFrom || undefined}
          onChange={(value) => changeSubmittedDate("to", value)}
        />
      </CommonFilterPanel>
      {dateError && <p role="alert" className="text-sm text-rose-700">{dateError}</p>}

      {loading ? (
        <Card><CardContent className="flex items-center justify-center gap-2 py-14 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading approval packets…</CardContent></Card>
      ) : filteredPackets.length === 0 ? (
        <Card className="rounded-xl border-sky-100 bg-white"><CardContent className="py-14 text-center">
          <Clock3 className="mx-auto h-8 w-8 text-sky-300" />
          <p className="mt-3 text-sm font-semibold text-[#075d91]">
            {searchQuery.trim() || dateFrom || dateTo
              ? "No approval packets match these filters"
              : filter === "PENDING_APPROVAL"
                ? "No packets are waiting for MIS approval"
                : "No packets found"}
          </p>
          <p className="mt-1 text-xs text-[#1479a8]">
            {searchQuery.trim() || dateFrom || dateTo
              ? "Try a receipt, lead, customer, project, unit, or a different submitted-date range."
              : "Submitted receipt packets will appear here."}
          </p>
        </CardContent></Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-sky-100 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
              <caption className="sr-only">Commercial approvals</caption>
              <thead className="bg-[#f5fbff] text-[11px] font-semibold uppercase tracking-wide text-[#1479a8]">
                <tr>
                  {([
                    ["receiptNumber", "Receipt Number"],
                    ["leadNumber", "Lead Number"],
                    ["customer", "Customer Name"],
                    ["project", "Project"],
                    ["unit", "Unit"],
                    ["total", "Quotation Total"],
                    ["", "Site Visit"],
                    ["approvalStatus", "Approval Status"],
                    ["approvalSubmittedAt", "Submitted Date"],
                    ["", "Actions"],
                  ] as const).map(([column, heading]) => (
                    <th key={heading} className="whitespace-nowrap px-3 py-2.5">
                      {column ? <ListSortHeader label={heading} column={column} sorting={listViews.sorting} onSortingChange={listViews.onSortingChange} /> : heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagePackets.map((packet) => (
                  <tr
                    key={packet.id}
                    className="cursor-pointer border-t border-sky-50 hover:bg-sky-50/70"
                    onClick={() => setSelectedId(packet.id)}
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-[#075d91]">{packet.receiptNumber}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{packet.lead.leadNumber || "—"}</td>
                    <td className="max-w-[12rem] truncate px-3 py-2.5 text-slate-800">{customerName(packet)}</td>
                    <td className="max-w-[11rem] truncate px-3 py-2.5 text-slate-700">{packet.booking.project.name}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{packet.booking.unit.number}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-800">{currency(packet.booking.quotation.totalPrice)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{siteVisitText(packet)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5"><Badge variant={statusVariant(packet.approvalStatus)}>{statusLabel(packet.approvalStatus)}</Badge></td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{dateText(packet.approvalSubmittedAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(packet.id);
                        }}
                      >
                        View Details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-sky-100 px-3 py-2.5 text-xs text-[#1479a8]">
            <span>Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredPackets.length)} of {filteredPackets.length}</span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setCurrentPage(page - 1)}>Previous</Button>
              <span className="min-w-16 text-center text-slate-600">Page {page} of {totalPages}</span>
              <Button type="button" variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setCurrentPage(page + 1)}>Next</Button>
            </div>
          </div>
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between border-b border-sky-100 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[#075d91]">Refund Requests</h2>
            <p className="text-xs text-slate-500">Refund approval changes the paid balance only; it does not cancel the booking.</p>
          </div>
          <Badge variant="secondary">{refundPackets.filter((packet) => packet.status === "PENDING_APPROVAL").length} pending</Badge>
        </div>
        {refundPackets.length === 0 ? (
          <CardContent className="py-6 text-center text-sm text-slate-500">No refund requests have been submitted.</CardContent>
        ) : (
          <div className="divide-y">
            {refundPackets.map((packet) => (
              <div key={packet.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-[14rem] flex-1">
                  <p className="text-sm font-semibold text-slate-800">{packet.refundReference} · {packet.customerName}</p>
                  <p className="text-xs text-slate-500">
                    {packet.booking.bookingNumber} · {packet.booking.project.name} · Unit {packet.booking.unit.number}
                    {" · "}{packet.lead.leadNumber || packet.lead.id} · Submitted {dateText(packet.submittedAt)}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">{packet.reason}</p>
                  <p className="text-xs text-slate-500">{packet.customerPhone || "No phone"} · {packet.customerEmail || "No email"}</p>
                  {packet.reviewedBy && (
                    <p className="text-xs text-slate-500">
                      Reviewed by {[packet.reviewedBy.firstName, packet.reviewedBy.lastName].filter(Boolean).join(" ")}
                      {packet.reviewedAt ? ` · ${dateText(packet.reviewedAt)}` : ""}
                    </p>
                  )}
                </div>
                <p className="text-sm font-semibold text-slate-900">{currency(packet.amount)}</p>
                <Badge variant={statusVariant(packet.status)}>{statusLabel(packet.status)}</Badge>
                {packet.status === "PENDING_APPROVAL" && (
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={reviewingId !== null} onClick={() => void reviewRefund(packet, "REJECT")} className="text-rose-700">
                      {reviewingId === packet.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <X className="mr-1 h-4 w-4" />}Reject
                    </Button>
                    <Button type="button" size="sm" disabled={reviewingId !== null} onClick={() => void reviewRefund(packet, "APPROVE")} className="bg-emerald-700 text-white hover:bg-emerald-800">
                      {reviewingId === packet.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}Approve
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
        <DialogContent className="crm-approval-dialog gap-0 p-0" showClose={false}>
          {selected && (
            <>
              <DialogHeader className="relative shrink-0 border-b border-sky-100 bg-[#f5fbff] px-5 py-4 pr-28 text-left">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-[#075d91]">{selected.receiptNumber}</DialogTitle>
                  <Badge variant={statusVariant(selected.approvalStatus)}>{statusLabel(selected.approvalStatus)}</Badge>
                </div>
                <DialogDescription className="text-[#1479a8]">
                  {selected.lead.leadNumber || selected.lead.id} · {customerName(selected)} · Submitted {dateText(selected.approvalSubmittedAt)}
                </DialogDescription>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild type="button" variant="outline" size="sm">
                    <Link href={`/leads/${selected.lead.id}`}>Lead <ExternalLink className="ml-2 h-3.5 w-3.5" /></Link>
                  </Button>
                </div>
                <Button type="button" variant="outline" className="absolute right-4 top-4" onClick={() => setSelectedId(null)}>Exit</Button>
              </DialogHeader>
              <div className="crm-approval-dialog-body space-y-3 px-5 py-5">
                <Section title={`Quotation · ${selected.booking.quotation.quotationNumber}`}>
                  <Detail label="Project" value={selected.booking.quotation.projectName} />
                  <Detail label="Plot / Unit" value={`${selected.booking.quotation.unitNumber} · ${selected.booking.quotation.unitType || selected.booking.unit.type || "Unit"}`} />
                  <Detail label="Area" value={`${selected.booking.quotation.area.toLocaleString("en-IN")} sq ft`} />
                  <Detail label="Customer" value={selected.booking.quotation.customerName} />
                  <Detail label="Customer phone" value={selected.booking.quotation.customerPhone} />
                  <Detail label="Customer email" value={selected.booking.quotation.customerEmail} />
                  <Detail label="Rate" value={currency(selected.booking.quotation.pricePerSqFt)} />
                  <Detail label="Base price" value={currency(selected.booking.quotation.basePrice)} />
                  <Detail label="PLC / discount" value={`${currency(selected.booking.quotation.plcAmount)} / ${currency(selected.booking.quotation.discountAmount)}`} />
                  <Detail label="Quotation total" value={currency(selected.booking.quotation.totalPrice)} />
                  <Detail label="Payment plan" value={selected.booking.quotation.paymentPlanName} />
                  <Detail label="Site visit" value={siteVisitText(selected)} />
                  <Detail label="Site address" value={[selected.booking.project.address, selected.booking.project.city].filter(Boolean).join(", ")} wide />
                  {selected.booking.quotation.paymentPlan.installments?.map((item, index) => (
                    <Detail key={`${item.milestone}-${index}`} label={`Installment ${index + 1}`} value={`${item.milestone} · ${item.percentage}% · ${quotationDueLabel(item)}`} />
                  ))}
                  <Detail label="Customer address" value={selected.booking.quotation.customerAddress} wide />
                  <Detail label="Quotation terms" value={selected.booking.quotation.terms} wide />
                </Section>

                <Section title={`Booking · ${selected.booking.bookingNumber}`}>
                  <Detail label="Booking status" value={selected.booking.status} />
                  <Detail label="Booking date" value={dateText(selected.booking.createdAt)} />
                  <Detail label="Booking amount" value={currency(selected.booking.bookingAmount)} />
                  <Detail label="Reserved unit" value={`${selected.booking.unit.number} · ${selected.booking.unit.type || "Unit"} · ${selected.booking.unit.status}`} />
                  <Detail label="Lead / customer" value={`${selected.lead.firstName || ""} ${selected.lead.lastName}`.trim()} />
                  <Detail label="Lead phone" value={selected.lead.mobile} />
                  <Detail label="Lead email" value={selected.lead.email} />
                  <Detail label="Company" value={selected.lead.company} />
                  <Detail label="Lead status" value={getLeadStatusLabel(selected.lead.status)} />
                  <Detail label="Current owner" value={selected.lead.owner ? `${selected.lead.owner.firstName} ${selected.lead.owner.lastName} · ${selected.lead.owner.profile?.name || "—"}` : "Unassigned"} />
                  <Detail label="Organization type" value={selected.booking.profession.organizationType} />
                  <Detail label="Industry" value={selected.booking.profession.industry} />
                  <Detail label="Referred by" value={selected.booking.referredBy} />
                </Section>

                <BookingPlotDetails details={selected.booking.plotDetails} />
                <ApplicantSection title="First Applicant" applicant={selected.booking.firstApplicant} />
                <ApplicantSection title="Second Applicant" applicant={selected.booking.secondApplicant} />

                <Section title={`Receipt · ${currency(selected.amount)}`}>
                  <Detail label="Received from" value={selected.receivedFrom} />
                  <Detail label="Receipt date" value={dateText(selected.receiptDate)} />
                  <Detail label="Received date" value={dateText(selected.receivedDate)} />
                  <Detail label="Payment mode" value={selected.paymentMode} />
                  <Detail label="Transaction ID" value={selected.transactionId} />
                  <Detail label="Receipt amount" value={currency(selected.amount)} />
                  <Detail label="Approval status" value={statusLabel(selected.approvalStatus)} />
                </Section>

                <Section title="Approval history">
                  <Detail label="Submitted" value={`${dateText(selected.approvalSubmittedAt)} · ${selected.createdBy.firstName} ${selected.createdBy.lastName}`} />
                  <Detail label="Status" value={statusLabel(selected.approvalStatus)} />
                  <Detail label="Reviewed" value={selected.approvalReviewedAt ? `${dateText(selected.approvalReviewedAt)}${selected.reviewedBy ? ` · ${selected.reviewedBy.firstName} ${selected.reviewedBy.lastName}` : ""}` : "Not reviewed"} />
                  <Detail label="MIS note" value={selected.approvalNote || "—"} wide />
                </Section>

                {selected.approvalStatus === "PENDING_APPROVAL" && (
                  <div className="flex flex-col gap-3 rounded-xl border border-sky-100 bg-white p-4 sm:flex-row sm:items-end">
                    <div className="flex-1 space-y-1.5">
                      <label htmlFor={`note-${selected.id}`} className="text-xs font-medium text-slate-700">MIS note (optional)</label>
                      <Textarea
                        id={`note-${selected.id}`}
                        value={notes[selected.id] || ""}
                        maxLength={1000}
                        rows={2}
                        placeholder="Add a note for the CRM team or rejection reason"
                        onChange={(event) => setNotes((current) => ({ ...current, [selected.id]: event.target.value }))}
                      />
                    </div>
                    <div className="flex gap-2 sm:pb-0.5">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={reviewingId !== null}
                        onClick={() => void review(selected, "REJECT")}
                        className="text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                      >
                        {reviewingId === selected.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <X className="mr-2 h-4 w-4" />}Reject
                      </Button>
                      <Button
                        type="button"
                        disabled={reviewingId !== null}
                        onClick={() => void review(selected, "APPROVE")}
                        className="bg-emerald-700 text-white hover:bg-emerald-800"
                      >
                        {reviewingId === selected.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}Accept & Assign to CRM
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

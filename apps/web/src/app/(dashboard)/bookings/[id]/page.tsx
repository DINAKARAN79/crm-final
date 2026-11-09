"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Download, ExternalLink, Eye, Loader2, MoreHorizontal, Receipt, RefreshCw, StickyNote, XCircle } from "lucide-react";
import { BOOKING_STAGE_OPTIONS } from "@dct-crm/shared";
import { bookingApi, getSessionToken } from "@/lib/api";
import { useRecordView } from "@/components/crm/list-view-control";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { BookingDetailsBody, type BookingRecord } from "@/components/crm/lead-bookings";
import { PdfDocumentPreview, type PdfPreviewDocument } from "@/components/crm/pdf-document-preview";
import { LeadReceipts } from "@/components/crm/lead-receipts";
import { LeadInstallments } from "@/components/crm/lead-installments";
import LeadActivityHistoryCard from "@/components/crm/lead-activity-history-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { getTenantTimezone } from "@/lib/date-format";

interface BookingAuditEntry {
  id: string;
  action: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  createdAt: string;
  user?: { firstName: string; lastName: string } | null;
  impersonatedByName?: string | null;
}

interface BookingNoteEntry {
  id: string;
  description?: string | null;
  createdAt: string;
  user?: { firstName: string; lastName: string } | null;
}

function displayStatus(value: unknown): string {
  return typeof value === "string" && value
    ? value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "—";
}

function BookingStagePath({ stage }: { stage: string }) {
  const cancelled = stage === "CANCELLED";
  const currentIndex = BOOKING_STAGE_OPTIONS.findIndex((option) => option.value === stage);

  return (
    <div className="overflow-x-auto pb-1">
      <ol aria-label="Booking stage" className="grid min-w-[960px] grid-cols-6">
        {BOOKING_STAGE_OPTIONS.map((option, index) => {
          const current = option.value === stage;
          const completed = !cancelled && currentIndex >= 0 && index < currentIndex;
          const classes = current
            ? cancelled
              ? "bg-red-600 text-white"
              : "bg-blue-600 text-white"
            : completed
              ? "bg-blue-100 text-blue-800"
              : "bg-sky-100 text-[#1479a8]";

          return (
            <li
              key={option.value}
              aria-current={current ? "step" : undefined}
              className={`flex h-8 items-center justify-center whitespace-nowrap px-5 text-center text-[11px] font-semibold ${classes}`}
              style={{
                clipPath: index === 0
                  ? "polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%)"
                  : "polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%, 12px 50%)",
                marginLeft: index === 0 ? 0 : -8,
                zIndex: BOOKING_STAGE_OPTIONS.length - index,
              }}
            >
              {option.label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function formatBookingDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: getTenantTimezone(),
  }).format(date);
}

function BookingStatusHistory({ booking }: { booking: BookingRecord }) {
  const [history, setHistory] = React.useState<BookingAuditEntry[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    bookingApi.getAuditHistory(booking.id, { page: 1, limit: 100 })
      .then((response) => {
        if (active) setHistory((response.data.data || []) as BookingAuditEntry[]);
      })
      .catch(() => {
        if (active) setHistory([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [booking.id, booking.updatedAt]);

  const changes = history.flatMap((entry) => {
    const oldValues = entry.oldValues || {};
    const newValues = entry.newValues || {};
    const remarks = ["remarks", "remark", "notes", "reason", "cancellationReason", "reviewNote"]
      .map((key) => newValues[key])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return ["bookingStage", "status"].flatMap((field) => {
      if (
        !Object.prototype.hasOwnProperty.call(oldValues, field)
        || !Object.prototype.hasOwnProperty.call(newValues, field)
        || oldValues[field] === newValues[field]
      ) return [];
      return [{
        id: `${entry.id}-${field}`,
        label: field === "bookingStage" ? "Booking stage" : "Booking status",
        from: oldValues[field],
        to: newValues[field],
        date: entry.createdAt,
        actor: entry.user ? [entry.user.firstName, entry.user.lastName].filter(Boolean).join(" ") : "System",
        impersonatedByName: entry.impersonatedByName,
        remarks,
      }];
    });
  });

  const stageLabel = BOOKING_STAGE_OPTIONS.find((option) => option.value === booking.bookingStage)?.label || displayStatus(booking.bookingStage);

  return (
    <div className="space-y-2 border-t border-sky-100 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#1479a8]">Booking status</p>
        <p className="text-sm font-semibold text-[#075d91]">{stageLabel}</p>
      </div>
      {changes.length > 0 && (
        <ol className="space-y-2" aria-label="Booking status history">
          {changes.slice(0, 5).map((change) => (
            <li key={change.id} className="rounded-md border border-sky-100 bg-white px-3 py-2 text-xs">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[#1479a8]">{change.label}</p>
              <p className="font-medium text-slate-800">
                {displayStatus(change.from)} <span aria-hidden="true">→</span> {displayStatus(change.to)}
              </p>
              <p className="mt-1 text-muted-foreground">
                {change.actor}{change.impersonatedByName ? ` (via ${change.impersonatedByName})` : ""} · {formatBookingDate(change.date)}
              </p>
              {change.remarks && <p className="mt-1 text-slate-600">Remarks: {change.remarks}</p>}
            </li>
          ))}
        </ol>
      )}
      {!loading && changes.length === 0 && <p className="text-xs text-muted-foreground">No status changes recorded yet.</p>}
      {loading && <p className="text-xs text-muted-foreground">Loading status history…</p>}
    </div>
  );
}

function BookingNotesCard({ bookingId }: { bookingId: string }) {
  const { toast } = useToast();
  const [notes, setNotes] = React.useState<BookingNoteEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await bookingApi.getActivityHistory(bookingId, { page: 1, limit: 100 });
      const activities = (response.data.data || []) as Array<BookingNoteEntry & { type?: string }>;
      setNotes(activities.filter((activity) => activity.type === "NOTE"));
    } catch {
      toast({ title: "Booking notes could not be loaded", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [bookingId, toast]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const note = draft.trim();
    if (!note || saving) return;
    setSaving(true);
    try {
      const token = getSessionToken();
      const response = await fetch(`/api/proxy/api/bookings/${encodeURIComponent(bookingId)}/notes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ note }),
      });
      const result = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !result.success) throw new Error(result.error || "Unable to save note");
      setDialogOpen(false);
      setDraft("");
      toast({ title: "Booking note added" });
      await refresh();
    } catch (error) {
      toast({
        title: "Unable to save booking note",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card className="rounded-xl border-sky-100 bg-[#f5fbff] shadow-sm">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[#075d91]"><StickyNote className="mr-1.5 inline h-4 w-4" />Booking Notes</h2>
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>Add Note</Button>
          </div>
          {loading && notes.length === 0 ? (
            <p className="text-xs text-muted-foreground">Loading notes…</p>
          ) : notes.length === 0 ? (
            <p className="text-xs text-muted-foreground">No booking notes recorded.</p>
          ) : (
            <ul className="max-h-72 space-y-2 overflow-y-auto">
              {notes.map((note) => (
                <li key={note.id} className="rounded-md border border-sky-100 bg-white p-3">
                  <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{note.description}</p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {[note.user?.firstName, note.user?.lastName].filter(Boolean).join(" ") || "Unknown"} · {formatBookingDate(note.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <form onSubmit={(event) => void save(event)}>
            <DialogHeader>
              <DialogTitle>Add booking note</DialogTitle>
              <DialogDescription>This note is saved to this booking’s activity history.</DialogDescription>
            </DialogHeader>
            <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Enter a booking note" rows={5} maxLength={5000} />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving || !draft.trim()}>
                {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save Note
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function BookingRecordPage() {
  const { id } = useParams<{ id: string }>();
  useRecordView("BOOKING", id);
  const router = useRouter();
  const { toast } = useToast();
  const { isLoading: authLoading, isAdmin, isSuperAdmin, profile } = useAuth();
  const allowed = isAdmin || isSuperAdmin || /^crm(?:\s|$)/i.test(profile?.name?.trim() || "");
  const [booking, setBooking] = React.useState<BookingRecord | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [tab, setTab] = React.useState("details");
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelNotes, setCancelNotes] = React.useState("");
  const [pdfPreview, setPdfPreview] = React.useState<PdfPreviewDocument | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const response = await bookingApi.get(id);
      setBooking(response.data.data as BookingRecord);
    } catch {
      toast({ title: "Booking could not be loaded", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  React.useEffect(() => {
    if (authLoading) return;
    if (!allowed) {
      router.replace("/home");
      return;
    }
    void load();
  }, [authLoading, allowed, load, router]);

  const stage = booking?.bookingStage || "NEW_BOOKING";
  const cancelled = stage === "CANCELLED";

  const changeStage = async (next: string) => {
    if (!booking || next === stage || cancelled) return;
    if (next === "CANCELLED") return;
    setSaving(true);
    try {
      await bookingApi.updateStage(booking.id, next);
      await load();
      toast({ title: "Booking status updated" });
    } catch {
      toast({ title: "Could not update status", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const cancellationPending = booking?.cancellationStatus === "PENDING";

  const submitCancellation = async () => {
    if (!booking || cancelNotes.trim().length < 3) return;
    setSaving(true);
    try {
      await bookingApi.requestCancellation(booking.id, cancelNotes.trim());
      setCancelOpen(false);
      setCancelNotes("");
      await load();
      toast({ title: "Cancellation sent to MIS team" });
    } catch (cause) {
      const message = (cause as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast({ title: message || "Could not send cancellation request", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const closePdfPreview = () => {
    setPdfPreview((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
  };

  const previewPdf = async () => {
    if (!booking?.lead) return;
    try {
      setPreviewing(true);
      const response = await bookingApi.downloadPdf(booking.lead.id, booking.id);
      const blob = response.data instanceof Blob
        ? response.data
        : new Blob([response.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      setPdfPreview((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return {
          number: booking.bookingNumber,
          url,
          eyebrow: "Booking preview",
          description: "Download and print use the saved booking PDF.",
        };
      });
    } catch {
      toast({ title: "Could not preview PDF", variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  };

  const downloadPdf = async () => {
    if (!booking?.lead) return;
    try {
      const response = await bookingApi.downloadPdf(booking.lead.id, booking.id);
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${booking.bookingNumber}.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast({ title: "Could not download PDF", variant: "destructive" });
    }
  };

  if (loading) {
    return <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  if (!booking) {
    return <div className="p-6 text-sm text-muted-foreground">Booking not found.</div>;
  }

  return (
    <div className="crm-sky mx-auto w-full max-w-none space-y-3 p-3 sm:p-4 [&_button.border]:border-sky-200 [&_button.border]:text-[#075d91] [&_button.border:hover]:bg-sky-50 [&_[data-radix-collection-item]]:cursor-pointer">
      <Button asChild variant="ghost" size="sm" className="text-[#075d91] hover:bg-sky-50">
        <Link href="/bookings"><ArrowLeft className="mr-1.5 h-4 w-4" />Booking Details</Link>
      </Button>

      <Card className="rounded-xl border-sky-100 bg-[#f5fbff] shadow-sm">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[#1479a8]">Booking</p>
              <h1 className="text-xl font-bold text-[#075d91]">{booking.bookingNumber}</h1>
              {(isAdmin || isSuperAdmin) && booking.status === "BOOKED" && (
                <span className="mt-1 inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                  Marked as Booked
                </span>
              )}
              <p className="text-sm text-muted-foreground">{booking.project.name} · {booking.unit.number}</p>
              <p className="text-sm text-muted-foreground">
                CRM Owner: <span className="font-medium text-foreground">
                  {[booking.lead?.bookedBy?.firstName, booking.lead?.bookedBy?.lastName].filter(Boolean).join(" ")
                    || [booking.owner?.firstName, booking.owner?.lastName].filter(Boolean).join(" ")
                    || [booking.lead?.owner?.firstName, booking.lead?.owner?.lastName].filter(Boolean).join(" ")
                    || "—"}
                </span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" disabled={saving || cancelled}>
                    {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}Update Status
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {BOOKING_STAGE_OPTIONS.filter((option) => option.value !== stage && option.value !== "CANCELLED").map((option) => (
                    <DropdownMenuItem key={option.value} onSelect={() => void changeStage(option.value)}>
                      {option.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {!cancelled && (
                <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" disabled={cancellationPending} onClick={() => setCancelOpen(true)}>
                  <XCircle className="mr-1.5 h-4 w-4" />{cancellationPending ? "Cancellation Pending" : "Cancellation"}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setTab("receipts")}>
                <Receipt className="mr-1.5 h-4 w-4" />Create Receipt
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <MoreHorizontal className="mr-1.5 h-4 w-4" />More options
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {booking.lead && (isAdmin || isSuperAdmin) && (
                    <DropdownMenuItem asChild>
                      <Link href={`/leads/${booking.lead.id}`}><ExternalLink className="mr-2 h-4 w-4" />Lead</Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem disabled={previewing} onSelect={() => void previewPdf()}>
                    {previewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                    Preview PDF
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void downloadPdf()}>
                    <Download className="mr-2 h-4 w-4" />Download PDF
                  </DropdownMenuItem>
                  {(booking.status === "BOOKED" || booking.status === "CONFIRMED") && (
                    <DropdownMenuItem onSelect={() => setTab("receipts")}>
                      <RefreshCw className="mr-2 h-4 w-4" />Refund
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <BookingStagePath stage={stage} />

          {cancellationPending && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Cancellation sent to MIS team for verification. Reason: {booking.cancellationReason}
            </p>
          )}
          {booking.cancellationStatus === "REJECTED" && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              MIS rejected the last cancellation request{booking.cancellationReviewNote ? `: ${booking.cancellationReviewNote}` : "."}
            </p>
          )}
          <BookingStatusHistory booking={booking} />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Tabs value={tab} onValueChange={setTab} className="min-w-0 space-y-4">
          <TabsList className="border border-sky-100 bg-sky-50 text-[#1479a8] [&>button[data-state=active]]:bg-white [&>button[data-state=active]]:text-[#075d91]">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="payments">Payment &amp; Installment</TabsTrigger>
            <TabsTrigger value="receipts">Receipt</TabsTrigger>
          </TabsList>
          <TabsContent value="details">
            <Card className="rounded-xl border-sky-100 bg-[#f5fbff] shadow-sm">
              <CardContent className="p-5">
                <BookingDetailsBody booking={booking} onSaved={() => void load()} />
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="payments">
            {booking.lead && <LeadInstallments leadId={booking.lead.id} bookingId={booking.id} />}
          </TabsContent>
          <TabsContent value="receipts">
            {booking.lead && <LeadReceipts leadId={booking.lead.id} bookingId={booking.id} />}
          </TabsContent>
        </Tabs>
        <aside className="min-w-0 space-y-4">
          <BookingNotesCard bookingId={booking.id} />
          <LeadActivityHistoryCard
            bookingId={booking.id}
            leadName={booking.bookingNumber}
            refreshKey={booking.id}
            canViewAuditHistory
          />
        </aside>
      </div>
      <PdfDocumentPreview preview={pdfPreview} onClose={closePdfPreview} />
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request booking cancellation</DialogTitle>
            <DialogDescription>The request goes to the MIS team. The booking is cancelled and the plot released only after MIS verifies it.</DialogDescription>
          </DialogHeader>
          <Textarea value={cancelNotes} onChange={(event) => setCancelNotes(event.target.value)} placeholder="Cancellation notes (required)" rows={4} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>Close</Button>
            <Button className="bg-red-700 text-white hover:bg-red-800" disabled={saving || cancelNotes.trim().length < 3} onClick={() => void submitCancellation()}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Send to MIS
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

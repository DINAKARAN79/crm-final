"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { CalendarClock, CheckCircle2, Clock, History, Pencil, RotateCcw, Save, User, X } from "lucide-react";
import { followUpApi, impersonationMeta } from "@/lib/api";
import { clickToCallToast } from "@/lib/click-to-call";
import { requestLeadCall, useTelephonyActive, useTelephonyReasonCode } from "@/lib/telephony-client";
import { useRecordView } from "@/components/crm/list-view-control";
import { useAuth } from "@/contexts/auth-context";
import { formatDateTime } from "@/lib/date-format";
import { useToast } from "@/hooks/use-toast";
import { RecordPageHeader } from "@/components/crm/record-page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { TelephonyStatusHint } from "@/components/crm/telephony-status-hint";
import { isValidTelephonyNumber } from "@/lib/telephony-navigation";

interface FollowUpHistoryEntry {
  id: string;
  action: string;
  createdAt: string;
  user?: { firstName: string; lastName: string; email: string } | null;
}

interface FollowUpDetail {
  id: string;
  followUpNumber: string;
  title: string;
  description?: string | null;
  dueDate: string;
  isCompleted: boolean;
  isMissed: boolean;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  owner?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    profile?: { name: string } | null;
  } | null;
  lead?: {
    id: string;
    leadNumber?: string | null;
    firstName?: string | null;
    lastName: string;
    company?: string | null;
    phone?: string | null;
    mobile?: string | null;
    secondaryPhone?: string | null;
    email?: string | null;
    status: string;
    source: string;
    createdAt: string;
  } | null;
  history: FollowUpHistoryEntry[];
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid min-w-0 min-h-10 gap-1 border-b py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:items-start">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{value || "—"}</dd>
    </div>
  );
}

function toLocalDateTimeInputs(value: string) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return {
    date: local.toISOString().slice(0, 10),
    time: local.toISOString().slice(11, 16),
  };
}

function historyLabel(action: string) {
  return action.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function FollowUpDetailPage() {
  const params = useParams<{ id: string }>();
  useRecordView("FOLLOW_UP", params.id);
  const searchParams = useSearchParams();
  const sourceLeadId = searchParams.get("leadId");
  const { toast } = useToast();
  const { user, tenant, getLeadStatusLabel, hasEffectivePermission, isAdmin, isSuperAdmin } = useAuth();
  const telephonyActive = useTelephonyActive();
  const telephonyReasonCode = useTelephonyReasonCode();
  const [followUp, setFollowUp] = React.useState<FollowUpDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState("");
  const [editDescription, setEditDescription] = React.useState("");
  const [editDate, setEditDate] = React.useState("");
  const [editTime, setEditTime] = React.useState("");
  const [callingPhoneField, setCallingPhoneField] = React.useState<string | null>(null);
  const earliestFollowUp = new Date();
  earliestFollowUp.setSeconds(0, 0);
  earliestFollowUp.setMinutes(earliestFollowUp.getMinutes() + 1);
  const followUpMinDate = `${earliestFollowUp.getFullYear()}-${String(earliestFollowUp.getMonth() + 1).padStart(2, "0")}-${String(earliestFollowUp.getDate()).padStart(2, "0")}`;
  const followUpNowTime = `${String(earliestFollowUp.getHours()).padStart(2, "0")}:${String(earliestFollowUp.getMinutes()).padStart(2, "0")}`;
  const editScheduledAt = editDate && editTime ? new Date(`${editDate}T${editTime}`) : null;
  const editScheduleError = editing && editScheduledAt && (Number.isNaN(editScheduledAt.getTime()) || editScheduledAt.getTime() <= Date.now())
    ? "Choose a future date and time."
    : "";

  const loadFollowUp = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await followUpApi.get(params.id);
      if (!response.data.success || !response.data.data) {
        throw new Error(response.data.error || "Follow-up could not be loaded.");
      }
      setFollowUp(response.data.data);
    } catch (error: any) {
      toast({
        title: "Unable to load follow-up",
        description: error?.response?.data?.error || error?.message || "Please try again.",
        variant: "destructive",
      });
      setFollowUp(null);
    } finally {
      setLoading(false);
    }
  }, [params.id, toast]);

  React.useEffect(() => {
    void loadFollowUp();
  }, [loadFollowUp]);

  const startEditing = () => {
    if (!followUp) return;
    const dateTime = toLocalDateTimeInputs(followUp.dueDate);
    setEditTitle(followUp.title);
    setEditDescription(followUp.description || "");
    setEditDate(dateTime.date);
    setEditTime(dateTime.time);
    setEditing(true);
  };

  const saveChanges = async () => {
    if (!followUp || saving) return;
    if (!editTitle.trim() || !editDescription.trim() || !editDate || !editTime) {
      toast({
        title: "Complete all fields",
        description: "Subject, comments, scheduled date, and time are required.",
        variant: "destructive",
      });
      return;
    }
    const due = new Date(`${editDate}T${editTime}`);
    if (Number.isNaN(due.getTime()) || due.getTime() <= Date.now()) {
      toast({
        title: "Choose a future time",
        description: "Follow-up can only be scheduled for a future date and time.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const dueDate = due.toISOString();
      const response = await followUpApi.update(followUp.id, {
        title: editTitle.trim(),
        description: editDescription.trim(),
        dueDate,
      });
      if (!response.data.success) {
        throw new Error(response.data.error || "Follow-up could not be saved.");
      }
      setEditing(false);
      toast({ title: "Follow-up saved", description: "Your changes have been saved." });
      await loadFollowUp();
    } catch (error: any) {
      toast({
        title: "Unable to save follow-up",
        description: error?.response?.data?.error || error?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const updateCompletion = async () => {
    if (!followUp || saving) return;
    setSaving(true);
    try {
      const response = followUp.isCompleted
        ? await followUpApi.reopen(followUp.id)
        : await followUpApi.complete(followUp.id);
      if (!response.data.success) {
        throw new Error(response.data.error || "Follow-up status could not be updated.");
      }
      toast({
        title: "Follow-up updated",
        description: followUp.isCompleted ? "Follow-up reopened." : "Follow-up marked complete.",
      });
      await loadFollowUp();
    } catch (error: any) {
      toast({
        title: "Unable to update follow-up",
        description: error?.response?.data?.error || error?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const placeFollowUpCall = async (phoneField: "phone" | "mobile" | "secondaryPhone") => {
    const lead = followUp?.lead;
    if (!lead || callingPhoneField) return;
    setCallingPhoneField(phoneField);
    const result = await requestLeadCall({
      leadId: lead.id,
      phoneField,
      leadName: `${lead.firstName || ""} ${lead.lastName || ""}`.trim() || lead.company || lead.leadNumber || "Lead",
      taskId: followUp.id,
    });
    const notice = clickToCallToast(result, Boolean(isAdmin || isSuperAdmin));
    toast({ title: notice.title, description: notice.description, variant: notice.variant });
    setCallingPhoneField(null);
  };

  const phoneValue = (phone: string | null | undefined, field: "phone" | "mobile" | "secondaryPhone") => {
    if (!phone) return "—";
    const impersonating = Boolean(user?.impersonatedBy || impersonationMeta());
    const hasTelephonyPermission = hasEffectivePermission("TELEPHONY_CALL");
    const validPhone = isValidTelephonyNumber(phone);
    if (!hasTelephonyPermission || !telephonyActive || impersonating || !validPhone) {
      const reasonCode = impersonating
        ? "IMPERSONATING"
        : telephonyReasonCode === "PERMISSION_UNAVAILABLE"
          ? telephonyReasonCode
          : !hasTelephonyPermission
            ? "NO_PERMISSION"
            : !telephonyActive
              ? telephonyReasonCode
              : "INVALID_PHONE";
      return <span className="inline-flex items-center gap-1">{phone}<TelephonyStatusHint reasonCode={reasonCode} isAdmin={isAdmin || isSuperAdmin} leadId={followUp?.lead?.id} tenantId={isSuperAdmin ? tenant?.id : undefined} /></span>;
    }
    return (
      <button
        type="button"
        className="text-left text-primary hover:underline disabled:opacity-60"
        disabled={Boolean(callingPhoneField)}
        onClick={() => void placeFollowUpCall(field)}
      >
        {callingPhoneField === field ? "Calling..." : phone}
      </button>
    );
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!followUp) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Follow-up not found or you do not have access.
        </CardContent>
      </Card>
    );
  }

  const leadName = followUp.lead
    ? `${followUp.lead.firstName || ""} ${followUp.lead.lastName}`.trim()
    : "—";
  const status = followUp.isCompleted ? "Completed" : followUp.isMissed ? "Missed" : "Scheduled";

  return (
    <div className="space-y-6">
      <RecordPageHeader
        objectLabel="Follow-up"
        title={followUp.title}
        subtitle={`Follow-up ${followUp.followUpNumber}`}
        backHref={sourceLeadId ? `/leads/${encodeURIComponent(sourceLeadId)}` : "/follow-ups"}
        icon={<CalendarClock className="h-5 w-5" aria-hidden="true" />}
        badges={
          <Badge className={followUp.isCompleted ? "bg-green-100 text-green-800" : followUp.isMissed ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}>
            {status}
          </Badge>
        }
        actions={
          <Button variant={followUp.isCompleted ? "outline" : "default"} onClick={updateCompletion} disabled={saving}>
            {followUp.isCompleted
              ? <><RotateCcw className="mr-2 h-4 w-4" />Reopen</>
              : <><CheckCircle2 className="mr-2 h-4 w-4" />Mark Complete</>}
          </Button>
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between border-b bg-muted/30 py-3">
              <CardTitle className="text-sm font-semibold">Follow-up Information</CardTitle>
              {editing ? (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                    <X className="mr-1 h-4 w-4" />Cancel
                  </Button>
                  <Button size="sm" onClick={() => void saveChanges()} disabled={saving || Boolean(editScheduleError)}>
                    <Save className="mr-1 h-4 w-4" />{saving ? "Saving..." : "Save"}
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={startEditing} aria-label="Edit follow-up information">
                  <Pencil className="mr-1 h-4 w-4" />Edit
                </Button>
              )}
            </CardHeader>
            <CardContent className="grid min-w-0 gap-x-8 pt-2 md:grid-cols-2">
              <dl className="min-w-0">
                <DetailRow label="Follow-up ID" value={followUp.followUpNumber} />
                <div className="grid min-w-0 min-h-10 gap-1 border-b py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:items-start">
                  <dt className="text-xs font-medium text-muted-foreground">Subject</dt>
                  <dd className="min-w-0 [overflow-wrap:anywhere]">{editing ? <Input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} aria-label="Subject" /> : <span className="text-sm font-medium [overflow-wrap:anywhere]">{followUp.title}</span>}</dd>
                </div>
                <div className="grid min-h-10 gap-1 border-b py-2 sm:grid-cols-[minmax(140px,2fr)_minmax(0,3fr)] sm:items-start">
                  <dt className="text-xs font-medium text-muted-foreground">Scheduled Date</dt>
                  <dd>
                    {editing ? (
                      <div className="flex flex-wrap gap-2">
                        <Input
                          className="min-w-32 flex-1 border-sky-200 bg-white"
                          type="date"
                          min={followUpMinDate}
                          value={editDate}
                          aria-invalid={Boolean(editScheduleError)}
                          onChange={(event) => {
                            const nextDate = event.target.value;
                            setEditDate(nextDate);
                            if (nextDate === followUpMinDate && editTime && editTime < followUpNowTime) setEditTime("");
                          }}
                          aria-label="Scheduled date"
                        />
                        <Input
                          className="w-28 border-sky-200 bg-white"
                          type="time"
                          min={editDate === followUpMinDate ? followUpNowTime : undefined}
                          value={editTime}
                          aria-invalid={Boolean(editScheduleError)}
                          onChange={(event) => setEditTime(event.target.value)}
                          aria-label="Scheduled time"
                        />
                        {editScheduleError && <p className="w-full text-xs text-destructive">{editScheduleError}</p>}
                      </div>
                    ) : <span className="text-sm font-medium">{formatDateTime(followUp.dueDate)}</span>}
                  </dd>
                </div>
                <DetailRow label="Status" value={status} />
                <DetailRow label="Is Missed Follow-up" value={followUp.isMissed ? "Yes" : "No"} />
                <DetailRow label="Completed Date" value={followUp.completedAt ? formatDateTime(followUp.completedAt) : "—"} />
              </dl>
              <dl className="min-w-0">
                <DetailRow label="Owner Profile Name" value={followUp.owner?.profile?.name || "—"} />
                <DetailRow label="Owner" value={followUp.owner ? `${followUp.owner.firstName} ${followUp.owner.lastName}` : "—"} />
                <DetailRow
                  label="Lead"
                  value={followUp.lead ? <Link className="text-primary hover:underline" href={`/leads/${followUp.lead.id}`}>{leadName}</Link> : "—"}
                />
                <div className="grid min-w-0 min-h-10 gap-1 border-b py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:items-start">
                  <dt className="text-xs font-medium text-muted-foreground">Comments</dt>
                  <dd className="min-w-0 [overflow-wrap:anywhere]">{editing ? <Textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} aria-label="Comments" /> : <span className="whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">{followUp.description || "—"}</span>}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b bg-muted/30 py-3">
              <CardTitle className="text-sm font-semibold">Lead Information</CardTitle>
            </CardHeader>
            <CardContent className="grid min-w-0 gap-x-8 pt-2 md:grid-cols-2">
              {followUp.lead ? (
                <>
                  <dl>
                    <DetailRow label="Lead Name" value={<Link className="text-primary hover:underline" href={`/leads/${followUp.lead.id}`}>{leadName}</Link>} />
                    <DetailRow label="Lead ID" value={followUp.lead.leadNumber || followUp.lead.id} />
                    <DetailRow label="Status" value={getLeadStatusLabel(followUp.lead.status)} />
                  </dl>
                  <dl>
                    <DetailRow label="Phone" value={phoneValue(followUp.lead.phone, "phone")} />
                    <DetailRow label="Mobile" value={phoneValue(followUp.lead.mobile, "mobile")} />
                    <DetailRow label="Secondary Phone" value={phoneValue(followUp.lead.secondaryPhone, "secondaryPhone")} />
                    <DetailRow label="Email" value={followUp.lead.email || "—"} />
                    <DetailRow label="Source" value={followUp.lead.source.replaceAll("_", " ")} />
                  </dl>
                </>
              ) : <p className="py-3 text-sm text-muted-foreground">No Lead is linked to this follow-up.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b bg-muted/30 py-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="h-4 w-4" />System Information
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-x-8 pt-2 md:grid-cols-2">
              <dl>
                <DetailRow label="Created" value={formatDateTime(followUp.createdAt)} />
                <DetailRow label="Last Modified" value={formatDateTime(followUp.updatedAt)} />
              </dl>
              <dl>
                <DetailRow
                  label="Lead Record"
                  value={followUp.lead ? <Link className="text-primary hover:underline" href={`/leads/${followUp.lead.id}`}><User className="mr-1 inline h-3.5 w-3.5" />{leadName}</Link> : "—"}
                />
                <DetailRow label="Owner Email" value={followUp.owner?.email || "—"} />
              </dl>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="border-b bg-muted/30 py-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <History className="h-4 w-4" />Follow-up History
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {followUp.history?.length ? (
              <ol className="space-y-5">
                {followUp.history.map((entry) => (
                  <li key={entry.id} className="relative border-l pl-4">
                    <span className="absolute -left-[5px] top-1 h-2 w-2 rounded-full bg-primary" />
                    <p className="text-sm font-medium">{historyLabel(entry.action)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : "System"}
                    </p>
                    <p className="text-xs text-muted-foreground">{formatDateTime(entry.createdAt)}</p>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-muted-foreground">No history available.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

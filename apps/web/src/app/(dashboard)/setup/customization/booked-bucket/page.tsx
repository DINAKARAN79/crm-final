"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Users } from "lucide-react";
import { bookedBucketSettingsApi } from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";

type BucketUser = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isSuperAdmin: boolean;
  profile: { name: string; isAdmin: boolean } | null;
};

type Preview = {
  isActive: boolean;
  totalBooked: number;
  wouldMove: number;
  byOwner: Array<{ ownerId: string | null; ownerName: string; count: number }>;
  byProject: Array<{ projectId: string | null; projectName: string; count: number }>;
};

function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error !== "object" || error === null) return fallback;
  const value = error as { response?: { data?: { error?: string } } };
  return value.response?.data?.error || fallback;
}

export default function BookedBucketPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { isLoading, isAuthenticated, isAdmin, isSuperAdmin } = useAuth();
  const tenantId = isSuperAdmin ? searchParams.get("tenantId") || "" : "";
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const [fallbackUserId, setFallbackUserId] = React.useState("");
  const [memberIds, setMemberIds] = React.useState<string[]>([]);
  const [moveOpenFollowUps, setMoveOpenFollowUps] = React.useState(false);
  const [returnToPreviousOwnerOnCancel, setReturnToPreviousOwnerOnCancel] = React.useState(false);
  const [users, setUsers] = React.useState<BucketUser[]>([]);
  const [preview, setPreview] = React.useState<Preview | null>(null);

  const load = React.useCallback(async () => {
    try {
      setLoading(true);
      const [settingsResponse, previewResponse] = await Promise.all([
        bookedBucketSettingsApi.get(tenantId || undefined),
        bookedBucketSettingsApi.preview(tenantId || undefined),
      ]);
      const data = settingsResponse.data.data;
      const setting = data?.setting;
      setActive(Boolean(setting?.isActive));
      setFallbackUserId(setting?.fallbackUserId || "");
      setMoveOpenFollowUps(Boolean(setting?.moveOpenFollowUps));
      setReturnToPreviousOwnerOnCancel(Boolean(setting?.returnToPreviousOwnerOnCancel));
      setMemberIds((setting?.members || []).filter((member: { isActive: boolean }) => member.isActive)
        .map((member: { userId: string }) => member.userId));
      setUsers(data?.users || []);
      setPreview(previewResponse.data.data || null);
    } catch (error) {
      toast({
        title: "Unable to load Booked Bucket",
        description: getErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [tenantId, toast]);

  React.useEffect(() => {
    if (!isLoading && (!isAuthenticated || (!isAdmin && !isSuperAdmin))) {
      router.replace(isAuthenticated ? "/home" : "/login?redirect=/setup/customization/booked-bucket");
    }
  }, [isAdmin, isAuthenticated, isLoading, isSuperAdmin, router]);

  React.useEffect(() => {
    if (!isLoading && isAuthenticated && (isAdmin || isSuperAdmin) && (!isSuperAdmin || tenantId)) {
      void load();
    } else if (!isLoading && isSuperAdmin && !tenantId) {
      setLoading(false);
    }
  }, [isAdmin, isAuthenticated, isLoading, isSuperAdmin, load, tenantId]);

  const toggleMember = (userId: string) => {
    setMemberIds((current) => current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId]);
  };

  const save = async () => {
    try {
      setSaving(true);
      await bookedBucketSettingsApi.update({
        isActive: active,
        fallbackUserId: fallbackUserId || null,
        memberIds,
        moveOpenFollowUps,
        returnToPreviousOwnerOnCancel,
      }, tenantId || undefined);
      toast({ title: "Booked Bucket settings saved" });
      await load();
    } catch (error) {
      toast({
        title: "Unable to save Booked Bucket",
        description: getErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || !isAuthenticated || (!isAdmin && !isSuperAdmin)) return null;

  const admins = users.filter((user) => user.profile?.isAdmin && !user.isSuperAdmin);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link href={tenantId ? `/setup?tenantId=${encodeURIComponent(tenantId)}` : "/setup"}
        className="inline-flex items-center gap-2 text-sm text-sky-700 hover:text-sky-900">
        <ArrowLeft className="h-4 w-4" /> Back to Setup
      </Link>
      <header className="rounded-2xl border border-sky-100 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-sky-700">Setup</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Booked Bucket</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Route newly booked leads to a company-level round-robin pool. The lead status stays Booked.
          Existing leads are never moved by this page.
        </p>
      </header>

      {isSuperAdmin && !tenantId ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Select a company before editing its Booked Bucket.
        </div>
      ) : loading ? (
        <div className="rounded-xl border bg-white p-8 text-sm text-slate-500">Loading Booked Bucket settings…</div>
      ) : (
        <>
          <section className="space-y-5 rounded-2xl border border-sky-100 bg-white p-6 shadow-sm">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
                className="h-4 w-4 accent-sky-700"
              />
              <span>
                <span className="block font-semibold text-slate-900">Activate Booked Bucket</span>
                <span className="text-sm text-slate-600">No leads move until this setting is active.</span>
              </span>
            </label>

            <div className="space-y-2">
              <label htmlFor="booked-bucket-fallback" className="text-sm font-semibold text-slate-800">
                Admin fallback
              </label>
              <select
                id="booked-bucket-fallback"
                value={fallbackUserId}
                onChange={(event) => setFallbackUserId(event.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Primary System Administrator (oldest active admin)</option>
                {admins.map((user) => (
                  <option key={user.id} value={user.id}>
                    {[user.firstName, user.lastName].filter(Boolean).join(" ")} · {user.profile?.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500">Used when the bucket has no active owners.</p>
            </div>

            <div>
              <h2 className="flex items-center gap-2 font-semibold text-slate-900">
                <Users className="h-4 w-4" /> Bucket owners
              </h2>
              <p className="mt-1 text-sm text-slate-600">Active users rotate in the order shown.</p>
              <div className="mt-3 max-h-80 divide-y overflow-y-auto rounded-lg border">
                {users.map((user) => {
                  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
                  return (
                    <label key={user.id} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={memberIds.includes(user.id)}
                        onChange={() => toggleMember(user.id)}
                        className="h-4 w-4 accent-sky-700"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{name}</span>
                        <span className="block text-xs text-slate-500">
                          {[user.profile?.name, user.phone || "No phone"].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </label>
                  );
                })}
                {users.length === 0 && <p className="p-4 text-sm text-slate-500">No active users found.</p>}
              </div>
            </div>
            <div className="space-y-3 rounded-lg border border-slate-200 p-4">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={moveOpenFollowUps}
                  onChange={(event) => setMoveOpenFollowUps(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-sky-700"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-900">Move open follow-ups with the lead</span>
                  <span className="text-xs text-slate-500">Default off. When enabled, open follow-ups are reassigned to the bucket owner.</span>
                </span>
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={returnToPreviousOwnerOnCancel}
                  onChange={(event) => setReturnToPreviousOwnerOnCancel(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-sky-700"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-900">Return to previous owner when a booking is cancelled</span>
                  <span className="text-xs text-slate-500">Default off; the lead remains Booked and keeps its current owner unless enabled.</span>
                </span>
              </label>
            </div>
            <Button onClick={save} disabled={saving || (isSuperAdmin && !tenantId)}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </section>

          <section className="space-y-4 rounded-2xl border border-sky-100 bg-white p-6 shadow-sm">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Read-only preview</h2>
              <p className="mt-1 text-sm text-slate-600">
                Back up your data before any future bulk changes. This preview does not move or update leads.
              </p>
            </div>
            {preview && (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg bg-slate-50 p-4">
                    <p className="text-xs text-slate-500">Booked leads</p>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{preview.totalBooked}</p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-4">
                    <p className="text-xs text-slate-500">Would move if active</p>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{preview.wouldMove}</p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-4">
                    <p className="text-xs text-slate-500">Bucket</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{preview.isActive ? "Active" : "Inactive"}</p>
                  </div>
                </div>
                <div className="grid gap-6 md:grid-cols-2">
                  <PreviewTable title="Booked leads by current owner" rows={preview.byOwner} nameKey="ownerName" />
                  <PreviewTable title="Booked leads by project" rows={preview.byProject} nameKey="projectName" />
                </div>
                <p className="text-xs text-slate-500">
                  Cancellation default: {returnToPreviousOwnerOnCancel ? "return to previous owner" : "keep current owner"}.
                  Follow-ups: {moveOpenFollowUps ? "move with the lead" : "stay with their existing owners"}.
                </p>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function PreviewTable({
  title,
  rows,
  nameKey,
}: {
  title: string;
  rows: Array<Record<string, string | number | null>>;
  nameKey: "ownerName" | "projectName";
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-800">{title}</h3>
      <div className="max-h-64 overflow-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <tbody className="divide-y">
            {rows.map((row, index) => (
              <tr key={`${String(row[nameKey])}-${index}`}>
                <td className="px-3 py-2 text-slate-700">{row[nameKey]}</td>
                <td className="px-3 py-2 text-right font-medium text-slate-900">{row.count}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="px-3 py-3 text-slate-500">No Booked leads.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

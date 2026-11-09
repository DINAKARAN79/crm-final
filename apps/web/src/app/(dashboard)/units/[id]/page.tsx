"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useRecordView } from "@/components/crm/list-view-control";
import { Building2, ChevronDown, Loader2, Pencil, Search, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import { leadApi, projectApi, unitApi, userApi } from "@/lib/api";
import { formatDateTime } from "@/lib/date-format";
import { notifyUnitInventoryUpdated } from "@/lib/unit-inventory-events";
import { UNIT_PROPERTY_TYPES } from "@dct-crm/shared";

const STATUSES = ["AVAILABLE", "RESERVED", "BOOKED"] as const;

type NamedPerson = { id: string; firstName?: string | null; lastName?: string | null } | null;
type NamedLead = {
  id: string;
  leadNumber?: string | null;
  firstName?: string | null;
  lastName?: string | null;
} | null;

interface UnitQuotation {
  id: string;
  quotationNumber: string;
  leadId: string;
  status: string;
  totalPrice: number;
  createdAt: string;
}

interface UnitReceipt {
  id: string;
  receiptNumber: string;
  amount: number;
  approvalStatus: string;
  receiptDate: string;
}

interface UnitBooking {
  id: string;
  bookingNumber: string;
  status: string;
  receipts?: UnitReceipt[];
}

interface UnitRecord {
  id: string;
  unitCode: string | null;
  number: string;
  type: string | null;
  block: string | null;
  floor: number | null;
  area: number | null;
  areaField: number | null;
  buildupArea: number | null;
  price: number | null;
  allowedDiscount: string | null;
  minimumBookingAmount: number | null;
  msp: string | null;
  plc: string | null;
  nonPlc: string | null;
  registrationDate: string | null;
  status: string;
  projectId: string;
  projectName: string;
  bookingSource: string;
  unitPrice: number | null;
  villaPrice: number | null;
  quotationCount: number;
  receiptCount: number;
  ownerId: string | null;
  customerLeadId: string | null;
  bookingLeadId: string | null;
  opportunityLeadId: string | null;
  owner: NamedPerson;
  createdBy: NamedPerson;
  updatedBy: NamedPerson;
  customerLead: NamedLead;
  bookingLead: NamedLead;
  opportunityLead: NamedLead;
  project: { id: string; name: string } | null;
  quotations: UnitQuotation[];
  bookings: UnitBooking[];
  createdAt: string;
  updatedAt: string;
}

interface LookupOption {
  id: string;
  label: string;
}

interface UnitForm {
  number: string;
  type: string;
  block: string;
  status: string;
  projectId: string;
  floor: string;
  buildupArea: string;
  area: string;
  areaField: string;
  price: string;
  allowedDiscount: string;
  minimumBookingAmount: string;
  msp: string;
  plc: string;
  nonPlc: string;
  customerLeadId: string;
  bookingLeadId: string;
  opportunityLeadId: string;
  registrationDate: string;
  ownerId: string;
}

const inputClass = "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-[#b42318] focus:ring-2 focus:ring-rose-100";
const actionClass = "h-8 rounded-full border-[#c9a3a0] bg-white px-4 text-[13px] text-[#8f2d2a] hover:bg-rose-50";

function personName(person: NamedPerson) {
  if (!person) return "";
  return [person.firstName, person.lastName].filter(Boolean).join(" ");
}

function leadLabel(lead: NamedLead) {
  if (!lead) return "";
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ");
  return lead.leadNumber ? `${lead.leadNumber} · ${name}` : name;
}

function toDateTimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function money(amount: number | null | undefined) {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatAmount(value: number | null | undefined) {
  if (value == null) return "";
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function splitDateTime(value: string) {
  const [date, time] = value.split("T");
  return { date: date || "", time: (time || "").slice(0, 5) };
}

function formFromUnit(unit: UnitRecord): UnitForm {
  return {
    number: unit.number || "",
    type: unit.type || "",
    block: unit.block || "",
    status: unit.status || "AVAILABLE",
    projectId: unit.projectId || unit.project?.id || "",
    floor: unit.floor == null ? "" : String(unit.floor),
    buildupArea: unit.buildupArea == null ? "" : String(unit.buildupArea),
    area: unit.area == null ? "" : String(unit.area),
    areaField: unit.areaField == null ? "" : String(unit.areaField),
    price: unit.price == null ? "" : String(unit.price),
    allowedDiscount: unit.allowedDiscount || "",
    minimumBookingAmount: unit.minimumBookingAmount == null ? "" : String(unit.minimumBookingAmount),
    msp: unit.msp || "",
    plc: unit.plc || "",
    nonPlc: unit.nonPlc || "",
    customerLeadId: unit.customerLeadId || "",
    bookingLeadId: unit.bookingLeadId || "",
    opportunityLeadId: unit.opportunityLeadId || "",
    registrationDate: toDateTimeLocal(unit.registrationDate),
    ownerId: unit.ownerId || "",
  };
}

function wholeNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function decimalNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function DetailCell({
  label,
  children,
  onEdit,
}: {
  label: string;
  children: React.ReactNode;
  onEdit?: () => void;
}) {
  return (
    <div className="grid min-h-10 grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-3 border-b border-slate-100 py-1.5">
      <div className="text-[13px] text-slate-600">{label}</div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 text-[13px] text-slate-900">{children}</div>
        {onEdit && (
          <button type="button" className="text-slate-400 hover:text-slate-700" aria-label={`Edit ${label}`} onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function CalculatedNote() {
  return <p className="text-xs italic text-slate-400">This field is calculated upon save</p>;
}

function LeadSearch({
  id,
  value,
  leads,
  onChange,
}: {
  id: string;
  value: string;
  leads: LookupOption[];
  onChange: (id: string) => void;
}) {
  const selected = leads.find((lead) => lead.id === value);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const matches = leads.filter((lead) => lead.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8);

  return (
    <div className="relative">
      <div className="flex h-9 items-center rounded-md border border-slate-300 bg-white px-2">
        <input
          id={id}
          className="h-full w-full bg-transparent text-sm outline-none"
          placeholder="Search Opportunities..."
          value={open ? query : selected?.label || ""}
          onFocus={() => {
            setOpen(true);
            setQuery("");
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        />
        <Search className="h-4 w-4 text-slate-400" />
      </div>
      {open && (
        <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-white shadow-md">
          <li>
            <button type="button" className="w-full px-3 py-1.5 text-left text-sm text-slate-500 hover:bg-slate-50" onMouseDown={() => onChange("")}>
              Clear
            </button>
          </li>
          {matches.map((lead) => (
            <li key={lead.id}>
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50"
                onMouseDown={() => {
                  onChange(lead.id);
                  setOpen(false);
                }}
              >
                {lead.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function UnitEditPage() {
  const params = useParams();
  useRecordView("UNIT", typeof params.id === "string" ? params.id : "");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { hasPermission, hasEffectivePermission, hasFullAccess, isSuperAdmin } = useAuth();
  const unitId = params.id as string;
  const returnTo = searchParams.get("from") || "/units";
  const canEdit = hasFullAccess || isSuperAdmin || hasPermission("Unit", "edit") || hasEffectivePermission("UNIT_EDIT");
  const canDelete = hasFullAccess || isSuperAdmin || hasPermission("Unit", "delete") || hasEffectivePermission("UNIT_DELETE");

  const [unit, setUnit] = React.useState<UnitRecord | null>(null);
  const [form, setForm] = React.useState<UnitForm | null>(null);
  const [projects, setProjects] = React.useState<LookupOption[]>([]);
  const [users, setUsers] = React.useState<LookupOption[]>([]);
  const [leads, setLeads] = React.useState<LookupOption[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [fieldError, setFieldError] = React.useState("");
  const [editing, setEditing] = React.useState(false);

  const loadUnit = React.useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const [unitResponse, projectRows, userResponse, leadResponse] = await Promise.all([
        unitApi.get(unitId),
        projectApi.listAll().catch(() => []),
        userApi.list({ limit: 100 }).catch(() => ({ data: { data: [] } })),
        leadApi.list({ limit: 100 }).catch(() => ({ data: { data: [] } })),
      ]);
      if (!unitResponse.data.success || !unitResponse.data.data) {
        setError("This unit could not be loaded.");
        setUnit(null);
        return;
      }
      const record = unitResponse.data.data as UnitRecord;
      setUnit(record);
      setForm(formFromUnit(record));
      const projectOptions = (projectRows as Array<{ id: string; name: string }>).map((project) => ({ id: project.id, label: project.name }));
      if (record.project && !projectOptions.some((project) => project.id === record.project?.id)) {
        projectOptions.unshift({ id: record.project.id, label: record.project.name });
      }
      setProjects(projectOptions);
      const userRows = (userResponse.data.data || []) as Array<{ id: string; firstName?: string; lastName?: string }>;
      setUsers(userRows.map((user) => ({ id: user.id, label: personName(user) || user.id })));
      const leadRows = (leadResponse.data.data || []) as NamedLead[];
      const selected = [record.customerLead, record.bookingLead, record.opportunityLead].filter(Boolean) as NonNullable<NamedLead>[];
      const options = new Map<string, string>();
      [...leadRows, ...selected].forEach((lead) => {
        if (lead?.id) options.set(lead.id, leadLabel(lead) || lead.id);
      });
      setLeads(Array.from(options, ([id, label]) => ({ id, label })));
    } catch (loadError: any) {
      const status = loadError?.response?.status;
      setError(status === 404 ? "This unit does not exist." : "This unit could not be loaded.");
      setUnit(null);
    } finally {
      setIsLoading(false);
    }
  }, [unitId]);

  React.useEffect(() => {
    loadUnit();
  }, [loadUnit]);

  const update = (key: keyof UnitForm, value: string) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setFieldError("");
  };

  const selectedProjectName = projects.find((project) => project.id === form?.projectId)?.label || unit?.projectName || "";
  const typedPrice = form ? decimalNumber(form.price) : null;
  const unitPrice = typedPrice === undefined ? unit?.unitPrice ?? null : typedPrice;
  const villaPrice = (form?.type || "").trim().toLowerCase() === "villa" ? (unitPrice ?? 0) : 0;

  const save = async () => {
    if (!form || !unit) return;
    if (!form.number.trim()) {
      setFieldError("Unit Number is required.");
      return;
    }
    if (!form.projectId) {
      setFieldError("Project is required.");
      return;
    }
    if (form.allowedDiscount.trim().length > 25) {
      setFieldError("Allowed Discount can be at most 25 characters.");
      return;
    }
    const floor = wholeNumber(form.floor);
    const buildupArea = wholeNumber(form.buildupArea);
    const minimumBookingAmount = wholeNumber(form.minimumBookingAmount);
    const area = decimalNumber(form.area);
    const areaField = decimalNumber(form.areaField);
    const price = decimalNumber(form.price);
    if (floor === undefined || buildupArea === undefined || minimumBookingAmount === undefined) {
      setFieldError("Floor, Buildup Area, and Minimum Booking Amount must be whole numbers.");
      return;
    }
    if (area === undefined || areaField === undefined || price === undefined) {
      setFieldError("Area, Saleable Area, and Base Price must be zero or greater.");
      return;
    }
    if (form.msp.trim().length > 255 || form.plc.trim().length > 255 || form.nonPlc.trim().length > 255) {
      setFieldError("MSP, PLC, and Non PLC can be at most 255 characters.");
      return;
    }

    setIsSaving(true);
    setFieldError("");
    try {
      const response = await unitApi.update(unit.id, {
        number: form.number.trim(),
        type: form.type,
        block: form.block.trim(),
        ...(STATUSES.includes(form.status as (typeof STATUSES)[number]) ? { status: form.status } : {}),
        projectId: form.projectId,
        floor,
        buildupArea,
        area,
        areaField,
        price,
        allowedDiscount: form.allowedDiscount.trim(),
        minimumBookingAmount,
        msp: form.msp.trim(),
        plc: form.plc.trim(),
        nonPlc: form.nonPlc.trim(),
        customerLeadId: form.customerLeadId || null,
        bookingLeadId: form.bookingLeadId || null,
        opportunityLeadId: form.opportunityLeadId || null,
        registrationDate: form.registrationDate || null,
        ownerId: canEdit ? form.ownerId || null : undefined,
      });
      const saved = response.data.data as UnitRecord;
      setUnit(saved);
      setForm(formFromUnit(saved));
      setEditing(false);
      notifyUnitInventoryUpdated();
      toast({ title: "Unit saved", description: `${saved.unitCode || saved.number} was updated.` });
    } catch (saveError: any) {
      const message = saveError?.response?.data?.error || "This unit could not be updated.";
      setFieldError(message);
      toast({ title: "Save failed", description: message, variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const beginEdit = (fieldId?: string) => {
    if (!canEdit) return;
    setEditing(true);
    if (!fieldId) return;
    window.setTimeout(() => document.getElementById(fieldId)?.focus(), 0);
  };

  const cancelEdit = () => {
    if (unit) setForm(formFromUnit(unit));
    setFieldError("");
    setEditing(false);
  };

  const remove = async () => {
    if (!unit || !window.confirm(`Delete ${unit.unitCode || unit.number}?`)) return;
    try {
      await unitApi.delete(unit.id);
      notifyUnitInventoryUpdated();
      toast({ title: "Unit deleted" });
      router.push(returnTo);
    } catch (deleteError: any) {
      const message = deleteError?.response?.data?.error || "This unit could not be deleted. Quotations or bookings may still use it.";
      toast({ title: "Delete failed", description: message, variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-[32rem] w-full" />
      </div>
    );
  }

  if (!unit || !form) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <p className="font-medium">{error || "This unit does not exist."}</p>
          <Button variant="outline" onClick={() => router.push("/units")}>Back to units</Button>
        </CardContent>
      </Card>
    );
  }

  const typeOptions = Array.from(new Set([...UNIT_PROPERTY_TYPES, form.type].filter(Boolean)));
  const statusOptions = Array.from(new Set([...STATUSES, form.status].filter(Boolean)));
  const hasHistoricalStatus = !STATUSES.includes(form.status as (typeof STATUSES)[number]);
  const receipts = unit.bookings.flatMap((booking) =>
    (booking.receipts || []).map((receipt) => ({ ...receipt, bookingId: booking.id, bookingNumber: booking.bookingNumber })),
  );
  const pencil = canEdit && !editing ? (fieldId: string) => () => beginEdit(fieldId) : null;
  const registration = splitDateTime(form.registrationDate);
  const ownerLabel = users.find((user) => user.id === form.ownerId)?.label || personName(unit.owner);
  const projectLabel = selectedProjectName;
  const firstOpportunity = leads.find((lead) => lead.id === form.opportunityLeadId)?.label || "";

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-rose-100 text-rose-700">
            <UserRound className="h-5 w-5" />
          </span>
          <div>
            <p className="text-xs text-slate-500">Unit</p>
            <h1 className="text-2xl font-semibold text-[#7f1d1d]">{unit.unitCode || unit.number}</h1>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className={actionClass} onClick={() => beginEdit()} disabled={!canEdit}>
            Edit
          </Button>
          {canDelete && (
            <Button variant="outline" className={actionClass} onClick={remove}>Delete</Button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden">
        <Tabs defaultValue="details">
          <div className="border-b px-4">
            <TabsList className="h-11 bg-transparent p-0">
              <TabsTrigger value="related" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-[#7f1d1d] data-[state=active]:shadow-none">
                Related
              </TabsTrigger>
              <TabsTrigger value="details" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-[#7f1d1d] data-[state=active]:shadow-none">
                Details
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="related" className="space-y-4 p-4">
            <section className="rounded-lg border">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-semibold text-[#075d91]">Notes & Attachments (0)</h2>
              </div>
              <p className="px-4 py-6 text-center text-sm text-slate-500">No notes or attachments on this unit.</p>
            </section>

            <section className="rounded-lg border">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-semibold text-[#075d91]">Quotations ({unit.quotationCount})</h2>
              </div>
              {unit.quotations.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-500">No quotations are tagged to this unit.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-sm">
                    <thead className="bg-slate-50 text-left text-slate-500">
                      <tr>
                        <th className="px-4 py-2 font-medium">Quotation Name</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                        <th className="px-4 py-2 font-medium">Total</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {unit.quotations.map((quotation) => (
                        <tr key={quotation.id} className="border-t">
                          <td className="px-4 py-2">
                            <Link href={`/leads/${quotation.leadId}/quotations/${quotation.id}`} className="font-medium text-[#7f1d1d] hover:underline">
                              {quotation.quotationNumber}
                            </Link>
                          </td>
                          <td className="px-4 py-2">{quotation.status}</td>
                          <td className="px-4 py-2">{money(quotation.totalPrice)}</td>
                          <td className="px-4 py-2 text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label={`Actions for ${quotation.quotationNumber}`}>
                                  <ChevronDown className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem asChild>
                                  <Link href={`/leads/${quotation.leadId}/quotations/${quotation.id}`}>Edit</Link>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="rounded-lg border">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-semibold text-[#075d91]">Receipts ({unit.receiptCount})</h2>
              </div>
              {receipts.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-500">No receipts are tagged to this unit.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-sm">
                    <thead className="bg-slate-50 text-left text-slate-500">
                      <tr>
                        <th className="px-4 py-2 font-medium">Receipt</th>
                        <th className="px-4 py-2 font-medium">Booking</th>
                        <th className="px-4 py-2 font-medium">Amount</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receipts.map((receipt) => (
                        <tr key={receipt.id} className="border-t">
                          <td className="px-4 py-2">{receipt.receiptNumber}</td>
                          <td className="px-4 py-2">
                            <Link href={`/bookings/${receipt.bookingId}`} className="text-[#075d91] hover:underline">{receipt.bookingNumber}</Link>
                          </td>
                          <td className="px-4 py-2">{money(receipt.amount)}</td>
                          <td className="px-4 py-2">{receipt.approvalStatus}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </TabsContent>

          <TabsContent value="details" className="p-4 sm:p-6">
            {editing && <p className="mb-3 text-right text-xs text-slate-500"><span className="text-[#b42318]">*</span> = Required Information</p>}
            {fieldError && <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{fieldError}</p>}
            <div className="grid grid-cols-1 gap-x-12 lg:grid-cols-2">
              <div>
                <DetailCell label="Unit Name">{unit.unitCode || ""}</DetailCell>
                <DetailCell label="Unit Type" onEdit={pencil?.("unit-type")}>
                  {editing ? (
                    <select id="unit-type" className={inputClass} value={form.type} onChange={(event) => update("type", event.target.value)}>
                      <option value="">Select</option>
                      {typeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
                    </select>
                  ) : form.type}
                </DetailCell>
                <DetailCell label="Floor" onEdit={pencil?.("unit-floor")}>
                  {editing ? <Input id="unit-floor" className={inputClass} inputMode="numeric" value={form.floor} onChange={(event) => update("floor", event.target.value)} /> : form.floor}
                </DetailCell>
                <DetailCell label="Block" onEdit={pencil?.("unit-block")}>
                  {editing ? <Input id="unit-block" className={inputClass} maxLength={255} value={form.block} onChange={(event) => update("block", event.target.value)} /> : form.block}
                </DetailCell>
                <DetailCell label="Status" onEdit={pencil?.("unit-status")}>
                  {editing ? (
                    <select id="unit-status" className={inputClass} value={form.status} onChange={(event) => update("status", event.target.value)}>
                      {statusOptions.map((status) => <option key={status} value={status} disabled={hasHistoricalStatus && status === form.status}>{status}{hasHistoricalStatus && status === form.status ? " (historical)" : ""}</option>)}
                    </select>
                  ) : form.status}
                </DetailCell>
                <DetailCell label="Allowed Discountt" onEdit={pencil?.("unit-discount")}>
                  {editing ? <Input id="unit-discount" className={inputClass} maxLength={25} value={form.allowedDiscount} onChange={(event) => update("allowedDiscount", event.target.value)} /> : form.allowedDiscount}
                </DetailCell>
                <DetailCell label="Project" onEdit={pencil?.("unit-project")}>
                  {editing ? (
                    form.projectId ? (
                      <div className="flex h-9 items-center rounded-md border border-slate-300 px-2">
                        <span className="inline-flex max-w-full items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-sm text-[#8f2d2a]">
                          <Building2 className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{projectLabel}</span>
                          <button type="button" aria-label="Clear project" onClick={() => update("projectId", "")}><X className="h-3.5 w-3.5" /></button>
                        </span>
                      </div>
                    ) : (
                      <select id="unit-project" className={inputClass} value={form.projectId} onChange={(event) => update("projectId", event.target.value)}>
                        <option value="">Select a project</option>
                        {projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
                      </select>
                    )
                  ) : (
                    form.projectId ? <Link href={`/projects/${form.projectId}`} className="text-[#8f2d2a] hover:underline">{projectLabel}</Link> : ""
                  )}
                </DetailCell>
                <DetailCell label="Owner" onEdit={pencil?.("unit-owner")}>
                  {editing ? (
                    <select id="unit-owner" className={inputClass} value={form.ownerId} onChange={(event) => update("ownerId", event.target.value)}>
                      <option value="">Select</option>
                      {users.map((user) => <option key={user.id} value={user.id}>{user.label}</option>)}
                    </select>
                  ) : ownerLabel ? (
                    <span className="inline-flex items-center gap-2">
                      <UserRound className="h-4 w-4 text-[#8f2d2a]" />
                      <span className="text-[#8f2d2a]">{ownerLabel}</span>
                    </span>
                  ) : ""}
                </DetailCell>
                <DetailCell label="Buildup Area" onEdit={pencil?.("unit-buildup")}>
                  {editing ? <Input id="unit-buildup" className={inputClass} inputMode="numeric" value={form.buildupArea} onChange={(event) => update("buildupArea", event.target.value)} /> : form.buildupArea}
                </DetailCell>
                <DetailCell label="Villa Price">
                  <div>
                    <p>{formatAmount(villaPrice)}</p>
                    {editing && <CalculatedNote />}
                  </div>
                </DetailCell>
                <DetailCell label="Customer" onEdit={pencil?.("unit-customer")}>
                  {editing ? (
                    <LeadSearch id="unit-customer" value={form.customerLeadId} leads={leads} onChange={(id) => update("customerLeadId", id)} />
                  ) : (leads.find((lead) => lead.id === form.customerLeadId)?.label || "")}
                </DetailCell>
                <DetailCell label="Opportunity" onEdit={pencil?.("unit-booking-opportunity")}>
                  {editing ? (
                    <LeadSearch id="unit-booking-opportunity" value={form.bookingLeadId} leads={leads} onChange={(id) => update("bookingLeadId", id)} />
                  ) : (leads.find((lead) => lead.id === form.bookingLeadId)?.label || "")}
                </DetailCell>
                <DetailCell label="Opportunity" onEdit={pencil?.("unit-opportunity")}>
                  {editing ? (
                    <LeadSearch id="unit-opportunity" value={form.opportunityLeadId} leads={leads} onChange={(id) => update("opportunityLeadId", id)} />
                  ) : firstOpportunity}
                </DetailCell>
                <DetailCell label="Booking source">
                  <div>
                    <p>{unit.bookingSource}</p>
                    {editing && <CalculatedNote />}
                  </div>
                </DetailCell>
                <DetailCell label="Registration Date" onEdit={pencil?.("unit-registration-date")}>
                  {editing ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Input id="unit-registration-date" className={inputClass} type="date" value={registration.date} onChange={(event) => update("registrationDate", event.target.value ? `${event.target.value}T${registration.time || "00:00"}` : "")} />
                      <Input className={inputClass} type="time" value={registration.time} onChange={(event) => update("registrationDate", registration.date ? `${registration.date}T${event.target.value || "00:00"}` : "")} />
                    </div>
                  ) : form.registrationDate ? formatDateTime(form.registrationDate) : ""}
                </DetailCell>
              </div>
              <div>
                <DetailCell label="Project Name">
                  <div>
                    <p>{editing ? "" : projectLabel}</p>
                    {editing && <CalculatedNote />}
                  </div>
                </DetailCell>
                <DetailCell label="Unit Number" onEdit={pencil?.("unit-number")}>
                  {editing ? <Input id="unit-number" className={inputClass} maxLength={255} value={form.number} onChange={(event) => update("number", event.target.value)} /> : form.number}
                </DetailCell>
                <DetailCell label="Saleable Area" onEdit={pencil?.("unit-area")}>
                  {editing ? <Input id="unit-area" className={inputClass} inputMode="decimal" value={form.area} onChange={(event) => update("area", event.target.value)} /> : formatAmount(decimalNumber(form.area) ?? null)}
                </DetailCell>
                <DetailCell label="Area" onEdit={pencil?.("unit-area-field")}>
                  {editing ? <Input id="unit-area-field" className={inputClass} inputMode="decimal" value={form.areaField} onChange={(event) => update("areaField", event.target.value)} /> : formatAmount(decimalNumber(form.areaField) ?? null)}
                </DetailCell>
                <DetailCell label="MSP" onEdit={pencil?.("unit-msp")}>
                  {editing ? <Input id="unit-msp" className={inputClass} maxLength={255} value={form.msp} onChange={(event) => update("msp", event.target.value)} /> : form.msp}
                </DetailCell>
                <DetailCell label="PLC" onEdit={pencil?.("unit-plc")}>
                  {editing ? <Input id="unit-plc" className={inputClass} maxLength={255} value={form.plc} onChange={(event) => update("plc", event.target.value)} /> : form.plc}
                </DetailCell>
                <DetailCell label="Non PLC" onEdit={pencil?.("unit-non-plc")}>
                  {editing ? <Input id="unit-non-plc" className={inputClass} maxLength={255} value={form.nonPlc} onChange={(event) => update("nonPlc", event.target.value)} /> : form.nonPlc}
                </DetailCell>
                <DetailCell label="Base Price" onEdit={pencil?.("unit-price")}>
                  {editing ? <CurrencyInput id="unit-price" className={inputClass} step="any" value={form.price} onChange={(event) => update("price", event.target.value)} /> : form.price}
                </DetailCell>
                <DetailCell label="Minimum Booking Amount" onEdit={pencil?.("unit-minimum-booking")}>
                  {editing ? <CurrencyInput id="unit-minimum-booking" className={inputClass} step="1" value={form.minimumBookingAmount} onChange={(event) => update("minimumBookingAmount", event.target.value)} /> : form.minimumBookingAmount}
                </DetailCell>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-x-12 lg:grid-cols-2">
              <DetailCell label="Created By">
                {personName(unit.createdBy) ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <UserRound className="h-4 w-4 text-[#8f2d2a]" />
                    <span className="text-[#8f2d2a]">{personName(unit.createdBy)}</span>
                    <span className="text-slate-600">{formatDateTime(unit.createdAt)}</span>
                  </span>
                ) : formatDateTime(unit.createdAt)}
              </DetailCell>
              <DetailCell label="Last Modified By">
                {personName(unit.updatedBy) ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <UserRound className="h-4 w-4 text-[#8f2d2a]" />
                    <span className="text-[#8f2d2a]">{personName(unit.updatedBy)}</span>
                    <span className="text-slate-600">{formatDateTime(unit.updatedAt)}</span>
                  </span>
                ) : formatDateTime(unit.updatedAt)}
              </DetailCell>
            </div>
            {editing && (
              <div className="mt-6 flex justify-center gap-3">
                <Button variant="outline" className="h-9 rounded-full border-slate-300 px-5" onClick={cancelEdit} disabled={isSaving}>Cancel</Button>
                <Button className="h-9 rounded-full bg-[#b42318] px-5 text-white hover:bg-[#9a1e14]" onClick={save} disabled={!canEdit || isSaving}>
                  {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}

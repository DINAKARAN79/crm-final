"use client";

import * as React from "react";
import Image from "next/image";
import { AlertCircle, Download, Eye, FileText, Loader2, Printer, RefreshCw, UserRound } from "lucide-react";
import { BOOKING_DETAIL_FIELDS, type BookingDetailField } from "@dct-crm/shared";
import { bookingApi } from "@/lib/api";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PdfDocumentPreview, type PdfPreviewDocument } from "@/components/crm/pdf-document-preview";
import { useToast } from "@/hooks/use-toast";

type JsonFields = Record<string, string | number | boolean | null | undefined>;

export interface BookingRecord {
  lead?:  {
    id: string;
    leadNumber: string;
    firstName?: string | null;
    lastName: string;
    owner?: { id: string; firstName?: string | null; lastName?: string | null } | null;
    bookedBy?: { id: string; firstName?: string | null; lastName?: string | null } | null;
  };
  id: string;
  bookingNumber: string;
  status: string;
  bookingStage?: string;
  cancellationStatus?: string | null;
  cancellationReason?: string | null;
  cancellationRequestedAt?: string | null;
  cancellationReviewNote?: string | null;
  bookingAmount: number;
  createdAt: string;
  updatedAt?: string;
  details?: Record<string, string | number | boolean | null>;
  welcomeCallNotes?: string | null;
  plotDetails: JsonFields;
  firstApplicant: JsonFields;
  secondApplicant?: JsonFields | null;
  profession: JsonFields;
  referredBy?: string | null;
  project: { name: string; address?: string | null; city?: string | null };
  unit: { number: string; type?: string | null; area?: number | null; status: string };
  quotation: {
    quotationNumber: string;
    customerName: string;
    projectName: string;
    unitNumber: string;
    area: number;
    basePrice: number;
    plcAmount: number;
    discountAmount: number;
    totalPrice: number;
    paymentPlanName: string;
    paymentPlan: { installments?: { milestone: string; percentage: number; dueMonths?: number; dueDays?: number }[] };
    terms?: string | null;
  };
  createdBy?: { firstName: string; lastName: string } | null;
  owner?: { id?: string; firstName?: string | null; lastName?: string | null } | null;
}

const currency = (amount: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);

const display = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
};

const displayDate = (value: string) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(value));

function additionalApplicants(profession: BookingRecord["profession"]): JsonFields[] {
  const value = (profession as { additionalApplicants?: unknown }).additionalApplicants;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonFields => !!item && typeof item === "object" && !Array.isArray(item));
}

const bookingStatusLabel = (status: string) => ({
  RESERVED: "Reserved",
  BOOKED: "Booked",
  CONFIRMED: "Confirmed",
  CANCELLED: "Cancelled",
}[status] || status);

const personName = (person?: { firstName?: string | null; lastName?: string | null } | null) =>
  [person?.firstName, person?.lastName].filter(Boolean).join(" ") || "—";

const bookingOwnerName = (booking: BookingRecord) =>
  personName(booking.lead?.bookedBy) !== "—"
    ? personName(booking.lead?.bookedBy)
    : personName(booking.owner) !== "—"
      ? personName(booking.owner)
      : personName(booking.lead?.owner);

function DetailField({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-md border border-slate-200 bg-white px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 break-words text-sm font-medium text-slate-800">{display(value)}</p>
    </div>
  );
}

function ApplicantDetails({ title, applicant }: { title: string; applicant: JsonFields }) {
  const fullName = [applicant.salutation, applicant.name].filter(Boolean).join(" ");
  const addressFields = [
    ["Corresponding address", applicant.correspondingAddress],
    ["Permanent address", applicant.permanentAddress],
  ] as const;
  const personalFields = [
    ["Date of birth", applicant.dateOfBirth],
    ["Relation", [applicant.relationType, applicant.relationshipName].filter(Boolean).join(" ")],
    ["Nationality", applicant.nationality],
    ["Aadhaar number", applicant.aadhaarNumber],
    ["PAN number", applicant.panNumber],
    ["Email", applicant.email],
    ["Mobile number", applicant.mobileNumber],
    ["Alternate number", applicant.alternateNumber],
    ["Marital status", applicant.maritalStatus],
    ["State", applicant.state],
    ["District", applicant.district],
  ] as const;

  return (
    <section className="rounded-lg border bg-white p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-50 text-indigo-700">
          <UserRound className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <p className="truncate text-sm text-slate-500">{fullName || "Applicant"}</p>
        </div>
        {typeof applicant.photoUrl === "string" && applicant.photoUrl.startsWith("data:image/") && (
          <Image
            src={applicant.photoUrl}
            alt={`${fullName || title} photo`}
            width={88}
            height={100}
            unoptimized
            className="h-24 w-20 rounded-md border object-cover"
          />
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {personalFields.map(([label, value]) => <DetailField key={label} label={label} value={value} />)}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {addressFields.map(([label, value]) => <DetailField key={label} label={label} value={value} />)}
      </div>
    </section>
  );
}

export function LeadBookings({ leadId }: { leadId: string }) {
  const { toast } = useToast();
  const [bookings, setBookings] = React.useState<BookingRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [pdfAction, setPdfAction] = React.useState<string | null>(null);
  const [pdfPreview, setPdfPreview] = React.useState<PdfPreviewDocument | null>(null);

  const loadBookings = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await bookingApi.listForLead(leadId);
      setBookings((response.data.data || []) as BookingRecord[]);
    } catch (cause) {
      console.error("Failed to load lead bookings:", cause);
      const message = (cause as { response?: { data?: { error?: string } } }).response?.data?.error;
      setError(message || "Bookings could not be loaded. Please retry.");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  React.useEffect(() => {
    void loadBookings();
  }, [loadBookings]);

  const closePdfPreview = () => {
    setPdfPreview((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
  };

  const fetchBookingPdf = async (booking: BookingRecord) => {
    const response = await bookingApi.downloadPdf(leadId, booking.id);
    const blob = response.data instanceof Blob
      ? response.data
      : new Blob([response.data], { type: "application/pdf" });
    return URL.createObjectURL(blob);
  };

  const previewPdf = async (booking: BookingRecord) => {
    try {
      setPdfAction(`${booking.id}:preview`);
      const url = await fetchBookingPdf(booking);
      setPdfPreview((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return {
          number: booking.bookingNumber,
          url,
          eyebrow: "Booking preview",
          description: "Download and print use the saved booking PDF.",
        };
      });
    } catch (cause) {
      console.error("Failed to preview booking PDF:", cause);
      toast({
        title: "Could not preview PDF",
        description: "The booking PDF could not be generated. Please try again.",
        variant: "destructive",
      });
    } finally {
      setPdfAction(null);
    }
  };

  const downloadPdf = async (booking: BookingRecord) => {
    try {
      setPdfAction(`${booking.id}:download`);
      const url = await fetchBookingPdf(booking);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${booking.bookingNumber}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      console.error("Failed to download booking PDF:", cause);
      toast({
        title: "Could not download PDF",
        description: "The booking PDF could not be generated. Please try again.",
        variant: "destructive",
      });
    } finally {
      setPdfAction(null);
    }
  };

  const printPdf = async (booking: BookingRecord) => {
    try {
      setPdfAction(`${booking.id}:print`);
      const url = await fetchBookingPdf(booking);
      const frame = document.createElement("iframe");
      frame.setAttribute("title", `${booking.bookingNumber} print`);
      frame.style.cssText = "position:fixed;width:0;height:0;border:0;";
      frame.src = url;
      document.body.appendChild(frame);
      frame.onload = () => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        window.setTimeout(() => {
          frame.remove();
          URL.revokeObjectURL(url);
        }, 1500);
      };
    } catch (cause) {
      console.error("Failed to print booking PDF:", cause);
      toast({
        title: "Could not print PDF",
        description: "The booking PDF could not be generated. Please try again.",
        variant: "destructive",
      });
    } finally {
      setPdfAction(null);
    }
  };

  return (
    <>
      <Card className="overflow-hidden border-slate-200">
        <CardHeader className="flex flex-row items-center justify-between gap-3 border-b bg-muted/40 px-5 py-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-indigo-700 text-white"><FileText className="h-5 w-5" /></span>
              Booking Details
              <Badge variant="secondary">{bookings.length}</Badge>
            </CardTitle>
            <p className="ml-11 mt-1 text-xs text-muted-foreground">Saved bookings, applicant records, and downloadable PDF documents.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadBookings()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="p-5">
          {loading ? (
            <div role="status" className="flex items-center justify-center gap-2 py-14 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />Loading booking records…
            </div>
          ) : error ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-6 text-center">
              <AlertCircle className="mx-auto mb-2 h-6 w-6 text-rose-600" />
              <p role="alert" className="text-sm text-rose-800">{error}</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void loadBookings()}>Retry</Button>
            </div>
          ) : bookings.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-6 py-14 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-md bg-white text-indigo-600"><FileText className="h-6 w-6" /></span>
              <h3 className="mt-3 font-semibold text-slate-900">No bookings yet</h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">Once a booking is saved from a quotation, its applicant details and PDF download will appear here.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50 hover:bg-slate-50 [&_th]:whitespace-nowrap [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:text-slate-600">
                    <TableHead>Booking Number</TableHead>
                    <TableHead>Booking Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Project / Unit</TableHead>
                    <TableHead>Applicant</TableHead>
                    <TableHead className="text-right">Booking Amount</TableHead>
                    <TableHead className="text-right">Documents</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bookings.map((booking) => (
                    <TableRow key={booking.id}>
                      <TableCell className="whitespace-nowrap">
                        <Link href={`/bookings/${booking.id}`} className="font-mono font-medium text-[#1479a8] hover:text-[#075d91] hover:underline">
                          {booking.bookingNumber}
                        </Link>
                        <p className="mt-0.5 text-xs text-slate-500">Quotation {booking.quotation.quotationNumber}</p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{displayDate(booking.createdAt)}</TableCell>
                      <TableCell><Badge variant="secondary">{bookingStatusLabel(booking.status)}</Badge></TableCell>
                      <TableCell className="whitespace-nowrap">{booking.project.name} · {booking.unit.number}</TableCell>
                      <TableCell className="max-w-48 truncate">{display(booking.firstApplicant.name)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right font-medium">{currency(booking.bookingAmount)}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label={`Preview ${booking.bookingNumber} PDF`} title="Preview PDF" disabled={pdfAction?.startsWith(`${booking.id}:`)} onClick={() => void previewPdf(booking)}>
                            {pdfAction === `${booking.id}:preview` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                          </Button>
                          <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label={`Download ${booking.bookingNumber} PDF`} title="Download PDF" disabled={pdfAction?.startsWith(`${booking.id}:`)} onClick={() => void downloadPdf(booking)}>
                            {pdfAction === `${booking.id}:download` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          </Button>
                          <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label={`Print ${booking.bookingNumber}`} title="Print" disabled={pdfAction?.startsWith(`${booking.id}:`)} onClick={() => void printPdf(booking)}>
                            {pdfAction === `${booking.id}:print` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <PdfDocumentPreview preview={pdfPreview} onClose={closePdfPreview} />
    </>
  );
}

function bookingDetailFallbacks(booking: BookingRecord): Record<string, unknown> {
  const first = booking.firstApplicant;
  const second = booking.secondApplicant || {};
  const leadName = [booking.lead?.firstName, booking.lead?.lastName].filter(Boolean).join(" ");
  const applicantName = [first.salutation, first.name].filter(Boolean).join(" ");
  return {
    bookingNumber: booking.bookingNumber,
    bookingStage: booking.bookingStage,
    status: bookingStatusLabel(booking.status),
    bookingDate: booking.createdAt.slice(0, 10),
    bookingDay: new Intl.DateTimeFormat("en-IN", { weekday: "long" }).format(new Date(booking.createdAt)),
    project: booking.project.name,
    plotSqFt: booking.unit.area,
    unitStatus: booking.unit.status,
    bookingOwner: bookingOwnerName(booking),
    lead: leadName || booking.lead?.leadNumber,
    bookingAmount: booking.bookingAmount,
    clientName: applicantName,
    unit: booking.unit.number,
    quotationNumber: booking.quotation.quotationNumber,
    unitType: booking.unit.type,
    plotLandArea: booking.plotDetails.areaCent ?? booking.unit.area,
    areaCent: booking.plotDetails.areaCent,
    basePrice: booking.quotation.basePrice,
    plcAmount: booking.quotation.plcAmount,
    discountAmount: booking.quotation.discountAmount,
    totalPrice: booking.quotation.totalPrice,
    paymentPlanName: booking.quotation.paymentPlanName,
    projectAddress: [booking.project.address, booking.project.city].filter(Boolean).join(", "),
    totalAmount: booking.quotation.totalPrice,
    unitFacingDirection: booking.plotDetails.facingDirection,
    welcomeCallNotes: booking.welcomeCallNotes,
    firstApplicantSalutation: first.salutation,
    firstApplicantName: first.name,
    firstApplicantRelationType: first.relationType,
    firstApplicantNationality: first.nationality,
    firstApplicantAadhaar: first.aadhaarNumber,
    firstApplicantEmail: first.email,
    firstApplicantMaritalStatus: first.maritalStatus,
    firstApplicantState: first.state,
    firstApplicantCorrespondingAddress: first.correspondingAddress,
    firstApplicantPhoto: first.photoUrl,
    firstApplicantDateOfBirth: first.dateOfBirth,
    firstApplicantRelationshipName: first.relationshipName,
    firstApplicantPan: first.panNumber,
    firstApplicantMobile: first.mobileNumber,
    firstApplicantAlternateNumber: first.alternateNumber,
    firstApplicantDistrict: first.district,
    firstApplicantPermanentAddress: first.permanentAddress,
    secondApplicantSalutation: second.salutation,
    secondApplicantName: second.name,
    secondApplicantRelationType: second.relationType,
    secondApplicantMobile: second.mobileNumber,
    secondApplicantEmail: second.email,
    secondApplicantAadhaar: second.aadhaarNumber,
    secondApplicantMaritalStatus: second.maritalStatus,
    secondApplicantCorrespondingAddress: second.correspondingAddress,
    secondApplicantPhoto: second.photoUrl,
    secondApplicantDateOfBirth: second.dateOfBirth,
    secondApplicantRelationshipName: second.relationshipName,
    secondApplicantAlternateNumber: second.alternateNumber,
    secondApplicantNationality: second.nationality,
    secondApplicantPan: second.panNumber,
    secondApplicantSameAddress: second.sameAddress,
    secondApplicantPermanentAddress: second.permanentAddress,
    organizationType: booking.profession.organizationType,
    industry: booking.profession.industry,
    referredBy: booking.referredBy,
    bookingCancellationReason: booking.cancellationReason,
    bookingCancellationStatus: booking.cancellationStatus,
    bookingCancellationDate: booking.cancellationRequestedAt,
    cancellationRequestRaisedDate: booking.cancellationRequestedAt,
    createdBy: booking.createdBy ? personName(booking.createdBy) : null,
    createdAt: booking.createdAt,
    lastModifiedBy: null,
    recordOwner: bookingOwnerName(booking),
    updatedAt: booking.updatedAt || booking.createdAt,
    Id: booking.id,
    Name: booking.bookingNumber,
    CreatedById: booking.createdBy ? personName(booking.createdBy) : null,
    CreatedDate: booking.createdAt,
    LastModifiedDate: booking.updatedAt || booking.createdAt,
    LastReferencedDate: booking.createdAt,
    LastViewedDate: booking.createdAt,
    OwnerId: bookingOwnerName(booking),
    Booking_Date__c: booking.createdAt.slice(0, 10),
    Booking_DateTime__c: booking.createdAt,
    Booking_Amount1__c: booking.bookingAmount,
    Project__c: booking.project.name,
    Lead__c: leadName || booking.lead?.leadNumber,
    SLead__c: leadName || booking.lead?.leadNumber,
    Client_Name__c: applicantName,
    First_Applicant_Name__c: first.name,
    Applicant_Name__c: first.name,
    Salutation__c: first.salutation,
    Aadhaar_Number__c: first.aadhaarNumber,
    Aadhaar1__c: first.aadhaarNumber,
    PAN_Number__c: first.panNumber,
    Email__c: first.email,
    Date_of_Birth__c: first.dateOfBirth,
    Contact_Number__c: first.mobileNumber,
    Marital_Status__c: first.maritalStatus,
    Nationality__c: first.nationality,
    State__c: first.state,
    District__c: first.district,
    Communication_Address__c: first.correspondingAddress,
    Permanent_Address__c: first.permanentAddress,
    First_Applicant_Photo__c: first.photoUrl,
    Second_Applicant_Name__c: second.name,
    Date_of_Birth3__c: second.dateOfBirth,
    Contact_Number1__c: second.mobileNumber,
    Email1__c: second.email,
    Unit_NumberFor__c: booking.unit.number,
    Unit_Status__c: booking.unit.status,
    Plot_Land_Area__c: booking.plotDetails.areaCent ?? booking.unit.area,
    Plot_Sq_ft__c: booking.unit.area,
    GRAND_TOTAL__c: booking.quotation.totalPrice,
    Total_Amount__c: booking.quotation.totalPrice,
    Total_Price__c: booking.quotation.totalPrice,
    Balance_Amount__c: booking.quotation.totalPrice,
    Unit_Facing_Direction__c: booking.plotDetails.facingDirection,
    Booking_Owner__c: bookingOwnerName(booking),
  };
}

function fieldInputValue(field: BookingDetailField, value: unknown): string | boolean {
  if (field.fieldType === "checkbox") return value === true;
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (field.fieldType === "date") return stringValue.slice(0, 10);
  if (field.fieldType === "dateTime") {
    const date = new Date(stringValue);
    if (Number.isNaN(date.getTime())) return stringValue.slice(0, 16);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }
  return stringValue;
}

function displayBookingDetail(field: BookingDetailField, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (field.label.toLowerCase().includes("photo") && typeof value === "string" && value.startsWith("data:image/")) {
    return <Image src={value} alt={field.label} width={44} height={44} unoptimized className="h-10 w-10 rounded border object-cover" />;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if ((field.fieldType === "currency") && typeof value === "number") return currency(value);
  if (field.fieldType === "date" || field.fieldType === "dateTime") {
    const date = new Date(String(value));
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("en-IN", field.fieldType === "dateTime"
        ? { dateStyle: "medium", timeStyle: "short" }
        : { dateStyle: "medium" }).format(date);
    }
  }
  return String(value);
}

export function BookingDetailsBody({ booking, onSaved }: { booking: BookingRecord; onSaved: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [editValues, setEditValues] = React.useState<Record<string, string | boolean>>({});
  const initialEditValues = React.useRef<Record<string, string | boolean>>({});
  const fallbacks = bookingDetailFallbacks(booking);
  const details = booking.details || {};
  const valueFor = (name: string) =>
    Object.prototype.hasOwnProperty.call(details, name) ? details[name] : fallbacks[name];

  const startEditing = () => {
    const values = Object.fromEntries(BOOKING_DETAIL_FIELDS
      .filter((field) => field.editable !== false)
      .map((field) => [field.name, fieldInputValue(field, valueFor(field.name))]));
    initialEditValues.current = values;
    setEditValues(values);
    setEditing(true);
  };

  const saveDetails = async () => {
    const changedFields = BOOKING_DETAIL_FIELDS.filter((field) =>
      field.editable !== false && editValues[field.name] !== initialEditValues.current[field.name],
    );
    if (changedFields.length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      const savedDetails = Object.fromEntries(changedFields
        .map((field) => {
          const value = editValues[field.name];
          if (field.fieldType === "checkbox") return [field.name, value === true];
          if (value === "" || value === undefined) return [field.name, null];
          if (field.fieldType === "number" || field.fieldType === "currency") return [field.name, Number(value)];
          return [field.name, String(value)];
        }));
      await bookingApi.updateDetails(booking.id, savedDetails);
      setEditing(false);
      toast({ title: "Booking details saved" });
      onSaved();
    } catch (cause) {
      const message = (cause as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast({ title: message || "Could not save booking details", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const sections = new Map<string, BookingDetailField[]>();
  for (const field of BOOKING_DETAIL_FIELDS) {
    sections.set(field.section, [...(sections.get(field.section) || []), field]);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        {editing ? (
          <>
            <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="button" size="sm" disabled={saving} onClick={() => void saveDetails()}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save Details
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={startEditing}>Edit Details</Button>
        )}
      </div>

      {[...sections].map(([section, fields]) => (
        <section key={section} className="overflow-hidden rounded-md border border-sky-100 bg-white">
          <h3 className="border-b border-sky-100 bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-800">{section}</h3>
          <dl className="grid gap-x-6 px-3 md:grid-cols-2">
            {fields.map((field) => {
              const currentValue = valueFor(field.name);
              const value = editing ? editValues[field.name] : currentValue;
              const canEdit = editing && field.editable !== false;
              return (
                <div key={field.name} className="grid min-h-9 min-w-0 grid-cols-[minmax(120px,0.9fr)_minmax(0,1.1fr)] items-center gap-2 border-b py-1.5 last:border-b-0">
                  <dt className="text-xs text-slate-600">{field.label}</dt>
                  <dd className="min-w-0 break-words text-xs font-medium text-slate-800">
                    {canEdit && field.fieldType === "checkbox" ? (
                      <input
                        type="checkbox"
                        aria-label={field.label}
                        checked={value === true}
                        onChange={(event) => setEditValues((current) => ({ ...current, [field.name]: event.target.checked }))}
                        className="h-4 w-4 rounded border-sky-300 accent-sky-700"
                      />
                    ) : canEdit && field.fieldType === "longText" ? (
                      <textarea
                        aria-label={field.label}
                        value={typeof value === "string" ? value : ""}
                        onChange={(event) => setEditValues((current) => ({ ...current, [field.name]: event.target.value }))}
                        rows={2}
                        className="w-full rounded border border-sky-200 bg-white px-2 py-1 text-xs font-normal"
                      />
                    ) : canEdit ? (
                      field.fieldType === "currency" ? <CurrencyInput
                        aria-label={field.label}
                        step="any"
                        value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
                        onChange={(event) => setEditValues((current) => ({ ...current, [field.name]: event.target.value }))}
                        className="h-8 px-2 pl-7 text-xs font-normal"
                      /> : <Input
                        aria-label={field.label}
                        type={field.fieldType === "dateTime" ? "datetime-local" : field.fieldType === "date" ? "date" : field.fieldType === "number" ? "number" : field.fieldType === "email" ? "email" : "text"}
                        step={field.fieldType === "number" ? "any" : undefined}
                        value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
                        onChange={(event) => setEditValues((current) => ({ ...current, [field.name]: event.target.value }))}
                        className="h-8 w-full rounded border border-sky-200 bg-white px-2 text-xs font-normal"
                      />
                    ) : (
                      displayBookingDetail(field, currentValue)
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}

      {additionalApplicants(booking.profession).map((applicant, index) => (
        <ApplicantDetails key={`${applicant.name || "applicant"}-${index}`} title={index === 0 ? "Third applicant" : "Fourth applicant"} applicant={applicant} />
      ))}
    </div>
  );
}

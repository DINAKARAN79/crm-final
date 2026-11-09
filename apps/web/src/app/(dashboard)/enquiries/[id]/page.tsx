"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Inbox } from "lucide-react";
import { enquiryApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordPageHeader } from "@/components/crm/record-page-header";
import { formatDateTime } from "@/lib/date-format";

type EnquiryDetail = {
  id: string;
  enquiryNumber: string;
  leadType: string;
  enquiryType: string;
  source: string;
  subSource?: string | null;
  medium?: string | null;
  campaign?: string | null;
  subCampaign?: string | null;
  project?: { id: string; name: string } | null;
  countryCode?: string | null;
  phone?: string | null;
  secondaryCountryCode?: string | null;
  secondaryPhone?: string | null;
  tertiaryPhone?: string | null;
  email?: string | null;
  secondaryEmail?: string | null;
  tertiaryEmail?: string | null;
  description?: string | null;
  channelPartner?: string | null;
  enquiryDate: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: { firstName: string; lastName: string } | null;
  lastModifiedBy?: { firstName: string; lastName: string } | null;
  lead: { id: string; leadNumber?: string | null; firstName?: string | null; lastName: string; company: string };
};

function personName(person?: { firstName: string; lastName: string } | null) {
  return person ? `${person.firstName} ${person.lastName}`.trim() : "—";
}

function displayDate(value?: string | null) {
  return value ? formatDateTime(value) : "—";
}

function formatLeadTypeLabel(leadType?: string | null) {
  switch (leadType) {
    case "ORIGINAL":
    case "ADDITIONAL":
      return "Fresh";
    case "RE_ENGAGED":
      return "Re-Engaged";
    case "RE_OPENED":
      return "Re-Opened";
    default:
      return leadType ? leadType.replaceAll("_", " ") : "—";
  }
}

function DetailField({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b py-3 sm:grid-cols-[190px_1fr] sm:items-start">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium">{value || "—"}</dd>
    </div>
  );
}

export default function EnquiryDetailPage() {
  const params = useParams<{ id: string }>();
  const enquiryId = params.id;
  const [enquiry, setEnquiry] = React.useState<EnquiryDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let active = true;
    enquiryApi.get(enquiryId).then((response) => {
      if (active) setEnquiry(response.data.data || null);
    }).catch((loadError: any) => {
      if (active) setError(loadError?.response?.data?.error || "Unable to load this enquiry.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [enquiryId]);

  if (loading) return <div className="p-8 text-sm text-muted-foreground">Loading enquiry...</div>;
  if (error || !enquiry) {
    return (
      <div className="space-y-4">
        <Button variant="outline" asChild><Link href="/leads"><ArrowLeft className="mr-2 h-4 w-4" />Back to Leads</Link></Button>
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error || "Enquiry not found."}</div>
      </div>
    );
  }

  const leadName = [enquiry.lead.firstName, enquiry.lead.lastName].filter(Boolean).join(" ");
  const leadPath = `/leads/${enquiry.lead.id}`;
  const fields = [
    ["Related Enquiry", enquiry.enquiryNumber],
    ["Lead ID", enquiry.lead.leadNumber || enquiry.lead.id],
    ["Lead", <Link key="lead" className="text-primary hover:underline" href={leadPath}>{leadName || enquiry.lead.company}</Link>],
    ["Lead Type", formatLeadTypeLabel(enquiry.leadType)],
    ["Enquiry Type", enquiry.enquiryType.replaceAll("_", " ")],
    ["Enquiry Source", enquiry.source],
    ["Sub Source", enquiry.subSource],
    ["Medium", enquiry.medium],
    ["Campaign", enquiry.campaign],
    ["Sub Campaign", enquiry.subCampaign],
    ["Allocated Project", enquiry.project?.name],
    ["Country Code", enquiry.countryCode],
    ["Phone", enquiry.phone],
    ["Secondary Country Code", enquiry.secondaryCountryCode],
    ["Secondary Phone", enquiry.secondaryPhone],
    ["Tertiary Phone", enquiry.tertiaryPhone],
    ["Email", enquiry.email],
    ["Secondary Email", enquiry.secondaryEmail],
    ["Tertiary Email", enquiry.tertiaryEmail],
    ["Description", enquiry.description],
    ["Channel Partner", enquiry.channelPartner],
    ["Enquiry Date", displayDate(enquiry.enquiryDate)],
    ["Created By", personName(enquiry.createdBy)],
    ["Created Date", displayDate(enquiry.createdAt)],
    ["Last Modified By", personName(enquiry.lastModifiedBy)],
    ["Last Modified Date", displayDate(enquiry.updatedAt)],
  ] as const;

  return (
    <div className="space-y-6">
      <RecordPageHeader
        objectLabel="Enquiry"
        title={enquiry.enquiryNumber}
        subtitle={`Lead: ${enquiry.lead.leadNumber || `${enquiry.lead.firstName || ""} ${enquiry.lead.lastName}`.trim()}`}
        backHref={leadPath}
        icon={<Inbox className="h-5 w-5" aria-hidden="true" />}
      />
      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid gap-x-10 md:grid-cols-2">
            {fields.map(([label, value]) => <DetailField key={label} label={label} value={value} />)}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
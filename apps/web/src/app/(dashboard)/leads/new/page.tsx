"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { leadApi, objectDefinitionApi, projectApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

interface Project {
  id: string;
  name: string;
}

type PicklistOption = { label: string; value: string };
type LeadPicklists = Record<"source" | "firstCampaign" | "lastCampaign" | "leadInterest", PicklistOption[]>;

const COUNTRY_OPTIONS = [
  { name: "India", code: "91" },
  { name: "United States", code: "1" },
  { name: "United Kingdom", code: "44" },
  { name: "United Arab Emirates", code: "971" },
  { name: "Australia", code: "61" },
  { name: "Canada", code: "1" },
  { name: "Singapore", code: "65" },
];

const CONTROL_CLASS = "h-10 w-full rounded-md border border-sky-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100";

function Field({
  id,
  label,
  required,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[12px] font-semibold text-[#1479a8]">
        {required && <span className="mr-1 text-destructive">*</span>}
        {label}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export default function NewLeadPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [leadInterestRequired, setLeadInterestRequired] = React.useState(false);
  const [picklists, setPicklists] = React.useState<LeadPicklists>({
    source: [],
    firstCampaign: [],
    lastCampaign: [],
    leadInterest: [],
  });
  const [formData, setFormData] = React.useState({
    salutation: "",
    firstName: "",
    lastName: "",
    phone: "",
    secondaryPhone: "",
    tertiaryPhone: "",
    country: "India",
    countryCode: "91",
    secondaryCountryCode: "91",
    tertiaryCountryCode: "91",
    email: "",
    secondaryEmail: "",
    tertiaryEmail: "",
    source: "",
    projectId: "",
    leadInterest: "",
    campaign: "",
    subCampaign: "",
  });

  React.useEffect(() => {
    let active = true;
    const loadOptions = async () => {
      try {
        const [projectsResponse, fieldsResponse] = await Promise.all([
          projectApi.listAll({ isActive: true }),
          objectDefinitionApi.fields("Lead"),
        ]);
        const fields = Array.isArray(fieldsResponse.data?.data) ? fieldsResponse.data.data : [];
        const nextPicklists: LeadPicklists = {
          source: [],
          firstCampaign: [],
          lastCampaign: [],
          leadInterest: [],
        };
        for (const field of fields) {
          if (field.fieldType !== "picklist" || !(field.name in nextPicklists)) continue;
          nextPicklists[field.name as keyof LeadPicklists] = (field.picklistValues || [])
            .filter((option: { isActive?: boolean }) => option.isActive !== false)
            .map((option: { label: string; value: string }) => ({
              label: option.label,
              value: option.value,
            }));
        }
        const leadInterestField = fields.find(
          (field: { name: string; fieldType: string; required?: boolean }) =>
            field.name === "leadInterest" && field.fieldType === "picklist",
        );
        if (active) {
          setProjects(projectsResponse);
          setPicklists(nextPicklists);
          setLeadInterestRequired(leadInterestField?.required === true);
        }
      } catch (reason: any) {
        if (active) {
          const message = reason?.response?.data?.error || reason?.message || "Unable to load lead form options.";
          setError(message);
          toast({ title: "Error", description: message, variant: "destructive" });
        }
      } finally {
        if (active) setIsLoading(false);
      }
    };
    void loadOptions();
    return () => {
      active = false;
    };
  }, [toast]);

  const updateField = (field: keyof typeof formData, value: string) => {
    setFormData((current) => ({ ...current, [field]: value }));
    setError(null);
    setFieldErrors({});
  };

  const handleCountryChange = (country: string) => {
    const selected = COUNTRY_OPTIONS.find((option) => option.name === country);
    setFormData((current) => ({
      ...current,
      country,
      countryCode: selected?.code || current.countryCode,
      secondaryCountryCode: selected?.code || current.secondaryCountryCode,
      tertiaryCountryCode: selected?.code || current.tertiaryCountryCode,
    }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const missing = [
      ["lastName", "Last Name"],
      ["phone", "Primary Phone"],
      ["source", "Lead Source"],
      ["projectId", "Project Name"],
    ].filter(([key]) => !formData[key as keyof typeof formData].trim());
    if (leadInterestRequired && !formData.leadInterest.trim()) {
      missing.push(["leadInterest", "Lead Interest"]);
    }
    if (missing.length) {
      setError(`${missing.map(([, label]) => label).join(", ")} ${missing.length === 1 ? "is" : "are"} required.`);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const displayName = [formData.firstName.trim(), formData.lastName.trim()].filter(Boolean).join(" ");
      const payload = {
        salutation: formData.salutation || undefined,
        firstName: formData.firstName.trim() || undefined,
        lastName: formData.lastName.trim(),
        company: displayName,
        phone: formData.phone.trim(),
        secondaryPhone: formData.secondaryPhone.trim() || undefined,
        tertiaryPhone: formData.tertiaryPhone.trim() || undefined,
        country: formData.country,
        countryCode: formData.countryCode,
        secondaryCountryCode: formData.secondaryCountryCode,
        tertiaryCountryCode: formData.tertiaryCountryCode,
        email: formData.email.trim() || undefined,
        secondaryEmail: formData.secondaryEmail.trim() || undefined,
        tertiaryEmail: formData.tertiaryEmail.trim() || undefined,
        source: formData.source,
        projectId: formData.projectId,
        leadInterest: formData.leadInterest,
        firstCampaign: formData.campaign || undefined,
        lastCampaign: formData.subCampaign || undefined,
        campaign: formData.campaign || undefined,
        subCampaign: formData.subCampaign || undefined,
        statusId: "1",
      };
      const response = await leadApi.create(payload);
      const responseData: { success: boolean; error?: string; action?: string } = response.data;
      if (!responseData.success) {
        throw new Error(responseData.error || "Failed to create lead.");
      }
      toast({
        title: "Success",
        description: responseData.action === "NEW_LEAD" ? "Lead created successfully." : "Lead already exists.",
      });
      router.push("/leads");
    } catch (reason: any) {
      const apiFieldErrors = reason?.response?.data?.fieldErrors as Array<{ field: string; message: string }> | undefined;
      if (apiFieldErrors?.length) {
        setFieldErrors(Object.fromEntries(apiFieldErrors.map(({ field, message }) => [field, message])));
      }
      const duplicateFields = reason?.response?.data?.fields as string[] | undefined;
      if (reason?.response?.data?.code === "DUPLICATE_LEAD" && duplicateFields?.length) {
        const duplicateMessage = reason.response.data.error || "A lead with these contact details already exists in your tenant.";
        setFieldErrors(Object.fromEntries(duplicateFields.map((field) => [field, duplicateMessage])));
      }
      const message =
        reason?.response?.data?.error ||
        reason?.response?.data?.message ||
        reason?.message ||
        "Failed to create lead.";
      setError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/leads" aria-label="Back to leads">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[#075d91]">Create Lead</h1>
          <p className="text-[12px] text-[#1479a8]">Add a new lead</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <Card className="crm-page-form rounded-xl border-sky-100 bg-[#f5fbff] shadow-sm [&_input:not([type=checkbox])]:h-10 [&_input:not([type=checkbox])]:border-sky-200 [&_input:not([type=checkbox])]:bg-white [&_textarea]:border-sky-200 [&_textarea]:bg-white">
          <CardHeader className="border-b border-sky-100 bg-gradient-to-br from-white to-sky-50 text-center">
            <CardTitle className="text-lg text-[#075d91]">New Lead</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 p-5">
            {error && (
              <div role="alert" className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            {isLoading ? (
              <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading project and field options...
              </div>
            ) : (
              <>
                <div className="crm-form-grid crm-form-grid-3">
                  <Field id="salutation" label="Salutation">
                    <select
                      id="salutation"
                      className={CONTROL_CLASS}
                      value={formData.salutation}
                      onChange={(event) => updateField("salutation", event.target.value)}
                    >
                      <option value="">--None--</option>
                      <option value="MR">Mr.</option>
                      <option value="MS">Ms.</option>
                      <option value="MRS">Mrs.</option>
                      <option value="DR">Dr.</option>
                      <option value="PROF">Prof.</option>
                    </select>
                  </Field>
                  <Field id="first-name" label="First Name">
                    <Input id="first-name" value={formData.firstName} onChange={(event) => updateField("firstName", event.target.value)} />
                  </Field>
                  <Field id="last-name" label="Last Name" required>
                    <Input id="last-name" value={formData.lastName} onChange={(event) => updateField("lastName", event.target.value)} />
                  </Field>
                </div>

                <div className="crm-field-row">
                  <Field id="country-code" label="Primary Country Code" error={fieldErrors.countryCode}>
                    <select id="country-code" aria-invalid={Boolean(fieldErrors.countryCode)} className={CONTROL_CLASS} value={formData.countryCode} onChange={(event) => updateField("countryCode", event.target.value)}>
                      {[...new Set(COUNTRY_OPTIONS.map((country) => country.code))].map((code) => (
                        <option key={code} value={code}>+{code}</option>
                      ))}
                    </select>
                  </Field>
                  <Field id="primary-phone" label="Primary Phone" required error={fieldErrors.phone}>
                    <Input id="primary-phone" type="tel" aria-invalid={Boolean(fieldErrors.phone)} value={formData.phone} onChange={(event) => updateField("phone", event.target.value)} />
                  </Field>
                </div>

                <div className="crm-field-row">
                  <Field id="secondary-country-code" label="Secondary Country Code" error={fieldErrors.secondaryCountryCode}>
                    <select id="secondary-country-code" aria-invalid={Boolean(fieldErrors.secondaryCountryCode)} className={CONTROL_CLASS} value={formData.secondaryCountryCode} onChange={(event) => updateField("secondaryCountryCode", event.target.value)}>
                      {[...new Set(COUNTRY_OPTIONS.map((country) => country.code))].map((code) => (
                        <option key={code} value={code}>+{code}</option>
                      ))}
                    </select>
                  </Field>
                  <Field id="secondary-phone" label="Secondary Phone" error={fieldErrors.secondaryPhone}>
                    <Input id="secondary-phone" type="tel" aria-invalid={Boolean(fieldErrors.secondaryPhone)} value={formData.secondaryPhone} onChange={(event) => updateField("secondaryPhone", event.target.value)} />
                  </Field>
                </div>

                <div className="crm-field-row">
                  <Field id="tertiary-country-code" label="Tertiary Country Code" error={fieldErrors.tertiaryCountryCode}>
                    <select id="tertiary-country-code" aria-invalid={Boolean(fieldErrors.tertiaryCountryCode)} className={CONTROL_CLASS} value={formData.tertiaryCountryCode} onChange={(event) => updateField("tertiaryCountryCode", event.target.value)}>
                      {[...new Set(COUNTRY_OPTIONS.map((country) => country.code))].map((code) => (
                        <option key={code} value={code}>+{code}</option>
                      ))}
                    </select>
                  </Field>
                  <Field id="tertiary-phone" label="Tertiary Phone" error={fieldErrors.tertiaryPhone}>
                    <Input id="tertiary-phone" type="tel" aria-invalid={Boolean(fieldErrors.tertiaryPhone)} value={formData.tertiaryPhone} onChange={(event) => updateField("tertiaryPhone", event.target.value)} />
                  </Field>
                </div>

                <div className="crm-form-grid">
                  <Field id="country" label="Country">
                    <select id="country" className={CONTROL_CLASS} value={formData.country} onChange={(event) => handleCountryChange(event.target.value)}>
                      {COUNTRY_OPTIONS.map((country) => <option key={country.name} value={country.name}>{country.name}</option>)}
                    </select>
                  </Field>
                  <Field id="email" label="Email" error={fieldErrors.email}>
                    <Input id="email" type="email" aria-invalid={Boolean(fieldErrors.email)} value={formData.email} onChange={(event) => updateField("email", event.target.value)} />
                  </Field>
                  <Field id="secondary-email" label="Secondary Email" error={fieldErrors.secondaryEmail}>
                    <Input id="secondary-email" type="email" aria-invalid={Boolean(fieldErrors.secondaryEmail)} value={formData.secondaryEmail} onChange={(event) => updateField("secondaryEmail", event.target.value)} />
                  </Field>
                  <Field id="tertiary-email" label="Tertiary Email" error={fieldErrors.tertiaryEmail}>
                    <Input id="tertiary-email" type="email" aria-invalid={Boolean(fieldErrors.tertiaryEmail)} value={formData.tertiaryEmail} onChange={(event) => updateField("tertiaryEmail", event.target.value)} />
                  </Field>
                  <Field id="lead-source" label="Lead Source" required error={fieldErrors.source}>
                    <select id="lead-source" aria-invalid={Boolean(fieldErrors.source)} className={CONTROL_CLASS} value={formData.source} onChange={(event) => updateField("source", event.target.value)}>
                      <option value="">--None--</option>
                      {picklists.source.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </Field>
                  <Field id="project-name" label="Project Name" required>
                    <select id="project-name" className={CONTROL_CLASS} value={formData.projectId} onChange={(event) => updateField("projectId", event.target.value)}>
                      <option value="">--None--</option>
                      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                  </Field>
                  <Field id="lead-interest" label="Lead Interest" required={leadInterestRequired} error={fieldErrors.leadInterest}>
                    <select id="lead-interest" aria-invalid={Boolean(fieldErrors.leadInterest)} className={CONTROL_CLASS} value={formData.leadInterest} onChange={(event) => updateField("leadInterest", event.target.value)}>
                      <option value="">--None--</option>
                      {picklists.leadInterest.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </Field>
                  <Field id="campaign" label="Campaign" error={fieldErrors.firstCampaign}>
                    <select id="campaign" aria-invalid={Boolean(fieldErrors.firstCampaign)} className={CONTROL_CLASS} value={formData.campaign} onChange={(event) => updateField("campaign", event.target.value)}>
                      <option value="">--None--</option>
                      {picklists.firstCampaign.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </Field>
                  <Field id="sub-campaign" label="Sub Campaign" error={fieldErrors.lastCampaign}>
                    <select id="sub-campaign" aria-invalid={Boolean(fieldErrors.lastCampaign)} className={CONTROL_CLASS} value={formData.subCampaign} onChange={(event) => updateField("subCampaign", event.target.value)}>
                      <option value="">--None--</option>
                      {picklists.lastCampaign.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </Field>
                </div>
              </>
            )}
          </CardContent>
          <CardFooter className="flex-col-reverse gap-2 border-t border-sky-100 bg-sky-50/60 p-4 sm:flex-row sm:flex-wrap sm:justify-end">
            <Button type="button" variant="outline" className="border-sky-200 bg-white text-[#075d91] hover:bg-sky-50" onClick={() => router.push("/leads")} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" className="bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-sm shadow-blue-200 hover:from-blue-700 hover:to-blue-600" disabled={isSubmitting || isLoading}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}

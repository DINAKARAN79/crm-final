"use client";
/* eslint-disable react-hooks/exhaustive-deps */

import * as React from "react";
import {
  DragDropContext,
  Draggable,
  Droppable,
  type DropResult,
} from "@hello-pangea/dnd";
import api, { objectManagerApi } from "@/lib/api";
import { layoutSectionsForForm } from "@dct-crm/shared";
import { useAuth } from "@/contexts/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { TelephonyStatusHint } from "@/components/crm/telephony-status-hint";
import { isValidTelephonyNumber } from "@/lib/telephony-navigation";
import { GripVertical, Pencil, Save, X } from "lucide-react";

interface LayoutSection {
  name: string;
  fields: string[];
  columns?: 1 | 2;
  showOnEdit?: boolean;
  showOnDetail?: boolean;
  readOnly?: Record<string, boolean>;
  required?: Record<string, boolean>;
}

interface LayoutField {
  name: string;
  label: string;
  fieldType: string;
  required: boolean;
  editable: boolean;
  visible: boolean;
  isSystemField: boolean;
  isStandardField: boolean;
  defaultValue?: string;
  lookupObject?: string;
  lookupField?: string;
  picklistValues?: { label: string; value: string; isActive: boolean }[];
  minLength?: number;
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
}

interface LayoutDrivenFormProps {
  objectName: string;
  mode: "create" | "edit" | "detail";
  data?: Record<string, any>;
  onChange?: (field: string, value: any) => void;
  onSubmit?: (data: Record<string, any>) => void;
  layout?: any;
  fields?: any[];
  projects?: { id: string; name: string; isActive?: boolean }[];
  fieldErrors?: Record<string, string>;
  editingFieldName?: string | null;
  onBeginEdit?: (fieldName: string) => void;
  onEditOwner?: () => void;
  canEditLayout?: boolean;
  onSaveLayout?: (sections: LayoutSection[]) => Promise<void>;
  onCallPhone?: (fieldName: "phone" | "mobile" | "secondaryPhone") => void;
  getPhoneUnavailableReason?: (fieldName: "phone" | "mobile" | "secondaryPhone", phone: string) => string;
  isTelephonyAdmin?: boolean;
  telephonyLeadId?: string;
  telephonyTenantId?: string;
  callingPhoneField?: string | null;
}

export default function LayoutDrivenForm({
  objectName,
  mode,
  data = {},
  onChange,
  onSubmit,
  layout: propLayout,
  fields: propFields,
  projects = [],
  fieldErrors,
  editingFieldName = null,
  onBeginEdit,
  onEditOwner,
  canEditLayout = false,
  onSaveLayout,
  onCallPhone,
  getPhoneUnavailableReason,
  isTelephonyAdmin = false,
  telephonyLeadId,
  telephonyTenantId,
  callingPhoneField = null,
}: LayoutDrivenFormProps) {
  const { leadStatuses, getLeadStatusLabel } = useAuth();
  const [layout, setLayout] = React.useState<any>(propLayout || null);
  const [fields, setFields] = React.useState<LayoutField[]>(propFields || []);
  const [isLoading, setIsLoading] = React.useState(!propLayout);
  const [lookupOptions, setLookupOptions] = React.useState<Record<string, any[]>>({});
  const [isEditingLayout, setIsEditingLayout] = React.useState(false);
  const [layoutDraft, setLayoutDraft] = React.useState<LayoutSection[]>([]);
  const [isSavingLayout, setIsSavingLayout] = React.useState(false);

  React.useEffect(() => {
    if (propLayout) {
      setLayout(propLayout);
    }
    if (propFields) {
      setFields(propFields);
    }
    if (!propLayout || !propFields) {
      loadData();
    }
  }, [objectName, propLayout, propFields]);

  const loadData = async () => {
    try {
      setIsLoading(true);
      const [assignedRes, layoutRes, fieldsRes] = await Promise.all([
        api.get("/api/layout-assignments/resolve", { params: { object: objectName } }).catch(() => null),
        objectManagerApi.getDefaultLayout(objectName),
        objectManagerApi.listFields(objectName, { includeSystem: true }),
      ]);
      setLayout(assignedRes?.data?.data || layoutRes.data.data);
      setFields(fieldsRes.data.data || []);
    } catch {
      console.error("Failed to load layout");
    } finally {
      setIsLoading(false);
    }
  };

  const sections: LayoutSection[] = React.useMemo(() => {
    if (!layout) return [];
    const configuredSections: LayoutSection[] = layoutSectionsForForm(layout.sections, objectName)
      .filter((section) => (mode === "detail" ? section.showOnDetail : section.showOnEdit))
      .map((section) => ({
        name: section.name,
        fields: section.fields,
        columns: section.columns,
        showOnEdit: section.showOnEdit,
        showOnDetail: section.showOnDetail,
        readOnly: section.readOnly,
        required: section.required,
      }));
    if (objectName !== "Lead") {
      return configuredSections;
    }
    const leadInformationIndex = configuredSections.findIndex(
      (section) => section.name === "Lead Information" || section.name === "Lead Details",
    );
    if (leadInformationIndex < 0) {
      return [
        ...configuredSections.map((section) => ({
          ...section,
          fields: section.fields.filter((field) =>
            field !== "projectId" && field !== "record_number",
          ),
        })),
        { name: "Lead Information", fields: ["projectId"], columns: 2 },
      ];
    }
    return configuredSections.flatMap((section, index) => {
      const fields = section.fields.filter((field) =>
        field !== "projectId" && field !== "record_number",
      );
      if (index !== leadInformationIndex) {
        return [{ ...section, fields }];
      }
      return [{
        name: "Lead Information",
        fields: ["projectId", ...fields],
      }];
    });
  }, [layout, objectName]);

  const formFields = React.useMemo(() => {
    const leadFields = objectName === "Lead"
      ? fields.map((field) => field.name === "status" ? {
          ...field,
          fieldType: "picklist",
          picklistValues: leadStatuses.map((status) => ({
            label: status.label,
            value: status.statusId,
            isActive: status.enabled,
          })),
        } : field)
      : fields;
    if (objectName !== "Lead" || leadFields.some((field) => field.name === "projectId")) return leadFields;
    return [...leadFields, {
      name: "projectId",
      label: "Project",
      fieldType: "lookup",
      required: false,
      editable: true,
      visible: true,
      isSystemField: false,
      isStandardField: true,
      lookupObject: "Project",
    }];
  }, [fields, leadStatuses, objectName]);

  const getFieldDef = (fieldName: string): LayoutField | undefined =>
    formFields.find((f) => f.name === fieldName);

  const handleFieldChange = (fieldName: string, value: any) => {
    if (onChange) onChange(fieldName, value);
  };

  const handleLayoutDragEnd = (result: DropResult) => {
    const { source, destination } = result;
    if (!destination) return;

    const sourceSectionIndex = Number(source.droppableId);
    const destinationSectionIndex = Number(destination.droppableId);
    if (
      !Number.isInteger(sourceSectionIndex) ||
      !Number.isInteger(destinationSectionIndex) ||
      !layoutDraft[sourceSectionIndex] ||
      !layoutDraft[destinationSectionIndex]
    ) return;

    setLayoutDraft((current) => {
      const next = current.map((section) => ({ ...section, fields: [...section.fields] }));
      const visibleNames = (section: LayoutSection) => section.fields.filter((fieldName) => {
        const field = getFieldDef(fieldName);
        return field && field.visible !== false;
      });
      const sourceVisibleNames = visibleNames(next[sourceSectionIndex]);
      const [movedField] = sourceVisibleNames.splice(source.index, 1);
      if (!movedField) return current as LayoutSection[];

      const sourceFieldIndex = next[sourceSectionIndex].fields.indexOf(movedField);
      next[sourceSectionIndex].fields.splice(sourceFieldIndex, 1);

      const destinationVisibleNames = visibleNames(next[destinationSectionIndex]);
      const targetFieldName = destinationVisibleNames[destination.index];
      const destinationFieldIndex = targetFieldName
        ? next[destinationSectionIndex].fields.indexOf(targetFieldName)
        : destinationVisibleNames.length
          ? next[destinationSectionIndex].fields.indexOf(destinationVisibleNames[destinationVisibleNames.length - 1]) + 1
          : next[destinationSectionIndex].fields.length;
      next[destinationSectionIndex].fields.splice(destinationFieldIndex, 0, movedField);
      return next;
    });
  };

  const saveLayoutDraft = async () => {
    if (!onSaveLayout || isSavingLayout) return;
    setIsSavingLayout(true);
    try {
      await onSaveLayout(layoutDraft);
      setIsEditingLayout(false);
    } catch {
      return;
    } finally {
      setIsSavingLayout(false);
    }
  };

  const renderField = (field: LayoutField, value: any) => {
    const isDisabled =
      (mode === "detail" && editingFieldName !== field.name) ||
      !field.editable ||
      field.isSystemField;

    switch (field.fieldType) {
      case "text":
      case "autoNumber":
        return (
          <Input
            value={value || ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            disabled={isDisabled}
            placeholder={field.label}
            maxLength={field.maxLength}
          />
        );

      case "email":
        return (
          <Input
            type="email"
            value={value || ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            disabled={isDisabled}
            placeholder={field.label}
          />
        );

      case "phone":
        return (
          <Input
            type="tel"
            value={value || ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            disabled={isDisabled}
            placeholder={field.label}
          />
        );

      case "url":
        return (
          <Input
            type="url"
            value={value || ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            disabled={isDisabled}
            placeholder={field.label}
          />
        );

      case "number":
        return (
          <Input
            type="number"
            value={value || ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value ? Number(e.target.value) : null)}
            disabled={isDisabled}
            min={field.minValue}
            max={field.maxValue}
          />
        );

      case "currency":
        return (
          <CurrencyInput
            value={value ?? ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value ? Number(e.target.value) : null)}
            disabled={isDisabled}
            min={field.minValue || 0}
            step="0.01"
          />
        );

      case "boolean":
        return (
          <Switch
            checked={!!value}
            onCheckedChange={(checked: boolean) => handleFieldChange(field.name, checked)}
            disabled={isDisabled}
          />
        );

      case "date":
        return (
          <Input
            type="date"
            value={value ? new Date(value).toISOString().split("T")[0] : ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value || null)}
            disabled={isDisabled}
          />
        );

      case "dateTime":
        return (
          <Input
            type="datetime-local"
            value={value ? new Date(value).toISOString().slice(0, 16) : ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value || null)}
            disabled={isDisabled}
          />
        );

      case "time":
        return (
          <Input
            type="time"
            value={value || ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value || null)}
            disabled={isDisabled}
          />
        );

      case "picklist":
        const selectedValue = field.name === "status" && objectName === "Lead"
          ? leadStatuses.find((status) => status.status === value)?.statusId || value
          : value;
        return (
          <Select
            value={selectedValue || ""}
            onValueChange={(v) => handleFieldChange(field.name, v || null)}
            disabled={isDisabled}
          >
            <SelectTrigger>
              <SelectValue placeholder={`Select ${field.label}`} />
            </SelectTrigger>
            <SelectContent>
              {field.picklistValues
                ?.filter((pv) => pv.isActive)
                .map((pv) => (
                  <SelectItem key={pv.value} value={pv.value}>
                    {pv.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        );

      case "lookup":
        if (field.name === "projectId" || field.lookupObject === "Project") {
          return (
            <Select
              value={value || "__no_project__"}
              onValueChange={(selected) => handleFieldChange(field.name, selected === "__no_project__" ? null : selected)}
              disabled={isDisabled}
            >
              <SelectTrigger aria-label={field.label}>
                <SelectValue placeholder="Select Project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__no_project__">No Project</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        }
        return (
          <Input
            value={value || ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            disabled={isDisabled}
            placeholder={`Lookup: ${field.lookupObject}`}
          />
        );

      case "longText":
      case "richText":
        return (
          <Textarea
            value={value || ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            disabled={isDisabled}
            rows={3}
            maxLength={field.maxLength}
          />
        );

      default:
        return (
          <Input
            value={value || ""}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            disabled={isDisabled}
          />
        );
    }
  };

  const displayValue = (field: LayoutField, value: any): string => {
    if (value === null || value === undefined || value === "") return "—";
    if (objectName === "Lead" && field.name === "status") return getLeadStatusLabel(String(value));
    if (field.fieldType === "boolean") return value ? "Yes" : "No";
    if (field.fieldType === "date" || field.fieldType === "dateTime") {
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? String(value)
        : date.toLocaleString(undefined, field.fieldType === "date"
          ? { year: "numeric", month: "2-digit", day: "2-digit" }
          : { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    }
    if (field.fieldType === "currency") {
      const amount = Number(value);
      return Number.isFinite(amount)
        ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount)
        : String(value);
    }
    if (field.fieldType === "picklist") {
      return field.picklistValues?.find((option) => option.value === value)?.label || String(value);
    }
    if (field.fieldType === "multiPicklist" && Array.isArray(value)) {
      return value
        .map((item) => field.picklistValues?.find((option) => option.value === item)?.label || String(item))
        .join(", ");
    }
    if (typeof value === "object") {
      const person = [value.firstName, value.lastName].filter(Boolean).join(" ").trim();
      return String(person || value.name || value.label || value.displayName || value.title || "—");
    }
    if (field.fieldType === "lookup") {
      const relation = data[field.name.replace(/Id$/, "")];
      if (relation && typeof relation === "object") {
        const person = [relation.firstName, relation.lastName].filter(Boolean).join(" ").trim();
        return String(person || relation.name || relation.title || relation.label || relation.recordNumber || "—");
      }
    }
    return String(value);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-4">
              {[1, 2].map((j) => (
                <div key={j} className="grid grid-cols-2 gap-4">
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (sections.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No layout configured for this object.
        </CardContent>
      </Card>
    );
  }

  const displayedSections = isEditingLayout ? layoutDraft : sections;
  const formContent = (
    <div className="space-y-6">
      {displayedSections.map((section, sectionIdx) => {
        const visibleFields = section.fields
          .map((fieldName) => getFieldDef(fieldName))
          .filter((f): f is LayoutField => !!f && f.visible !== false)
          .map((field) => ({
            ...field,
            required: section.required?.[field.name] || field.required,
            editable: section.readOnly?.[field.name] ? false : field.editable,
          }));

        if (visibleFields.length === 0) return null;

        return (
          <Card
            key={sectionIdx}
            className={objectName === "Lead" ? "rounded-md border-slate-200 shadow-sm" : undefined}
          >
            <CardHeader className={`pb-3 ${objectName === "Lead" ? "border-b border-sky-100 bg-[#f5faff] px-4 py-3" : ""}`}>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className={`font-medium ${objectName === "Lead" ? "text-[12px] text-slate-700" : "text-sm text-muted-foreground"}`}>
                  {section.name}
                </CardTitle>
                {objectName === "Lead" && canEditLayout && onSaveLayout && (
                  isEditingLayout ? (
                    <div className="flex items-center gap-1.5">
                      <Button type="button" size="sm" variant="outline" className="h-7 border-sky-200 px-2 text-[11px] text-[#1479a8]" onClick={() => setIsEditingLayout(false)} disabled={isSavingLayout}>
                        <X className="mr-1 h-3 w-3" />Cancel
                      </Button>
                      <Button type="button" size="sm" className="h-7 px-2 text-[11px]" onClick={() => void saveLayoutDraft()} disabled={isSavingLayout}>
                        <Save className="mr-1 h-3 w-3" />{isSavingLayout ? "Saving..." : "Save"}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 border-sky-200 px-2 text-[11px] text-[#1479a8]"
                      onClick={() => {
                        setLayoutDraft(sections.map((item) => ({ ...item, fields: [...item.fields] })));
                        setIsEditingLayout(true);
                      }}
                    >
                      <Pencil className="mr-1 h-3 w-3" />
                      Edit Layout
                    </Button>
                  )
                )}
              </div>
            </CardHeader>
            <CardContent className={objectName === "Lead" ? "crm-record-form px-4 py-2" : "crm-record-form"}>
              <Droppable droppableId={String(sectionIdx)} direction="vertical" isDropDisabled={!isEditingLayout}>
                {(dropProvided, snapshot) => (
                  <div
                    ref={dropProvided.innerRef}
                    {...dropProvided.droppableProps}
                    className={`${isEditingLayout ? "grid grid-cols-1 gap-x-8" : section.columns === 1 ? "crm-form-grid crm-form-grid-1" : "crm-form-grid"} ${snapshot.isDraggingOver ? "rounded-md bg-sky-50/70" : ""}`}
                  >
                    {visibleFields.map((field, fieldIdx) => {
                      const phoneFieldName = field.name === "phone" || field.name === "mobile" || field.name === "secondaryPhone"
                        ? field.name
                        : null;
                      const phoneCountryCode = field.name === "secondaryPhone"
                        ? data.secondaryCountryCode || data.countryCode
                        : data.countryCode;
                      const phoneValue = phoneFieldName ? data[field.name] : null;
                      const phoneIsValid = isValidTelephonyNumber(phoneValue, phoneCountryCode);
                      return (
                      <Draggable
                        key={field.name}
                        draggableId={`lead-layout-${field.name}`}
                        index={fieldIdx}
                        isDragDisabled={!isEditingLayout}
                      >
                        {(dragProvided, dragSnapshot) => (
                  <div
                    ref={dragProvided.innerRef}
                    {...dragProvided.draggableProps}
                    className={`${
                      field.fieldType === "longText" || field.fieldType === "richText"
                        ? "md:col-span-2"
                        : ""
                    } ${dragSnapshot.isDragging ? "z-10 rounded-md bg-white shadow-lg ring-2 ring-blue-200" : ""}`}
                  >
                    {mode === "detail" && editingFieldName !== field.name ? (
                      <div className={`flex min-h-10 items-start gap-2 border-b py-2 ${objectName === "Lead" ? "border-sky-100" : ""}`}>
                        {isEditingLayout && (
                          <button
                            type="button"
                            {...dragProvided.dragHandleProps}
                            aria-label={`Drag ${field.label} to move it`}
                            className="flex h-7 w-6 shrink-0 cursor-grab items-center justify-center rounded text-slate-400 hover:bg-sky-50 hover:text-blue-600 active:cursor-grabbing"
                          >
                            <GripVertical className="h-4 w-4" aria-hidden="true" />
                          </button>
                        )}
                        <Label className={`mt-1 w-1/3 shrink-0 font-medium text-muted-foreground ${objectName === "Lead" ? "text-[11px]" : "text-xs"}`}>
                          {field.label}
                        </Label>
                        <div className={`min-w-0 ${isEditingLayout ? "" : "flex-1"} flex-1 font-medium leading-5 [overflow-wrap:anywhere] ${objectName === "Lead" ? "text-[12px]" : "text-sm"}`}>
                          {field.fieldType === "email" && data[field.name] ? (
                            <a className="text-primary hover:underline" href={`mailto:${String(data[field.name])}`}>
                              {displayValue(field, data[field.name])}
                            </a>
                          ) : phoneFieldName && objectName === "Lead" && phoneValue ? (
                            onCallPhone && phoneIsValid ? (
                            <button
                              type="button"
                              className="text-left text-[#1479a8] hover:underline disabled:opacity-60"
                              disabled={Boolean(callingPhoneField)}
                              onClick={() => onCallPhone(phoneFieldName)}
                            >
                              {callingPhoneField === field.name ? "Calling..." : displayValue(field, data[field.name])}
                            </button>
                            ) : (
                              <span className="inline-flex items-center gap-1">
                                {displayValue(field, data[field.name])}
                                <TelephonyStatusHint
                                  reasonCode={getPhoneUnavailableReason?.(phoneFieldName, phoneValue) || "NOT_CONFIGURED"}
                                  isAdmin={isTelephonyAdmin}
                                  leadId={telephonyLeadId}
                                  tenantId={telephonyTenantId}
                                />
                              </span>
                            )
                          ) : (
                            displayValue(
                              field,
                              objectName === "Lead" && field.name === "id"
                                ? data.record_number
                                : data[field.name],
                            )
                          )}
                          {fieldErrors?.[field.name] && (
                            <p className={objectName === "Lead" ? "text-[11px] text-destructive" : "text-sm text-destructive"} data-testid={`error-${field.name}`}>
                              {fieldErrors[field.name]}
                            </p>
                          )}
                        </div>
                        {onBeginEdit && editingFieldName !== field.name && field.editable && !field.isSystemField && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={`mt-0.5 h-7 w-7 shrink-0 ${objectName === "Lead" ? "text-blue-500 hover:bg-sky-50 hover:text-blue-700" : "text-muted-foreground"}`}
                            aria-label={`Edit ${field.label}`}
                            onClick={() => onBeginEdit(field.name)}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        )}
                        {field.name === "owner" && onEditOwner && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={`mt-0.5 h-7 w-7 shrink-0 ${objectName === "Lead" ? "text-blue-500 hover:bg-sky-50 hover:text-blue-700" : "text-muted-foreground"}`}
                            aria-label="Edit Owner"
                            onClick={onEditOwner}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <Label className="text-sm">
                          {field.label}
                          {field.required && mode === "create" && (
                            <span className="ml-1 text-destructive">*</span>
                          )}
                        </Label>
                        {renderField(field, data[field.name])}
                        {fieldErrors?.[field.name] && (
                          <p className="text-sm text-destructive" data-testid={`error-${field.name}`}>
                            {fieldErrors[field.name]}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                        )}
                      </Draggable>
                      );
                    })}
                    {dropProvided.placeholder}
                  </div>
                )}
              </Droppable>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );

  return (
    <DragDropContext onDragEnd={handleLayoutDragEnd}>
      {formContent}
    </DragDropContext>
  );
}
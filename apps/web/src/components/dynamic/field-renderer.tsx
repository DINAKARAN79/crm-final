"use client";
  /* eslint-disable react-hooks/exhaustive-deps */

import * as React from "react";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate as formatTenantDate, formatDateTime as formatTenantDateTime } from "@/lib/date-format";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface FieldDefinition {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  description?: string;
  required?: boolean;
  unique?: boolean;
  defaultValue?: string;
  searchable?: boolean;
  sortable?: boolean;
  filterable?: boolean;
  visible?: boolean;
  editable?: boolean;
  isSystemField?: boolean;
  isCustomField?: boolean;
  displayOrder?: number;
  lookupObject?: string;
  lookupField?: string;
  picklistValues?: PicklistValue[];
  validationRules?: any;
}

export interface PicklistValue {
  id: string;
  label: string;
  value: string;
  isActive: boolean;
  isDefault: boolean;
  displayOrder: number;
}

interface FieldRendererProps {
  field: FieldDefinition;
  value: any;
  onChange: (value: any) => void;
  disabled?: boolean;
  readOnly?: boolean;
  error?: string;
  lookupSearchFn?: (query: string) => Promise<{ id: string; label: string }[]>;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  try {
    return formatTenantDate(dateStr);
  } catch {
    return dateStr;
  }
}

function formatDateTime(dateStr: string): string {
  if (!dateStr) return "";
  try {
    return formatTenantDateTime(dateStr);
  } catch {
    return dateStr;
  }
}

function LookupField({
  field,
  value,
  onChange,
  disabled,
  lookupSearchFn,
}: FieldRendererProps) {
  const [searchQuery, setSearchQuery] = React.useState("");
  const [options, setOptions] = React.useState<
    { id: string; label: string }[]
  >([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isOpen, setIsOpen] = React.useState(false);
  const [selectedLabel, setSelectedLabel] = React.useState("");

  React.useEffect(() => {
    if (!value) {
      setSelectedLabel("");
      return;
    }
    if (selectedLabel && String(value) === selectedLabel) return;
    if (lookupSearchFn) {
      lookupSearchFn(String(value)).then((results) => {
        const match = results.find((r) => r.id === String(value));
        if (match) setSelectedLabel(match.label);
        else setSelectedLabel(String(value));
      }).catch(() => setSelectedLabel(String(value)));
    } else {
      setSelectedLabel(String(value));
    }
  }, [value]);

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (!lookupSearchFn) return;
    setIsLoading(true);
    try {
      const results = await lookupSearchFn(query);
      setOptions(results);
    } catch {
      setOptions([]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <div className="flex items-center">
          <Button
            variant="outline"
            className="h-9 flex-1 justify-start rounded-r-none text-left font-normal"
            disabled={disabled}
          >
            {selectedLabel || `Search ${field.label}...`}
          </Button>
          {selectedLabel && !disabled && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0 rounded-l-none border-l-0"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
                setSelectedLabel("");
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <div className="border-b p-2">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              className="h-9 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              placeholder={`Search ${field.label}...`}
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="max-h-60 overflow-auto">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Searching...
            </div>
          ) : options.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              No results found
            </div>
          ) : (
            options.map((option) => (
              <button
                key={option.id}
                className="flex w-full items-center px-3 py-2 text-[13px] hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  onChange(option.id);
                  setSelectedLabel(option.label);
                  setIsOpen(false);
                }}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MultiPicklistField({
  field,
  value,
  onChange,
  disabled,
}: FieldRendererProps) {
  const selectedValues: string[] = Array.isArray(value) ? value : [];

  const toggleValue = (val: string) => {
    if (disabled) return;
    const newValues = selectedValues.includes(val)
      ? selectedValues.filter((v) => v !== val)
      : [...selectedValues, val];
    onChange(newValues);
  };

  const removeValue = (val: string) => {
    if (disabled) return;
    onChange(selectedValues.filter((v) => v !== val));
  };

  return (
    <div className="space-y-2">
      {selectedValues.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedValues.map((val) => {
            const pv = field.picklistValues?.find((p) => p.value === val);
            return (
              <Badge key={val} variant="secondary" className="gap-1">
                {pv?.label || val}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => removeValue(val)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </Badge>
            );
          })}
        </div>
      )}
      <Select
        value=""
        onValueChange={toggleValue}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder={`Select ${field.label}...`} />
        </SelectTrigger>
        <SelectContent>
          {field.picklistValues
            ?.filter((pv) => pv.isActive && !selectedValues.includes(pv.value))
            .map((pv) => (
              <SelectItem key={pv.id} value={pv.value}>
                {pv.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function FieldRenderer({
  field,
  value,
  onChange,
  disabled,
  readOnly,
  error,
  lookupSearchFn,
}: FieldRendererProps) {
  const isDisabled = disabled || readOnly || field.isSystemField;

  const renderField = () => {
    switch (field.fieldType) {
      case "text":
        return (
          <Input
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={isDisabled}
            placeholder={`Enter ${field.label.toLowerCase()}...`}
          />
        );

      case "longText":
        return (
          <Textarea
            value={value || ""}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
            disabled={isDisabled}
            placeholder={`Enter ${field.label.toLowerCase()}...`}
            rows={4}
          />
        );

      case "richText":
        return (
          <Textarea
            value={value || ""}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
            disabled={isDisabled}
            placeholder={`Enter ${field.label.toLowerCase()}...`}
            rows={6}
          />
        );

      case "integer":
        return (
          <Input
            type="number"
            step="1"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value ? parseInt(e.target.value, 10) : null)}
            disabled={isDisabled}
          />
        );

      case "number":
        return (
          <Input
            type="number"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
            disabled={isDisabled}
          />
        );

      case "currency":
        return (
          <CurrencyInput
            step="0.01"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
            disabled={isDisabled}
          />
        );

      case "decimal":
      case "percentage":
        return (
          <Input
            type="number"
            step="0.01"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
            disabled={isDisabled}
          />
        );

      case "autoNumber":
        return (
          <Input
            value={value || ""}
            disabled
            className="bg-muted"
          />
        );

      case "date":
        return (
          <Input
            type="date"
            value={value ? String(value).split("T")[0] : ""}
            onChange={(e) => onChange(e.target.value || null)}
            disabled={isDisabled}
          />
        );

      case "dateTime":
        return (
          <Input
            type="datetime-local"
            value={value ? new Date(value).toISOString().slice(0, 16) : ""}
            onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
            disabled={isDisabled}
          />
        );

      case "time":
        return (
          <Input
            type="time"
            value={value || ""}
            onChange={(e) => onChange(e.target.value || null)}
            disabled={isDisabled}
          />
        );

      case "boolean":
        return (
          <div className="flex items-center gap-2">
            <Switch
              checked={!!value}
              onCheckedChange={onChange}
              disabled={isDisabled}
            />
            <span className="text-sm text-muted-foreground">
              {value ? "Yes" : "No"}
            </span>
          </div>
        );

      case "email":
        return (
          <Input
            type="email"
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={isDisabled}
            placeholder="email@example.com"
          />
        );

      case "phone":
        return (
          <Input
            type="tel"
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={isDisabled}
            placeholder="+91 98765 43210"
          />
        );

      case "url":
        return (
          <Input
            type="url"
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={isDisabled}
            placeholder="https://example.com"
          />
        );

      case "picklist":
        return (
          <Select
            value={value || ""}
            onValueChange={(val) => onChange(val === "__none__" ? null : val)}
            disabled={isDisabled}
          >
            <SelectTrigger>
              <SelectValue placeholder={`Select ${field.label.toLowerCase()}...`} />
            </SelectTrigger>
            <SelectContent>
              {value && (
                <SelectItem value="__none__">
                  None
                </SelectItem>
              )}
              {field.picklistValues
                ?.filter((pv) => pv.isActive)
                .map((pv) => (
                  <SelectItem key={pv.id} value={pv.value}>
                    {pv.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        );

      case "multiPicklist":
        return (
          <MultiPicklistField
            field={field}
            value={value}
            onChange={onChange}
            disabled={isDisabled}
          />
        );

      case "lookup":
      case "relationship":
        return (
          <LookupField
            field={field}
            value={value}
            onChange={onChange}
            disabled={isDisabled}
            lookupSearchFn={lookupSearchFn}
          />
        );

      case "formula":
        return (
          <Input
            value={value || ""}
            disabled
            className="bg-muted"
          />
        );

      default:
        return (
          <Input
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={isDisabled}
          />
        );
    }
  };

  const formatDisplayValue = (val: any): string => {
    if (val === null || val === undefined) return "—";
    switch (field.fieldType) {
      case "currency":
        return formatCurrency(Number(val));
      case "percentage":
        return `${val}%`;
      case "boolean":
        return val ? "Yes" : "No";
      case "date":
        return formatDate(String(val));
      case "dateTime":
        return formatDateTime(String(val));
      case "picklist": {
        const pv = field.picklistValues?.find((p) => p.value === val);
        return pv?.label || String(val);
      }
      case "multiPicklist":
        if (Array.isArray(val)) {
          return val
            .map((v) => {
              const pv = field.picklistValues?.find((p) => p.value === v);
              return pv?.label || v;
            })
            .join(", ");
        }
        return String(val);
      default:
        return String(val);
    }
  };

  if (readOnly) {
    return (
      <div className="space-y-1">
        <Label className="text-xs font-medium text-muted-foreground">
          {field.label}
          {field.required && <span className="text-destructive ml-1">*</span>}
        </Label>
        <div className="py-2 text-[13px] font-medium">
          {formatDisplayValue(value)}
        </div>
        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={field.name} className="text-xs font-medium">
        {field.label}
        {field.required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {field.description && (
        <p className="text-[11px] text-muted-foreground">{field.description}</p>
      )}
      {renderField()}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

export function FieldDisplay({
  field,
  value,
}: {
  field: FieldDefinition;
  value: any;
}) {
  const formatDisplayValue = (val: any): string => {
    if (val === null || val === undefined) return "—";
    switch (field.fieldType) {
      case "currency":
        return formatCurrency(Number(val));
      case "percentage":
        return `${val}%`;
      case "boolean":
        return val ? "Yes" : "No";
      case "date":
        return formatDate(String(val));
      case "dateTime":
        return formatDateTime(String(val));
      case "picklist": {
        const pv = field.picklistValues?.find((p) => p.value === val);
        return pv?.label || String(val);
      }
      case "multiPicklist":
        if (Array.isArray(val)) {
          return val
            .map((v) => {
              const pv = field.picklistValues?.find((p) => p.value === v);
              return pv?.label || v;
            })
            .join(", ");
        }
        return String(val);
      default:
        return String(val);
    }
  };

  const renderBadge = () => {
    if (field.fieldType === "picklist") {
      const pv = field.picklistValues?.find((p) => p.value === value);
      const colorMap: Record<string, string> = {
        NEW: "bg-blue-100 text-blue-800",
        ACTIVE: "bg-green-100 text-green-800",
        INACTIVE: "bg-red-100 text-red-800",
        PENDING: "bg-yellow-100 text-yellow-800",
        COMPLETED: "bg-green-100 text-green-800",
        CANCELLED: "bg-red-100 text-red-800",
      };
      const colorClass = colorMap[value] || "bg-gray-100 text-gray-800";
      return <Badge className={colorClass}>{pv?.label || value}</Badge>;
    }
    return null;
  };

  const badge = renderBadge();

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-3">
      <Label className="text-xs font-medium text-muted-foreground">
        {field.label}
      </Label>
      <div className="min-w-0 break-words py-1 text-[13px] font-medium">
        {badge || formatDisplayValue(value)}
      </div>
    </div>
  );
}
"use client";
/* eslint-disable react-hooks/exhaustive-deps */

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import LayoutManager from "@/components/admin/layout-manager";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  Plus,
  Trash2,
  GripVertical,
  Settings,
  Shield,
  Layout,
  List,
  GitBranch,
  Zap,
  Search,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  Eye,
  EyeOff,
  Pencil,
  X,
  AlertCircle,
  Check,
} from "lucide-react";
import Link from "next/link";
import { objectManagerApi } from "@/lib/api";

const FIELD_TYPES = [
  { value: "text", label: "Text", category: "Text" },
  { value: "longText", label: "Long Text", category: "Text" },
  { value: "richText", label: "Rich Text", category: "Text" },
  { value: "integer", label: "Integer", category: "Number" },
  { value: "number", label: "Number", category: "Number" },
  { value: "decimal", label: "Decimal", category: "Number" },
  { value: "currency", label: "Currency", category: "Number" },
  { value: "percentage", label: "Percentage", category: "Number" },
  { value: "date", label: "Date", category: "Date/Time" },
  { value: "dateTime", label: "Date/Time", category: "Date/Time" },
  { value: "time", label: "Time", category: "Date/Time" },
  { value: "boolean", label: "Checkbox", category: "Other" },
  { value: "email", label: "Email", category: "Other" },
  { value: "phone", label: "Phone", category: "Other" },
  { value: "url", label: "URL", category: "Other" },
  { value: "picklist", label: "Picklist", category: "Choice" },
  { value: "multiPicklist", label: "Multi-Select Picklist", category: "Choice" },
  { value: "lookup", label: "Lookup", category: "Relationship" },
  { value: "relationship", label: "Relationship", category: "Relationship" },
];

const RESERVED_NAMES = ["id", "record_number", "created_by", "created_at", "updated_at", "is_active", "owner"];

const TYPE_ICONS: Record<string, string> = {
  text: "T", longText: "¶", richText: "R", integer: "#", number: "0.0",
  decimal: "0.00", currency: "$", percentage: "%", date: "📅",
  dateTime: "📅", time: "🕐", boolean: "☑", email: "@", phone: "📞",
  url: "🔗", picklist: "▼", multiPicklist: "≡", lookup: "↗", relationship: "↔",
};

interface FieldDef {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  description?: string;
  helpText?: string;
  required: boolean;
  unique: boolean;
  defaultValue?: string;
  searchable: boolean;
  sortable: boolean;
  filterable: boolean;
  visible: boolean;
  editable: boolean;
  isActive: boolean;
  isSystemField: boolean;
  isStandardField: boolean;
  isCustomField: boolean;
  displayOrder: number;
  minLength?: number;
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  precision?: number;
  scale?: number;
  lookupObject?: string;
  lookupField?: string;
  validationRules?: any;
  picklistValues?: any[];
}

interface FieldFormData {
  name: string;
  label: string;
  fieldType: string;
  description: string;
  helpText: string;
  required: boolean;
  unique: boolean;
  defaultValue: string;
  searchable: boolean;
  sortable: boolean;
  filterable: boolean;
  lookupObject: string;
  lookupField: string;
  minLength: string;
  maxLength: string;
  minValue: string;
  maxValue: string;
  precision: string;
  scale: string;
  picklistValues: { label: string; value: string; isActive: boolean; isDefault: boolean }[];
}

const EMPTY_FORM: FieldFormData = {
  name: "", label: "", fieldType: "text", description: "", helpText: "",
  required: false, unique: false, defaultValue: "",
  searchable: false, sortable: false, filterable: false,
  lookupObject: "", lookupField: "",
  minLength: "", maxLength: "", minValue: "", maxValue: "", precision: "", scale: "",
  picklistValues: [],
};

function generateApiName(label: string): string {
  return label
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
}

export default function ObjectSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const objectName = params.objectName as string;

  const [object, setObject] = React.useState<any>(null);
  const [fields, setFields] = React.useState<FieldDef[]>([]);
  const [roles, setRoles] = React.useState<any[]>([]);
  const [permissions, setPermissions] = React.useState<any[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [showInactive, setShowInactive] = React.useState(false);

  const [showCreateDialog, setShowCreateDialog] = React.useState(false);
  const [editField, setEditField] = React.useState<FieldDef | null>(null);
  const [deleteField, setDeleteField] = React.useState<FieldDef | null>(null);
  const [formData, setFormData] = React.useState<FieldFormData>({ ...EMPTY_FORM });
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = React.useState(false);

  const [dragIndex, setDragIndex] = React.useState<number | null>(null);

  React.useEffect(() => {
    loadData();
  }, [objectName]);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [objRes, fieldsRes, rolesRes, permsRes] = await Promise.all([
        objectManagerApi.getObject(objectName),
        objectManagerApi.listFields(objectName, { includeSystem: true, includeInactive: true }),
        import("@/lib/api").then((m) => m.roleApi.list()),
        objectManagerApi.getObjectPermissions(objectName),
      ]);
      setObject(objRes.data.data);
      setFields(fieldsRes.data.data || []);
      setRoles(rolesRes.data.data || []);
      setPermissions(permsRes.data.data || []);
    } catch (error) {
      console.error("Failed to load data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredFields = React.useMemo(() => {
    let result = fields;
    if (!showInactive) {
      result = result.filter((f) => f.isActive || f.isSystemField);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (f) =>
          f.label.toLowerCase().includes(q) ||
          f.name.toLowerCase().includes(q) ||
          f.fieldType.toLowerCase().includes(q)
      );
    }
    return result;
  }, [fields, searchQuery, showInactive]);

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!formData.label.trim()) errors.label = "Label is required";
    if (!formData.fieldType) errors.fieldType = "Field type is required";
    if (formData.name && RESERVED_NAMES.includes(formData.name.toLowerCase())) {
      errors.name = `"${formData.name}" is a reserved system name`;
    }
    if (formData.name && !/^[A-Za-z][A-Za-z0-9_]*$/.test(formData.name)) {
      errors.name = "Must start with a letter, contain only letters/numbers/underscores";
    }
    if (formData.name) {
      const existing = fields.find((f) => f.name === formData.name && (!editField || f.id !== editField.id));
      if (existing) errors.name = `A field named "${formData.name}" already exists`;
    }
    if ((formData.fieldType === "lookup" || formData.fieldType === "relationship") && !formData.lookupObject) {
      errors.lookupObject = "Related object is required";
    }
    if ((formData.fieldType === "picklist" || formData.fieldType === "multiPicklist") && formData.picklistValues.length === 0) {
      errors.picklistValues = "At least one picklist value is required";
    }
    if (["integer", "number", "decimal", "currency", "percentage"].includes(formData.fieldType)) {
      if (formData.minValue && formData.maxValue && Number(formData.minValue) > Number(formData.maxValue)) {
        errors.minValue = "Min value must be less than max value";
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleCreateField = async () => {
    if (!validateForm()) return;
    setIsSaving(true);
    try {
      const payload: any = {
        name: formData.name || generateApiName(formData.label),
        label: formData.label,
        fieldType: formData.fieldType,
        description: formData.description || undefined,
        helpText: formData.helpText || undefined,
        required: formData.required,
        unique: formData.unique,
        defaultValue: formData.defaultValue || undefined,
        searchable: formData.searchable,
        sortable: formData.sortable,
        filterable: formData.filterable,
        lookupObject: formData.lookupObject || undefined,
        lookupField: formData.lookupField || undefined,
        minLength: formData.minLength ? Number(formData.minLength) : undefined,
        maxLength: formData.maxLength ? Number(formData.maxLength) : undefined,
        minValue: formData.minValue ? Number(formData.minValue) : undefined,
        maxValue: formData.maxValue ? Number(formData.maxValue) : undefined,
        precision: formData.precision ? Number(formData.precision) : undefined,
        scale: formData.scale ? Number(formData.scale) : undefined,
        picklistValues: formData.picklistValues.length > 0 ? formData.picklistValues : undefined,
      };
      await objectManagerApi.createField(objectName, payload);
      setShowCreateDialog(false);
      setFormData({ ...EMPTY_FORM });
      loadData();
    } catch (error: any) {
      setFormErrors({ submit: error.response?.data?.error || "Failed to create field" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateField = async () => {
    if (!editField || !validateForm()) return;
    setIsSaving(true);
    try {
      const payload: any = {
        label: formData.label,
        description: formData.description || undefined,
        helpText: formData.helpText || undefined,
        required: formData.required,
        unique: formData.unique,
        defaultValue: formData.defaultValue || undefined,
        searchable: formData.searchable,
        sortable: formData.sortable,
        filterable: formData.filterable,
        lookupObject: formData.lookupObject || undefined,
        lookupField: formData.lookupField || undefined,
        minLength: formData.minLength ? Number(formData.minLength) : undefined,
        maxLength: formData.maxLength ? Number(formData.maxLength) : undefined,
        minValue: formData.minValue ? Number(formData.minValue) : undefined,
        maxValue: formData.maxValue ? Number(formData.maxValue) : undefined,
        precision: formData.precision ? Number(formData.precision) : undefined,
        scale: formData.scale ? Number(formData.scale) : undefined,
        picklistValues: formData.picklistValues.length > 0 ? formData.picklistValues : undefined,
      };
      await objectManagerApi.updateField(objectName, editField.id, payload);
      setEditField(null);
      setFormData({ ...EMPTY_FORM });
      loadData();
    } catch (error: any) {
      setFormErrors({ submit: error.response?.data?.error || "Failed to update field" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleField = async (field: FieldDef) => {
    try {
      await objectManagerApi.toggleField(objectName, field.id);
      loadData();
    } catch (error: any) {
      alert(error.response?.data?.error || "Failed to toggle field");
    }
  };

  const handleDeleteField = async () => {
    if (!deleteField) return;
    try {
      await objectManagerApi.deleteField(objectName, deleteField.id);
      setDeleteField(null);
      loadData();
    } catch (error: any) {
      alert(error.response?.data?.error || "Failed to delete field");
    }
  };

  const handleReorder = async (fieldId: string, direction: "up" | "down") => {
    const activeFields = fields.filter((f) => !f.isSystemField).sort((a, b) => a.displayOrder - b.displayOrder);
    const idx = activeFields.findIndex((f) => f.id === fieldId);
    if (idx === -1) return;
    if (direction === "up" && idx === 0) return;
    if (direction === "down" && idx === activeFields.length - 1) return;

    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    const fieldOrders = activeFields.map((f, i) => {
      if (i === idx) return { id: f.id, displayOrder: activeFields[swapIdx].displayOrder };
      if (i === swapIdx) return { id: f.id, displayOrder: activeFields[idx].displayOrder };
      return { id: f.id, displayOrder: f.displayOrder };
    });

    try {
      await objectManagerApi.reorderFields(objectName, fieldOrders);
      loadData();
    } catch (error: any) {
      alert(error.response?.data?.error || "Failed to reorder fields");
    }
  };

  const openCreateDialog = () => {
    setFormData({ ...EMPTY_FORM });
    setFormErrors({});
    setShowCreateDialog(true);
  };

  const openEditDialog = (field: FieldDef) => {
    setFormData({
      name: field.name,
      label: field.label,
      fieldType: field.fieldType,
      description: field.description || "",
      helpText: field.helpText || "",
      required: field.required,
      unique: field.unique,
      defaultValue: field.defaultValue || "",
      searchable: field.searchable,
      sortable: field.sortable,
      filterable: field.filterable,
      lookupObject: field.lookupObject || "",
      lookupField: field.lookupField || "",
      minLength: field.minLength?.toString() || "",
      maxLength: field.maxLength?.toString() || "",
      minValue: field.minValue?.toString() || "",
      maxValue: field.maxValue?.toString() || "",
      precision: field.precision?.toString() || "",
      scale: field.scale?.toString() || "",
      picklistValues: field.picklistValues?.map((pv: any) => ({
        label: pv.label,
        value: pv.value,
        isActive: pv.isActive,
        isDefault: pv.isDefault,
      })) || [],
    });
    setFormErrors({});
    setEditField(field);
  };

  const addPicklistValue = () => {
    setFormData((prev) => ({
      ...prev,
      picklistValues: [
        ...prev.picklistValues,
        { label: "", value: "", isActive: true, isDefault: false },
      ],
    }));
  };

  const updatePicklistValue = (index: number, updates: Partial<typeof formData.picklistValues[0]>) => {
    setFormData((prev) => ({
      ...prev,
      picklistValues: prev.picklistValues.map((pv, i) =>
        i === index ? { ...pv, ...updates, value: updates.value || pv.value || pv.label.toUpperCase().replace(/[^A-Z0-9]+/g, "_") } : pv
      ),
    }));
  };

  const removePicklistValue = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      picklistValues: prev.picklistValues.filter((_, i) => i !== index),
    }));
  };

  const needsTypeSpecificSettings = (fieldType: string) => {
    return ["integer", "number", "decimal", "currency", "percentage", "text", "longText", "picklist", "multiPicklist", "lookup", "relationship"].includes(fieldType);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10" />
          <Skeleton className="h-8 w-48" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!object) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Object not found</p>
        <Button variant="link" asChild className="mt-4">
          <Link href="/admin/object-manager">Back to Object Manager</Link>
        </Button>
      </div>
    );
  }

  const showPicklistEditor = formData.fieldType === "picklist" || formData.fieldType === "multiPicklist";
  const showLookupSettings = formData.fieldType === "lookup" || formData.fieldType === "relationship";
  const showNumericSettings = ["integer", "number", "decimal", "currency", "percentage"].includes(formData.fieldType);
  const showTextSettings = ["text", "longText"].includes(formData.fieldType);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/admin/object-manager">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{object.label} Settings</h1>
            <p className="text-muted-foreground">
              Configure fields, layouts, and permissions for {object.pluralLabel}
            </p>
          </div>
        </div>
        <Badge variant={object.objectType === "standard" ? "secondary" : "default"}>
          {object.objectType}
        </Badge>
      </div>

      <Tabs defaultValue="fields" className="space-y-4">
        <TabsList>
          <TabsTrigger value="fields" className="gap-2">
            <Settings className="h-4 w-4" />
            Fields ({fields.length})
          </TabsTrigger>
          <TabsTrigger value="permissions" className="gap-2">
            <Shield className="h-4 w-4" />
            Permissions
          </TabsTrigger>
          <TabsTrigger value="layouts" className="gap-2">
            <Layout className="h-4 w-4" />
            Layouts
          </TabsTrigger>
          <TabsTrigger value="listViews" className="gap-2">
            <List className="h-4 w-4" />
            List Views
          </TabsTrigger>
          <TabsTrigger value="related" className="gap-2">
            <GitBranch className="h-4 w-4" />
            Related
          </TabsTrigger>
          <TabsTrigger value="automation" className="gap-2">
            <Zap className="h-4 w-4" />
            Automation
          </TabsTrigger>
        </TabsList>

        <TabsContent value="fields" className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search fields..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 w-72"
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="showInactive"
                  checked={showInactive}
                  onCheckedChange={setShowInactive}
                />
                <Label htmlFor="showInactive" className="text-sm cursor-pointer">
                  Show inactive
                </Label>
              </div>
            </div>
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              New Field
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Field Label</TableHead>
                    <TableHead>API Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-center">Required</TableHead>
                    <TableHead className="text-center">Searchable</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredFields.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        {searchQuery ? "No fields match your search" : "No fields configured"}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredFields.map((field, idx) => {
                      const sortIdx = fields.filter((f) => !f.isSystemField).sort((a, b) => a.displayOrder - b.displayOrder).findIndex((f) => f.id === field.id);
                      const totalCustom = fields.filter((f) => !f.isSystemField).length;
                      return (
                        <TableRow key={field.id} className={!field.isActive ? "opacity-50" : ""}>
                          <TableCell>
                            {!field.isSystemField && (
                              <div className="flex flex-col">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 w-5 p-0"
                                  onClick={() => handleReorder(field.id, "up")}
                                  disabled={sortIdx <= 0}
                                >
                                  <ChevronUp className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 w-5 p-0"
                                  onClick={() => handleReorder(field.id, "down")}
                                  disabled={sortIdx >= totalCustom - 1}
                                >
                                  <ChevronDown className="h-3 w-3" />
                                </Button>
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs text-muted-foreground w-6 text-center">
                                {TYPE_ICONS[field.fieldType] || "?"}
                              </span>
                              <div>
                                <div className="font-medium">{field.label}</div>
                                {field.description && (
                                  <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                                    {field.description}
                                  </div>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-sm text-muted-foreground">
                            {field.name}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {FIELD_TYPES.find((t) => t.value === field.fieldType)?.label || field.fieldType}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-center">
                            {field.required ? (
                              <Check className="h-4 w-4 text-green-600 mx-auto" />
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            {field.searchable ? (
                              <Check className="h-4 w-4 text-green-600 mx-auto" />
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            {field.isSystemField ? (
                              <Badge variant="secondary" className="text-xs">System</Badge>
                            ) : field.isStandardField ? (
                              <Badge variant="default" className="text-xs bg-blue-600">Standard</Badge>
                            ) : field.isCustomField ? (
                              <Badge variant="default" className="text-xs bg-green-600">Custom</Badge>
                            ) : field.isActive ? (
                              <Badge variant="default" className="text-xs bg-green-600">Active</Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs">Inactive</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {!field.isSystemField && (!field.isStandardField || (objectName.toLowerCase() === "lead" && field.name === "leadInterest")) && (
                              <div className="flex justify-end gap-1">
                                <Button variant="ghost" size="sm" onClick={() => openEditDialog(field)}>
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                {!field.isStandardField && (
                                  <>
                                    <Button variant="ghost" size="sm" onClick={() => handleToggleField(field)}>
                                      {field.isActive ? (
                                        <EyeOff className="h-4 w-4 text-orange-500" />
                                      ) : (
                                        <Eye className="h-4 w-4 text-green-500" />
                                      )}
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => setDeleteField(field)}>
                                      <Trash2 className="h-4 w-4 text-destructive" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="permissions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Role-Based Object Permissions</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Role</TableHead>
                    <TableHead className="text-center">Create</TableHead>
                    <TableHead className="text-center">Read</TableHead>
                    <TableHead className="text-center">Update</TableHead>
                    <TableHead className="text-center">Delete</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roles.map((role) => {
                    const perm = permissions.find((p) => p.roleId === role.id);
                    return (
                      <TableRow key={role.id}>
                        <TableCell className="font-medium">{role.name}</TableCell>
                        {["canCreate", "canRead", "canUpdate", "canDelete"].map((permKey) => (
                          <TableCell key={permKey} className="text-center">
                            <Switch
                              checked={(perm as any)?.[permKey] || false}
                              onCheckedChange={(v: boolean) => {
                                const existing = permissions.find((p) => p.roleId === role.id);
                                const data = existing
                                  ? { roleId: role.id, ...existing, [permKey]: v }
                                  : { roleId: role.id, canCreate: permKey === "canCreate" ? v : false, canRead: permKey === "canRead" ? v : true, canUpdate: permKey === "canUpdate" ? v : false, canDelete: permKey === "canDelete" ? v : false };
                                objectManagerApi.setObjectPermissions(objectName, data).then(() => loadData());
                              }}
                            />
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="layouts" className="space-y-4">
          <LayoutManager objectName={objectName} fields={fields} />
        </TabsContent>

        <TabsContent value="listViews" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>List Views</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Configure which fields appear in list views, default sorting, and filters.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="related" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Related Objects</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Manage relationships between this object and other CRM objects.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="automation" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Automation Rules</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Set up automated workflows, field updates, and notifications.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* CREATE/EDIT FIELD DIALOG */}
      <Dialog
        open={showCreateDialog || !!editField}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreateDialog(false);
            setEditField(null);
            setFormErrors({});
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editField ? `Edit ${editField.label}` : "Create New Field"}</DialogTitle>
          </DialogHeader>

          <form onSubmit={(e) => { e.preventDefault(); editField ? handleUpdateField() : handleCreateField(); }}>
          {formErrors.submit && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-md">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {formErrors.submit}
            </div>
          )}

          <div className="space-y-6">
            {/* Basic Settings */}
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Basic Settings</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>
                    Field Label <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    value={formData.label}
                    onChange={(e) => {
                      const label = e.target.value;
                      setFormData((prev) => ({
                        ...prev,
                        label,
                        name: prev.name || generateApiName(label),
                      }));
                    }}
                    placeholder="e.g., Property Name"
                    className={formErrors.label ? "border-destructive" : ""}
                  />
                  {formErrors.label && <p className="text-xs text-destructive">{formErrors.label}</p>}
                </div>
                <div className="space-y-2">
                  <Label>API Name</Label>
                  <Input
                    value={formData.name}
                    onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="Auto-generated from label"
                    disabled={!!editField}
                    className={formErrors.name ? "border-destructive" : ""}
                  />
                  {formErrors.name && <p className="text-xs text-destructive">{formErrors.name}</p>}
                </div>
              </div>

              <div className="space-y-2">
                <Label>
                  Field Type <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.fieldType}
                  onValueChange={(v) => setFormData((prev) => ({ ...prev, fieldType: v }))}
                  disabled={!!editField}
                >
                  <SelectTrigger className={formErrors.fieldType ? "border-destructive" : ""}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(
                      FIELD_TYPES.reduce((acc, ft) => {
                        if (!acc[ft.category]) acc[ft.category] = [];
                        acc[ft.category].push(ft);
                        return acc;
                      }, {} as Record<string, typeof FIELD_TYPES[0][]>)
                    ).map(([category, types]) => (
                      <React.Fragment key={category}>
                        <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">{category}</div>
                        {types.map((ft) => (
                          <SelectItem key={ft.value} value={ft.value}>
                            <span className="flex items-center gap-2">
                              <span className="font-mono text-xs w-5 text-center">{TYPE_ICONS[ft.value]}</span>
                              {ft.label}
                            </span>
                          </SelectItem>
                        ))}
                      </React.Fragment>
                    ))}
                  </SelectContent>
                </Select>
                {formErrors.fieldType && <p className="text-xs text-destructive">{formErrors.fieldType}</p>}
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Optional description for documentation"
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label>Help Text</Label>
                <Input
                  value={formData.helpText}
                  onChange={(e) => setFormData((prev) => ({ ...prev, helpText: e.target.value }))}
                  placeholder="Shown below the field to guide users"
                />
              </div>
            </div>

            <Separator />

            {/* Field Behavior */}
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Field Behavior</h4>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="flex items-center justify-between">
                  <Label>Required</Label>
                  <Switch
                    checked={formData.required}
                    onCheckedChange={(v: boolean) => setFormData((prev) => ({ ...prev, required: v }))}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label>Unique</Label>
                  <Switch
                    checked={formData.unique}
                    onCheckedChange={(v: boolean) => setFormData((prev) => ({ ...prev, unique: v }))}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label>Searchable</Label>
                  <Switch
                    checked={formData.searchable}
                    onCheckedChange={(v: boolean) => setFormData((prev) => ({ ...prev, searchable: v }))}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label>Filterable</Label>
                  <Switch
                    checked={formData.filterable}
                    onCheckedChange={(v: boolean) => setFormData((prev) => ({ ...prev, filterable: v }))}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label>Sortable</Label>
                  <Switch
                    checked={formData.sortable}
                    onCheckedChange={(v: boolean) => setFormData((prev) => ({ ...prev, sortable: v }))}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label>Default Value</Label>
                  <Input
                    value={formData.defaultValue}
                    onChange={(e) => setFormData((prev) => ({ ...prev, defaultValue: e.target.value }))}
                    placeholder="Optional"
                    className="h-8"
                  />
                </div>
              </div>
            </div>

            {/* Type-Specific Settings */}
            {needsTypeSpecificSettings(formData.fieldType) && (
              <>
                <Separator />
                <div className="space-y-4">
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Type Settings</h4>

                  {showTextSettings && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Min Length</Label>
                        <Input
                          type="number"
                          value={formData.minLength}
                          onChange={(e) => setFormData((prev) => ({ ...prev, minLength: e.target.value }))}
                          placeholder="No minimum"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Max Length</Label>
                        <Input
                          type="number"
                          value={formData.maxLength}
                          onChange={(e) => setFormData((prev) => ({ ...prev, maxLength: e.target.value }))}
                          placeholder="No maximum"
                        />
                      </div>
                    </div>
                  )}

                  {showNumericSettings && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Min Value</Label>
                        <Input
                          type="number"
                          value={formData.minValue}
                          onChange={(e) => setFormData((prev) => ({ ...prev, minValue: e.target.value }))}
                          placeholder="No minimum"
                          className={formErrors.minValue ? "border-destructive" : ""}
                        />
                        {formErrors.minValue && <p className="text-xs text-destructive">{formErrors.minValue}</p>}
                      </div>
                      <div className="space-y-2">
                        <Label>Max Value</Label>
                        <Input
                          type="number"
                          value={formData.maxValue}
                          onChange={(e) => setFormData((prev) => ({ ...prev, maxValue: e.target.value }))}
                          placeholder="No maximum"
                        />
                      </div>
                      {(formData.fieldType === "decimal" || formData.fieldType === "currency") && (
                        <>
                          <div className="space-y-2">
                            <Label>Decimal Precision</Label>
                            <Input
                              type="number"
                              value={formData.precision}
                              onChange={(e) => setFormData((prev) => ({ ...prev, precision: e.target.value }))}
                              placeholder="e.g., 10"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Decimal Scale</Label>
                            <Input
                              type="number"
                              value={formData.scale}
                              onChange={(e) => setFormData((prev) => ({ ...prev, scale: e.target.value }))}
                              placeholder="e.g., 2"
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {showLookupSettings && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Related Object <span className="text-destructive">*</span></Label>
                        <Select
                          value={formData.lookupObject}
                          onValueChange={(v) => setFormData((prev) => ({ ...prev, lookupObject: v }))}
                        >
                          <SelectTrigger className={formErrors.lookupObject ? "border-destructive" : ""}>
                            <SelectValue placeholder="Select object..." />
                          </SelectTrigger>
                          <SelectContent>
                            {["Lead", "Project", "Unit", "Opportunity", "SiteVisit", "Booking", "Payment", "Task", "Quotation"].map((obj) => (
                              <SelectItem key={obj} value={obj}>{obj}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {formErrors.lookupObject && <p className="text-xs text-destructive">{formErrors.lookupObject}</p>}
                      </div>
                      <div className="space-y-2">
                        <Label>Display Field</Label>
                        <Input
                          value={formData.lookupField}
                          onChange={(e) => setFormData((prev) => ({ ...prev, lookupField: e.target.value }))}
                          placeholder="e.g., name"
                        />
                      </div>
                    </div>
                  )}

                  {showPicklistEditor && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>Picklist Values</Label>
                        <Button type="button" variant="outline" size="sm" onClick={addPicklistValue}>
                          <Plus className="h-3 w-3 mr-1" />
                          Add Value
                        </Button>
                      </div>
                      {formErrors.picklistValues && (
                        <p className="text-xs text-destructive">{formErrors.picklistValues}</p>
                      )}
                      {formData.picklistValues.length === 0 ? (
                        <div className="text-center py-4 text-sm text-muted-foreground border rounded-md">
                          No picklist values. Click &quot;Add Value&quot; to create one.
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {formData.picklistValues.map((pv, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <Input
                                value={pv.label}
                                onChange={(e) => {
                                  const label = e.target.value;
                                  updatePicklistValue(idx, {
                                    label,
                                    value: pv.value || label.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
                                  });
                                }}
                                placeholder="Label"
                                className="flex-1"
                              />
                              <Input
                                value={pv.value}
                                onChange={(e) => updatePicklistValue(idx, { value: e.target.value })}
                                placeholder="Value"
                                className="w-32 font-mono text-sm"
                              />
                              <Switch
                                checked={pv.isActive}
                                onCheckedChange={(v: boolean) => updatePicklistValue(idx, { isActive: v })}
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => removePicklistValue(idx)}
                              >
                                <X className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowCreateDialog(false);
                setEditField(null);
                setFormErrors({});
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Saving..." : editField ? "Save Changes" : "Create Field"}
            </Button>
          </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* DELETE CONFIRMATION */}
      <AlertDialog open={!!deleteField} onOpenChange={() => setDeleteField(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Field?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the <strong>{deleteField?.label}</strong> field.
              {deleteField?.isSystemField && " System fields cannot be deleted."}
              {deleteField?.isStandardField && " Standard fields cannot be deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteField}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteField?.isSystemField}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
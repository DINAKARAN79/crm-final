"use client";

import { formatDate, formatDateTime } from "@/lib/date-format";

import * as React from "react";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useRecordView } from "@/components/crm/list-view-control";

import Link from "next/link";

import { cn } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";

import { Button } from "@/components/ui/button";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { Separator } from "@/components/ui/separator";

import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Label } from "@/components/ui/label";

import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import { RecordPageHeader } from "@/components/crm/record-page-header";
import { RecordSummary } from "@/components/crm/record-summary";

import { projectApi, unitApi } from "@/lib/api";
import { projectLocationLabel } from "@/lib/project-location";
import { ProjectLocationFields } from "@/components/projects/project-location-fields";
import { ProjectMap } from "@/components/projects/project-map";
import { SampleLandLayout } from "@/components/projects/sample-land-layout";
import { notifyUnitInventoryUpdated, subscribeToUnitInventoryUpdates } from "@/lib/unit-inventory-events";
import { createIllustrativeProjectPlots, projectUnitStatusColors, projectUnitStatuses } from "@/lib/project-land-layout";
import {
  APARTMENT_BLOCKS,
  UNIT_PROPERTY_TYPES,
  apartmentFloorsForBlock,
  formatApartmentFloor,
  isUnitPropertyType,
  unitUsesBlockAndFloor,
} from "@dct-crm/shared";

import {
  ArrowLeft,
  Edit,
  Building2,
  MapPin,
  Calendar,
  TrendingUp,
  Home,
  Store,
  Loader2,
  Plus,
} from "lucide-react";

interface ProjectData {
  id: string;
  name: string;
  location: string;
  address: string;
  city: string;
  state: string;
  description: string;
  type: "residential" | "commercial" | "mixed";
  totalUnits: number;
  soldUnits: number;
  availableUnits: number;
  status: "planning" | "under-construction" | "completed";
  completionPercentage: number;
  startDate: string;
  expectedCompletion: string;
  latitude: number | null;
  longitude: number | null;
  allowedRadiusMeters: number;
  projectType: string | null;
}

interface Unit {
  id: string;
  unitNumber: string;
  type: string;
  block: string | null;
  floor: number | null;
  area: number | null;
  price: number;
  status: "available" | "booked" | "sold" | "reserved" | "registered" | "hold" | "blocked";
  leadName?: string;
}

function mapProject(item: any): ProjectData {
  const statusMap: Record<string, ProjectData["status"]> = {
    PLANNING: "planning",
    PLANNED: "planning",
    "UNDER_CONSTRUCTION": "under-construction",
    "UNDER-CONSTRUCTION": "under-construction",
    ONGOING: "under-construction",
    COMPLETED: "completed",
    ACTIVE: "under-construction",
  };
  const units = item.units || [];
  const sold = units.filter((u: any) => u.status === "SOLD" || u.status === "sold").length;
  const available = units.filter((u: any) => u.status === "AVAILABLE" || u.status === "available" || !u.status).length;
  const total = item.totalUnits || units.length || 0;
  return {
    id: item.id,
    name: item.name || "Project",
    location: projectLocationLabel(item),
    address: item.address || "",
    city: item.city || "",
    state: item.state || "",
    description: item.description || "",
    type: "residential",
    totalUnits: total,
    soldUnits: sold,
    availableUnits: available,
    status: statusMap[(item.status || "").toUpperCase()] || "planning",
    completionPercentage: total > 0 ? Math.round((sold / total) * 100) : 0,
    startDate: item.startDate || item.createdAt,
    expectedCompletion: item.expectedCompletion || item.endDate || item.createdAt,
    latitude: item.latitude ?? null,
    longitude: item.longitude ?? null,
    allowedRadiusMeters: item.allowedRadiusMeters ?? 100,
    projectType: item.projectType || null,
  };
}

function mapUnit(item: any): Unit {
  const status = (item.status || "available").toLowerCase();
  return {
    id: item.id,
    unitNumber: item.number || item.unitNumber || item.id.slice(-4),
    type: item.type || "—",
    block: typeof item.block === "string" && item.block.trim() ? item.block : null,
    floor: typeof item.floor === "number" ? item.floor : null,
    area: typeof item.area === "number" ? item.area : null,
    price: item.price ?? 0,
    status: (["available", "booked", "sold", "reserved", "registered", "hold", "blocked"].includes(status) ? status : "available") as Unit["status"],
    leadName: item.lead
      ? `${item.lead.firstName} ${item.lead.lastName}`.trim()
      : undefined,
  };
}

const statusColors: Record<string, string> = {
  available: "bg-green-100 text-green-800 border-green-300",
  booked: "bg-yellow-100 text-yellow-800 border-yellow-300",
  sold: "bg-blue-100 text-blue-800 border-blue-300",
  reserved: "bg-purple-100 text-purple-800 border-purple-300",
  registered: "bg-red-100 text-red-800 border-red-300",
  hold: "bg-gray-100 text-gray-700 border-gray-300",
  blocked: "bg-gray-200 text-gray-700 border-gray-400",
};

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
};

export default function ProjectDetailPage() {
  const params = useParams();
  useRecordView("PROJECT", typeof params.id === "string" ? params.id : "");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [project, setProject] = React.useState<ProjectData | null>(null);
  const [units, setUnits] = React.useState<Unit[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [selectedFloor, setSelectedFloor] = React.useState<number | null>(null);
  const [locationDialogOpen, setLocationDialogOpen] = React.useState(false);
  const [latitudeInput, setLatitudeInput] = React.useState("");
  const [longitudeInput, setLongitudeInput] = React.useState("");
  const [radiusInput, setRadiusInput] = React.useState("100");
  const [projectNameInput, setProjectNameInput] = React.useState("");
  const [addressInput, setAddressInput] = React.useState("");
  const [cityInput, setCityInput] = React.useState("");
  const [stateInput, setStateInput] = React.useState("");
  const [isSavingLocation, setIsSavingLocation] = React.useState(false);
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const [isCreatingUnit, setIsCreatingUnit] = React.useState(false);
  const [unitNumberInput, setUnitNumberInput] = React.useState("");
  const [unitTypeInput, setUnitTypeInput] = React.useState("");
  const [unitBlockInput, setUnitBlockInput] = React.useState("");
  const [unitPriceInput, setUnitPriceInput] = React.useState("");
  const [unitFloorInput, setUnitFloorInput] = React.useState("");
  const [unitAreaInput, setUnitAreaInput] = React.useState("");
  const [unitStatusInput, setUnitStatusInput] = React.useState("AVAILABLE");
  const { hasPermission, hasEffectivePermission, hasFullAccess, isSuperAdmin } = useAuth();
  const canCreateUnit = hasFullAccess || isSuperAdmin || hasPermission("Unit", "create") || hasEffectivePermission("UNIT_CREATE");

  const fetchProject = React.useCallback(async () => {
    try {
      const res = await projectApi.get(params.id as string);
      if (res.data.success && res.data.data) {
        const raw = res.data.data;
        setProject(mapProject(raw));
        const mappedUnits = (raw.units || []).map(mapUnit);
        if (raw.name?.trim().toLowerCase() === "dct valley") {
          try {
            const firstPage = await unitApi.list({
              projectId: params.id,
              page: 1,
              limit: 200,
              sortBy: "number",
              sortOrder: "asc",
            });
            if (!firstPage.data.success || !firstPage.data.data) {
              throw new Error("The unit inventory response was unsuccessful.");
            }

            const allUnits = [...firstPage.data.data];
            const totalPages = firstPage.data.pagination?.totalPages ?? 1;
            for (let page = 2; page <= totalPages; page += 1) {
              const nextPage = await unitApi.list({
                projectId: params.id,
                page,
                limit: 200,
                sortBy: "number",
                sortOrder: "asc",
              });
              if (!nextPage.data.success || !nextPage.data.data) {
                throw new Error(`The unit inventory page ${page} was unsuccessful.`);
              }
              allUnits.push(...nextPage.data.data);
            }
            setUnits(allUnits.map(mapUnit));
          } catch (error) {
            setUnits(mappedUnits);
            toast({
              title: "Could not refresh DCT Valley unit details",
              description: error instanceof Error ? error.message : "Showing the project’s available unit data.",
              variant: "destructive" as any,
            });
          }
        } else {
          setUnits(mappedUnits);
          if (mappedUnits.length === 0) {
            try {
              const unitRes = await unitApi.list({ projectId: params.id, limit: 200 });
              if (unitRes.data.success && unitRes.data.data) {
                setUnits(unitRes.data.data.map(mapUnit));
              }
            } catch {
              // Unit list is optional when other project records have no units relation populated.
            }
          }
        }
      } else {
        toast({ title: "Error", description: "Project not found", variant: "destructive" as any });
        router.push("/projects");
      }
    } catch {
      toast({ title: "Error", description: "Failed to load project", variant: "destructive" as any });
    } finally {
      setIsLoading(false);
    }
  }, [params.id, router, toast]);

  React.useEffect(() => {
    void fetchProject();
  }, [fetchProject]);

  React.useEffect(
    () => subscribeToUnitInventoryUpdates(() => void fetchProject()),
    [fetchProject],
  );

  React.useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void fetchProject();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [fetchProject]);

  const floors = Array.from(new Set(units.flatMap((unit) => (unit.floor == null ? [] : [unit.floor])))).sort((a, b) => a - b);

  const filteredUnits = selectedFloor
    ? units.filter((u) => u.floor === selectedFloor)
    : units;

  const availableCount = units.filter((u) => u.status === "available").length;
  const bookedCount = units.filter((u) => u.status === "booked").length;
  const soldCount = units.filter((u) => u.status === "sold").length;
  const showDctValleyLayout = project?.name.trim().toLowerCase() === "dct valley";
  const dctValleyLayoutPlots = React.useMemo(
    () => showDctValleyLayout && project
      ? createIllustrativeProjectPlots(project.id, units.map((unit) => ({ ...unit, area: unit.area ?? 0 })))
      : [],
    [showDctValleyLayout, project, units],
  );
  const openLocationEditor = () => {
    if (!project) return;
    setProjectNameInput(project.name);
    setAddressInput(project.address);
    setCityInput(project.city);
    setStateInput(project.state);
    setLatitudeInput(project.latitude?.toString() || "");
    setLongitudeInput(project.longitude?.toString() || "");
    setRadiusInput(String(project.allowedRadiusMeters));
    setLocationDialogOpen(true);
  };

  React.useEffect(() => {
    if (project && searchParams.get("editLocation") === "1") {
      openLocationEditor();
      router.replace(`/projects/${project.id}`);
    }
  }, [project, searchParams, router]);

  const saveLocation = async () => {
    if (!project) return;
    const latitude = Number(latitudeInput);
    const longitude = Number(longitudeInput);
    const allowedRadiusMeters = Number(radiusInput);
    if (!projectNameInput.trim() || !addressInput.trim() ||
        !latitudeInput.trim() || !longitudeInput.trim() ||
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        !Number.isInteger(allowedRadiusMeters) || allowedRadiusMeters < 1 || allowedRadiusMeters > 5000) {
      toast({ title: "Invalid project location", description: "Enter the project name, location, valid latitude and longitude, and an allowed radius between 1 and 5000 meters.", variant: "destructive" as any });
      return;
    }

    try {
      setIsSavingLocation(true);
      const response = await projectApi.update(project.id, {
        name: projectNameInput.trim(),
        address: addressInput.trim(),
        city: cityInput.trim() || undefined,
        state: stateInput.trim() || undefined,
        latitude,
        longitude,
        allowedRadiusMeters,
      });
      if (response.data?.data) setProject(mapProject(response.data.data));
      setLocationDialogOpen(false);
      toast({
        title: "Project location updated",
        description: response.data?.warning || "Project details and coordinates are saved and will be used for site-visit verification.",
        variant: response.data?.warning ? "destructive" as any : undefined,
      });
    } catch (error: any) {
      toast({ title: "Unable to update project location", description: error?.response?.data?.error || "Try again.", variant: "destructive" as any });
    } finally {
      setIsSavingLocation(false);
    }
  };

  const openCreateUnit = () => {
    setUnitNumberInput("");
    setUnitTypeInput("");
    setUnitBlockInput("");
    setUnitPriceInput("");
    setUnitFloorInput("");
    setUnitAreaInput("");
    setUnitStatusInput("AVAILABLE");
    setCreateDialogOpen(true);
  };

  const createUnit = async () => {
    if (!project) return;
    const number = unitNumberInput.trim();
    const type = unitTypeInput.trim();
    const price = Number(unitPriceInput.replace(/,/g, ""));
    const located = unitUsesBlockAndFloor(type, project.projectType);
    if (!isUnitPropertyType(type)) {
      toast({ title: "Type is required", description: "Choose Apartment, Plot, or Villa.", variant: "destructive" as any });
      return;
    }
    if (!number || number.length > 50) {
      toast({ title: "Unit number is required", description: "Enter a unit number up to 50 characters.", variant: "destructive" as any });
      return;
    }
    if (located && !apartmentFloorsForBlock(unitBlockInput).length) {
      toast({ title: "Block is required", description: "Choose the block for this apartment.", variant: "destructive" as any });
      return;
    }
    const floor = Number(unitFloorInput);
    if (located && (!unitFloorInput || !apartmentFloorsForBlock(unitBlockInput).includes(floor))) {
      toast({ title: "Floor is required", description: "Choose a floor for the selected block.", variant: "destructive" as any });
      return;
    }
    if (!unitPriceInput.trim() || !Number.isFinite(price) || price < 0) {
      toast({ title: "Price is required", description: "Enter a price of 0 or more.", variant: "destructive" as any });
      return;
    }

    const payload: {
      projectId: string;
      number: string;
      type: string;
      price: number;
      status: string;
      block?: string;
      floor?: number;
      area?: number;
      customFields: { Name: string };
    } = {
      projectId: project.id,
      number,
      type,
      price,
      status: unitStatusInput,
      customFields: { Name: number },
    };

    if (located) {
      payload.block = unitBlockInput;
      payload.floor = floor;
    }
    if (unitAreaInput.trim()) {
      const area = Number(unitAreaInput.replace(/,/g, ""));
      if (!Number.isFinite(area) || area < 0) {
        toast({ title: "Invalid area", description: "Enter an area of 0 or more, or leave it blank.", variant: "destructive" as any });
        return;
      }
      payload.area = area;
    }

    try {
      setIsCreatingUnit(true);
      await unitApi.create(payload);
      setCreateDialogOpen(false);
      toast({ title: "Unit created", description: `${number} was added to ${project.name}.` });
      notifyUnitInventoryUpdated();
      await fetchProject();
    } catch (error: any) {
      toast({
        title: "Unable to create unit",
        description: error?.response?.data?.error || "Try again.",
        variant: "destructive" as any,
      });
    } finally {
      setIsCreatingUnit(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="grid gap-6 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (!project) return null;

  const showUnitLocation = unitUsesBlockAndFloor(unitTypeInput, project.projectType);
  const floorOptions = apartmentFloorsForBlock(unitBlockInput);
  const unitSelectClass = "flex h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="space-y-6">
      <RecordPageHeader
        objectLabel="Project"
        title={project.name}
        subtitle={project.location}
        backHref="/projects"
        icon={<Building2 className="h-5 w-5" aria-hidden="true" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canCreateUnit && (
              <Button onClick={openCreateUnit}>
                <Plus className="mr-2 h-4 w-4" />
                Create Unit
              </Button>
            )}
            <Button variant="outline" onClick={openLocationEditor}>
              <Edit className="mr-2 h-4 w-4" />
              Edit Location
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <p className="text-sm text-muted-foreground">{project.name} location</p>
            <p className="font-medium">{project.location}</p>
            <p className="font-medium">
              {project.latitude != null && project.longitude != null
                ? `${project.latitude}, ${project.longitude}`
                : "Coordinates not configured"}
            </p>
            <p className="text-sm text-muted-foreground">Allowed site-visit radius: {project.allowedRadiusMeters} meters</p>
          </div>
          {project.latitude != null && project.longitude != null && (
            <ProjectMap
              latitude={project.latitude}
              longitude={project.longitude}
              title={project.location || project.name}
              className="h-72 w-full"
            />
          )}
        </CardContent>
      </Card>

      <RecordSummary items={[
        { label: "Total Units", value: String(project.totalUnits) },
        { label: "Available", value: String(availableCount) },
        { label: "Booked", value: String(bookedCount) },
        { label: "Sold", value: String(soldCount) },
      ]} />

      <Tabs defaultValue="inventory" className="space-y-4">
        <TabsList>
          <TabsTrigger value="inventory" className="gap-2">
            <Building2 className="h-4 w-4" />
            Unit Inventory
          </TabsTrigger>
          <TabsTrigger value="overview" className="gap-2">
            <Home className="h-4 w-4" />
            Overview
          </TabsTrigger>
          {showDctValleyLayout && (
            <TabsTrigger value="land-layout" className="gap-2">
              <MapPin className="h-4 w-4" />
              Land Layout
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="inventory" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Filter by Floor:</span>
            <Button
              variant={selectedFloor === null ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedFloor(null)}
            >
              All
            </Button>
            {floors.map((floor) => (
              <Button
                key={floor}
                variant={selectedFloor === floor ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedFloor(floor)}
              >
                Floor {floor}
              </Button>
            ))}
            {canCreateUnit && (
              <Button size="sm" className="sm:ml-auto" onClick={openCreateUnit}>
                <Plus className="mr-2 h-4 w-4" />
                Create Unit
              </Button>
            )}
          </div>

          {filteredUnits.length === 0 && (
            <Card>
              <CardContent className="space-y-3 p-6">
                <p className="font-medium">
                  {selectedFloor == null ? "No units in this project yet." : `No units on floor ${selectedFloor}.`}
                </p>
                {selectedFloor == null && canCreateUnit && (
                  <>
                    <p className="text-sm text-muted-foreground">Create a unit to add it to {project.name}.</p>
                    <Button onClick={openCreateUnit}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create Unit
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {filteredUnits.map((unit) => (
              <Card
                key={unit.id}
                className={cn("border-2", statusColors[unit.status])}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <Link href={`/units/${unit.id}?from=/projects/${project.id}`} className="font-bold text-lg text-[#075d91] hover:underline">
                      {unit.unitNumber}
                    </Link>
                    <Badge className={statusColors[unit.status]}>
                      {unit.status}
                    </Badge>
                  </div>
                  <div className="space-y-1 text-sm">
                    <p>Type: {unit.type}</p>
                    {unit.block && <p>Block: {unit.block}</p>}
                    {(unit.block || unit.floor != null) && (
                      <p>Floor: {unit.floor == null ? "—" : unit.block ? formatApartmentFloor(unit.floor) : unit.floor}</p>
                    )}
                    <p>Area: {unit.area == null ? "—" : `${unit.area} sq ft`}</p>
                    <p className="font-medium">{formatCurrency(unit.price)}</p>
                    {unit.leadName && (
                      <p className="text-muted-foreground">
                        Lead: {unit.leadName}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle>Project Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p>{project.description}</p>
              <Separator />
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Type</p>
                  <Badge variant="outline" className="capitalize">{project.type}</Badge>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge className="capitalize">{project.status.replace("-", " ")}</Badge>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Start Date</p>
                  <p>{formatDate(project.startDate)}</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Expected Completion</p>
                  <p>{formatDate(project.expectedCompletion)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        {showDctValleyLayout && (
          <TabsContent value="land-layout">
            {units.length ? (
              <SampleLandLayout
                project={{
                  id: project.id,
                  name: project.name,
                  location: project.location,
                  totalUnits: project.totalUnits,
                  tagline: "ILLUSTRATIVE UNIT PLAN",
                }}
                plots={dctValleyLayoutPlots}
                statusColors={projectUnitStatusColors}
                statusOptions={projectUnitStatuses}
                demo={false}
              />
            ) : (
              <Card>
                <CardContent className="p-6">
                  <p className="font-medium">No DCT Valley units are available to show.</p>
                  <p className="mt-1 text-sm text-muted-foreground">Add units to this project to display them in the illustrative layout.</p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}
      </Tabs>

      <Dialog open={createDialogOpen} onOpenChange={(open) => !isCreatingUnit && setCreateDialogOpen(open)}>
        <DialogContent className="flex max-h-[90vh] w-[calc(100%-1.5rem)] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader className="shrink-0 pr-6">
            <DialogTitle>Create unit</DialogTitle>
            <DialogDescription>
              Add a unit to {project.name}. {unitUsesBlockAndFloor(unitTypeInput, project.projectType)
                ? "The unit number must be unique in the selected block and floor."
                : "The unit number must be unique in this project."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid min-h-0 flex-1 gap-4 overflow-y-auto py-2 pr-1 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void createUnit();
            }}
          >
            <div className="space-y-2 sm:col-span-2">
              <Label>Project</Label>
              <Input value={project.name} readOnly />
            </div>
            <div className="space-y-2">
              <Label htmlFor="unit-type">Type</Label>
              <select
                id="unit-type"
                className={unitSelectClass}
                value={unitTypeInput}
                required
                onChange={(event) => {
                  const nextType = event.target.value;
                  setUnitTypeInput(nextType);
                  if (!unitUsesBlockAndFloor(nextType, project.projectType)) {
                    setUnitBlockInput("");
                    setUnitFloorInput("");
                  }
                }}
              >
                <option value="">Select type</option>
                {UNIT_PROPERTY_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
            {showUnitLocation && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="unit-block">Block</Label>
                  <select
                    id="unit-block"
                    className={unitSelectClass}
                    value={unitBlockInput}
                    required
                    onChange={(event) => {
                      setUnitBlockInput(event.target.value);
                      setUnitFloorInput("");
                      setUnitNumberInput("");
                    }}
                  >
                    <option value="">Select block</option>
                    {APARTMENT_BLOCKS.map((block) => (
                      <option key={block} value={block}>{block}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="unit-floor">Floor</Label>
                  <select
                    id="unit-floor"
                    className={unitSelectClass}
                    value={unitFloorInput}
                    required
                    disabled={!unitBlockInput}
                    onChange={(event) => {
                      setUnitFloorInput(event.target.value);
                      setUnitNumberInput("");
                    }}
                  >
                    <option value="">{unitBlockInput ? "Select floor" : "Select a block first"}</option>
                    {floorOptions.map((floor) => (
                      <option key={floor} value={String(floor)}>{formatApartmentFloor(floor)}</option>
                    ))}
                  </select>
                </div>
              </>
            )}
            <div className="space-y-2">
              <Label htmlFor="unit-number">Unit number</Label>
              <Input
                id="unit-number"
                value={unitNumberInput}
                onChange={(event) => setUnitNumberInput(event.target.value)}
                maxLength={50}
                required
                placeholder={unitTypeInput === "Apartment" ? "Unit 1" : unitTypeInput === "Villa" ? "Villa 1" : "Plot 1"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="unit-price">Price</Label>
              <CurrencyInput id="unit-price" step="any" value={unitPriceInput} onChange={(event) => setUnitPriceInput(event.target.value)} required placeholder="0" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="unit-status">Status</Label>
              <select
                id="unit-status"
                className={unitSelectClass}
                value={unitStatusInput}
                onChange={(event) => setUnitStatusInput(event.target.value)}
              >
                <option value="AVAILABLE">Available</option>
                <option value="HOLD">Hold</option>
                <option value="SOLD">Sold</option>
                <option value="BLOCKED">Blocked</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="unit-area">Area (sq ft)</Label>
              <Input id="unit-area" inputMode="decimal" value={unitAreaInput} onChange={(event) => setUnitAreaInput(event.target.value)} placeholder="Optional" />
            </div>
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => setCreateDialogOpen(false)} disabled={isCreatingUnit}>Cancel</Button>
              <Button type="submit" disabled={isCreatingUnit}>
                {isCreatingUnit ? "Creating..." : "Create unit"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={locationDialogOpen} onOpenChange={(open) => !isSavingLocation && setLocationDialogOpen(open)}>
        <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden">
          <DialogHeader className="shrink-0 pr-6">
            <DialogTitle>Edit project details and location</DialogTitle>
            <DialogDescription>Project details and coordinates are saved to the database and used to verify site-visit completion. Scroll to move up and down.</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-scroll py-2 pr-1 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="project-name">Project name</Label>
              <Input id="project-name" value={projectNameInput} onChange={(event) => setProjectNameInput(event.target.value)} maxLength={200} />
            </div>
            <div className="sm:col-span-2">
              <ProjectLocationFields
                idPrefix="project"
                address={addressInput}
                city={cityInput}
                state={stateInput}
                latitude={latitudeInput}
                longitude={longitudeInput}
                onAddressChange={setAddressInput}
                onCityChange={setCityInput}
                onStateChange={setStateInput}
                onLatitudeChange={setLatitudeInput}
                onLongitudeChange={setLongitudeInput}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="project-radius">Allowed radius (meters)</Label>
              <Input id="project-radius" type="number" min="1" max="5000" step="1" value={radiusInput} onChange={(event) => setRadiusInput(event.target.value)} />
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setLocationDialogOpen(false)} disabled={isSavingLocation}>Cancel</Button>
            <Button onClick={saveLocation} disabled={isSavingLocation}>
              {isSavingLocation ? "Saving..." : "Save location"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
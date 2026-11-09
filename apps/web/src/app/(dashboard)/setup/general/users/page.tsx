"use client";

import * as React from "react";

import {
  Button,
} from "@/components/ui/button";

import {
  Card,
  CardContent,
} from "@/components/ui/card";

import {
  Badge,
} from "@/components/ui/badge";

import {
  Input,
} from "@/components/ui/input";

import {
  Label,
} from "@/components/ui/label";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  Skeleton,
} from "@/components/ui/skeleton";

import {
  ScrollArea,
} from "@/components/ui/scroll-area";

import {
  userApi,
  roleApi,
  profileApi,
  newPermissionSetApi,
  userPermissionApi,
  effectivePermissionApi,
  permissionApi,
  permissionSetGroupApi,
  userPermissionSetGroupApi,
  presenceApi,
} from "@/lib/api";
import { LoggedInBadge } from "@/components/crm/logged-in-badge";

import {
  useToast,
} from "@/hooks/use-toast";

import {
  useAuth,
} from "@/contexts/auth-context";

import { normalizeUserPhone } from "@dct-crm/shared";
import { buildRoleHierarchyOptions } from "@/lib/role-hierarchy";

import {
  Plus,
  Pencil,
  Search,
  Mail,
  Phone,
  Shield,
  UserCheck,
  UserX,
  Check,
  X,
  Users,
  KeyRound,
  LogIn,
  Layers3,
  Activity,
  Clock3,
} from "lucide-react";

/* =========================================================
   TYPES
========================================================= */

interface ProfileOption {
  id: string;
  name: string;
  isGlobal?: boolean;
}

interface RoleOption {
  id: string;
  name: string;
  description?: string | null;
  parentRoleId?: string | null;
  depth: number;
}

interface PermissionSet {
  id: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
  items?: any[];
}

interface PermissionSetGroup {
  id: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
  assignments?: any[];
}

interface Permission {
  id: string;
  name: string;
  label: string;
  module: string;
  action: string;
  description?: string | null;
  isActive?: boolean;
}

interface DirectPermission {
  id: string;
  permissionId: string;
  permission: Permission;
}

interface UserRole {
  role: {
    id: string;
    name: string;
  };
}

interface User {
  id: string;

  name: string;

  firstName: string;

  lastName: string;

  email: string;

  phone: string;

  avatar?: string | null;

  profileId: string | null;

  profile: {
    id: string;
    name: string;
  } | null;

  roleId?: string | null;

  role?: {
    id: string;
    name: string;
  } | null;

  roles: UserRole[];

  isActive: boolean;

  isLoggedIn?: boolean;

  lastSeenAt?: string | null;

  status: "active" | "inactive";

  createdAt: string;
}

interface UserFormData {
  name: string;
  email: string;
  phone: string;
  profileId: string;
  roleId: string;
  status: "active" | "inactive";
  password: string;
}

type PermissionTab =
  | "access"
  | "sets"
  | "groups"
  | "direct"
  | "effective";

const emptyForm: UserFormData = {
  name: "",
  email: "",
  phone: "",
  profileId: "",
  roleId: "",
  status: "active",
  password: "",
};

/* =========================================================
   HELPERS
========================================================= */

function getResponseData(response: any): any[] {
  const raw = response?.data;

  if (Array.isArray(raw)) {
    return raw;
  }

  if (Array.isArray(raw?.data)) {
    return raw.data;
  }

  if (Array.isArray(raw?.users)) {
    return raw.users;
  }

  if (Array.isArray(raw?.profiles)) {
    return raw.profiles;
  }

  if (Array.isArray(raw?.roles)) {
    return raw.roles;
  }

  if (Array.isArray(raw?.permissionSets)) {
    return raw.permissionSets;
  }

  if (Array.isArray(raw?.groups)) {
    return raw.groups;
  }

  if (Array.isArray(raw?.permissions)) {
    return raw.permissions;
  }

  return [];
}

function getInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join("")
      .slice(0, 2)
      .toUpperCase() || "U"
  );
}

function normalizeUser(user: any): User {
  const firstName = user?.firstName || "";
  const lastName = user?.lastName || "";

  const name =
    user?.name ||
    `${firstName} ${lastName}`.trim();

  const roles = Array.isArray(user?.roles)
    ? user.roles
    : [];

  const primaryRole =
    user?.role ||
    roles?.[0]?.role ||
    null;

  return {
    id: user.id,

    firstName,

    lastName,

    name,

    email: user?.email || "",

    phone: user?.phone || "",

    avatar: user?.avatar || null,

    profileId: user?.profileId || null,

    profile: user?.profile || null,

    roleId:
      user?.roleId ||
      primaryRole?.id ||
      null,

    role: primaryRole,

    roles,

    isActive:
      user?.isActive !== false,

    isLoggedIn: Boolean(user?.isLoggedIn),

    lastSeenAt: user?.lastSeenAt || null,

    status:
      user?.isActive === false
        ? "inactive"
        : "active",

    createdAt:
      user?.createdAt || "",
  };
}

/* =========================================================
   PAGE
========================================================= */

export default function UsersPage() {
  const { toast } = useToast();
  const { refresh: refreshAuth, tenant, isAdmin, isSuperAdmin } = useAuth();

  /* -------------------------------------------------------
     USERS
  ------------------------------------------------------- */

  const [users, setUsers] =
    React.useState<User[]>([]);

  const [detailUser, setDetailUser] =
    React.useState<User | null>(null);

  const [loading, setLoading] =
    React.useState(true);

  const [error, setError] =
    React.useState<string | null>(null);

  const [onlineOnly, setOnlineOnly] = React.useState(false);
  const [searchQuery, setSearchQuery] =
    React.useState("");

  const [activeTab, setActiveTab] =
    React.useState<
      "users" | "activate"
    >("users");

  /* -------------------------------------------------------
     ACCESS DATA
  ------------------------------------------------------- */

  const [availableProfiles, setAvailableProfiles] =
    React.useState<ProfileOption[]>([]);

  const [availableRoles, setAvailableRoles] =
    React.useState<RoleOption[]>([]);

  /* -------------------------------------------------------
     CREATE / EDIT
  ------------------------------------------------------- */

  const [dialogOpen, setDialogOpen] =
    React.useState(false);

  const [dialogMode, setDialogMode] =
    React.useState<"create" | "edit">(
      "create"
    );

  const [selectedUser, setSelectedUser] =
    React.useState<User | null>(null);

  const [formData, setFormData] =
    React.useState<UserFormData>(
      emptyForm
    );

  const [saving, setSaving] =
    React.useState(false);

  const phoneCheck = normalizeUserPhone(formData.phone, tenant?.country);
  const phoneError = "error" in phoneCheck ? phoneCheck.error : "";

  /* -------------------------------------------------------
     DELETE
  ------------------------------------------------------- */

  const [deleteDialogOpen, setDeleteDialogOpen] =
    React.useState(false);

  const [deleteTarget, setDeleteTarget] =
    React.useState<User | null>(null);

  const [deleting, setDeleting] =
    React.useState(false);

  /* -------------------------------------------------------
     PERMISSION DIALOG
  ------------------------------------------------------- */

  const [permDialogOpen, setPermDialogOpen] =
    React.useState(false);

  const [permTarget, setPermTarget] =
    React.useState<User | null>(null);

  const [permTab, setPermTab] =
    React.useState<PermissionTab>(
      "access"
    );

  const [permLoading, setPermLoading] =
    React.useState(false);

  /* -------------------------------------------------------
     PERMISSION SETS
  ------------------------------------------------------- */

  const [allPermissionSets, setAllPermissionSets] =
    React.useState<PermissionSet[]>([]);

  const [userPermSets, setUserPermSets] =
    React.useState<PermissionSet[]>([]);

  /* -------------------------------------------------------
     PERMISSION SET GROUPS
  ------------------------------------------------------- */

  const [allPermissionGroups, setAllPermissionGroups] =
    React.useState<PermissionSetGroup[]>([]);

  const [userPermissionGroups, setUserPermissionGroups] =
    React.useState<PermissionSetGroup[]>([]);

  /* -------------------------------------------------------
     DIRECT PERMISSIONS
  ------------------------------------------------------- */

  const [allPermissions, setAllPermissions] =
    React.useState<Permission[]>([]);

  const [userDirectPerms, setUserDirectPerms] =
    React.useState<DirectPermission[]>([]);

  /* -------------------------------------------------------
     EFFECTIVE PERMISSIONS
  ------------------------------------------------------- */

  const [effectivePerms, setEffectivePerms] =
    React.useState<any>(null);

  /* =======================================================
     FETCH USERS
  ======================================================= */

  const fetchUsers = React.useCallback(
    async () => {
      try {
        setLoading(true);
        setError(null);

        const response =
          await userApi.list({ limit: 200 });

        const data =
          getResponseData(response);

        const mapped =
          data.map(normalizeUser);

        setUsers(mapped);

        setDetailUser((current) => {
          if (
            current &&
            mapped.some(
              (user) =>
                user.id === current.id
            )
          ) {
            return (
              mapped.find(
                (user) =>
                  user.id === current.id
              ) || null
            );
          }

          return mapped[0] || null;
        });
      } catch (err: any) {
        const message =
          err?.response?.data?.message ||
          err?.message ||
          "Failed to fetch users";

        setError(message);

        toast({
          title: "Error",
          description: message,
          variant:
            "destructive" as any,
        });
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  /* =======================================================
     FETCH ACCESS DATA
  ======================================================= */

  const fetchAccessData =
    React.useCallback(async () => {
      const [profilesResult, rolesResult] = await Promise.allSettled([
        profileApi.list({ limit: 200 }),
        roleApi.list({ limit: 200, page: 1 }),
      ]);

      if (profilesResult.status === "fulfilled") {
        setAvailableProfiles(
          getResponseData(profilesResult.value).map((profile: any) => ({
            id: profile.id,
            name: profile.name,
            isGlobal: profile.isGlobal,
          }))
        );
      }

      if (rolesResult.status === "fulfilled") {
        try {
          const firstPage = getResponseData(rolesResult.value);
          const totalPages = Number(rolesResult.value?.data?.pagination?.totalPages) || 1;
          const remainingPages = await Promise.all(
            Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) =>
              roleApi.list({ limit: 200, page: index + 2 }),
            ),
          );
          setAvailableRoles(
            buildRoleHierarchyOptions([...firstPage, ...remainingPages.flatMap(getResponseData)]).map((role: any) => ({
              id: role.id,
              name: role.name,
              description: role.description || null,
              parentRoleId: role.parentRoleId || null,
              depth: role.depth,
            }))
          );
        } catch {
          toast({
            title: "Warning",
            description: "Some role options could not be loaded",
            variant: "destructive" as any,
          });
        }
      }

      if (profilesResult.status === "rejected" || rolesResult.status === "rejected") {
        toast({
          title: "Warning",
          description: "Some access options could not be loaded",
          variant: "destructive" as any,
        });
      }
    }, [toast]);

  React.useEffect(() => {
    fetchUsers();
    fetchAccessData();
  }, [
    fetchUsers,
    fetchAccessData,
  ]);

  /* =======================================================
     FILTER USERS
  ======================================================= */

  const filteredUsers =
    React.useMemo(() => {
      const query =
        searchQuery.trim().toLowerCase();

      const source = onlineOnly ? users.filter((user) => user.isLoggedIn) : users;

      if (!query) {
        return source;
      }

      return source.filter((user) => {
        return (
          user.name
            ?.toLowerCase()
            .includes(query) ||

          user.email
            ?.toLowerCase()
            .includes(query) ||

          user.phone
            ?.toLowerCase()
            .includes(query) ||

          user.profile?.name
            ?.toLowerCase()
            .includes(query) ||

          user.role?.name
            ?.toLowerCase()
            .includes(query)
        );
      });
    }, [
      users,
      searchQuery,
      onlineOnly,
    ]);

  const activeUsers =
    users.filter(
      (user) => user.isActive
    );

  /* =======================================================
     CREATE
  ======================================================= */

  const openCreateDialog = () => {
    setDialogMode("create");

    setSelectedUser(null);

    setFormData({
      ...emptyForm,
    });

    setDialogOpen(true);
  };

  /* =======================================================
     EDIT
  ======================================================= */

  const openEditDialog = (
    user: User
  ) => {
    setDialogMode("edit");

    setSelectedUser(user);

    setFormData({
      name: user.name || "",

      email: user.email || "",

      phone: user.phone || "",

      profileId:
        user.profileId || "",

      roleId:
        user.roleId ||
        user.role?.id ||
        "",

      status:
        user.status ||
        "active",

      password: "",
    });

    setDialogOpen(true);
  };

  /* =======================================================
     SAVE USER
  ======================================================= */

  const handleSave = async () => {
    const name =
      formData.name.trim();

    const email =
      formData.email.trim().toLowerCase();

    if (!name) {
      toast({
        title: "Validation",
        description:
          "Full name is required",
        variant:
          "destructive" as any,
      });

      return;
    }

    if (!email) {
      toast({
        title: "Validation",
        description:
          "Email is required",
        variant:
          "destructive" as any,
      });

      return;
    }

    if (phoneError) {
      toast({
        title: "Validation",
        description: phoneError,
        variant: "destructive" as any,
      });
      return;
    }

    const password = formData.password.trim();
    if (dialogMode === "create" && password.length < 8) {
      toast({ title: "Validation", description: "Password must be at least 8 characters", variant: "destructive" as any });
      return;
    }
    if (dialogMode === "edit" && password && password.length < 8) {
      toast({ title: "Validation", description: "New password must be at least 8 characters", variant: "destructive" as any });
      return;
    }

    try {
      setSaving(true);

      const nameParts =
        name.split(/\s+/);

      const firstName =
        nameParts[0] || name;

      const lastName =
        nameParts
          .slice(1)
          .join(" ");

      if (
        dialogMode === "create"
      ) {
        await userApi.create({
          email,

          firstName,

          lastName,

          phone:
            formData.phone.trim(),

          profileId:
            formData.profileId ||
            undefined,

          roleId:
            formData.roleId ||
            null,

          roleIds:
            formData.roleId
              ? [formData.roleId]
              : [],

          password,

          isActive:
            formData.status ===
            "active",
        });

        toast({
          title: "User created",
          description:
            `${name} was created successfully.`,
        });
      } else if (
        selectedUser
      ) {
        await userApi.update(
          selectedUser.id,
          {
            email,
            firstName,

            lastName,

            phone:
              formData.phone.trim(),

            profileId:
              formData.profileId ||
              null,

            roleId:
              formData.roleId ||
              null,

            roleIds:
              formData.roleId
                ? [formData.roleId]
                : [],

            isActive:
              formData.status ===
              "active",
          }
        );

        if (password) {
          await userApi.resetPassword(selectedUser.id, password);
        }

        /*
         * Make sure status is synchronized
         * with your existing activate/deactivate APIs.
         */
        if (
          formData.status ===
            "active" &&
          !selectedUser.isActive
        ) {
          await userApi.activate(
            selectedUser.id
          );
        }

        if (
          formData.status ===
            "inactive" &&
          selectedUser.isActive
        ) {
          await userApi.deactivate(
            selectedUser.id
          );
        }

        toast({
          title: "User updated",
          description:
            `${name} was updated successfully.`,
        });
      }

      setDialogOpen(false);

      setFormData({
        ...emptyForm,
      });

      await fetchUsers();
    } catch (err: any) {
      const message =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        "Unable to save user";

      toast({
        title: "Error",
        description: message,
        variant:
          "destructive" as any,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleLoginAsUser = async (user: User) => {
    try {
      await userApi.impersonate(user.id);
      window.location.href = "/home";
    } catch (err: any) {
      toast({ title: "Unable to log in as user", description: err?.response?.data?.error || err?.message || "Only administrators can use this action.", variant: "destructive" as any });
    }
  };

  /* =======================================================
     STATUS
  ======================================================= */

  const handleToggleStatus =
    async (user: User) => {
      try {
        if (user.isActive) {
          await userApi.deactivate(
            user.id
          );

          toast({
            title:
              "User deactivated",
            description:
              `${user.name} has been deactivated.`,
          });
        } else {
          await userApi.activate(
            user.id
          );

          toast({
            title:
              "User activated",
            description:
              `${user.name} has been activated.`,
          });
        }

        await fetchUsers();
      } catch (err: any) {
        toast({
          title: "Error",
          description:
            err?.response?.data
              ?.error ||
            err?.response?.data
              ?.message ||
            err?.message ||
            "Status update failed",
          variant:
            "destructive" as any,
        });
      }
    };

  /* =======================================================
     DELETE / DEACTIVATE
  ======================================================= */

  const openDeleteDialog = (
    user: User
  ) => {
    setDeleteTarget(user);
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) {
      return;
    }

    try {
      setDeleting(true);

      await userApi.deactivate(
        deleteTarget.id
      );

      toast({
        title:
          "User deactivated",
        description:
          `${deleteTarget.name} has been deactivated.`,
      });

      setDeleteDialogOpen(false);

      setDeleteTarget(null);

      await fetchUsers();
    } catch (err: any) {
      toast({
        title: "Error",
        description:
          err?.response?.data
            ?.message ||
          err?.message ||
          "Failed to deactivate user",
        variant:
          "destructive" as any,
      });
    } finally {
      setDeleting(false);
    }
  };

  /* =======================================================
     LOAD USER PERMISSIONS
  ======================================================= */

  const loadUserPermissionData =
    React.useCallback(
      async (userId: string) => {
        const [
          permissionSetsResponse,
          directResponse,
          effectiveResponse,
          permissionsResponse,
          allGroupsResponse,
          userGroupsResponse,
        ] =
          await Promise.all([
            userPermissionApi.getUserPermissionSets(
              userId
            ),

            userPermissionApi.getDirectPermissions(
              userId
            ),

            effectivePermissionApi.getUserPermissions(
              userId
            ),

            permissionApi.list({
              limit: 500,
            }),

            permissionSetGroupApi.list(),

            userPermissionSetGroupApi.list(
              userId
            ),
          ]);

        setAllPermissionGroups(
          getResponseData(allGroupsResponse)
        );

        setUserPermissionGroups(
          getResponseData(userGroupsResponse)
            .map((row: any) => row?.group)
            .filter(Boolean)
        );

        setUserPermSets(
          getResponseData(
            permissionSetsResponse
          ).map(
            (item: any) =>
              item.permissionSet ||
              item
          )
        );

        setUserDirectPerms(
          getResponseData(
            directResponse
          )
        );

        setEffectivePerms(
          effectiveResponse?.data
            ?.data ??
            effectiveResponse?.data ??
            null
        );

        setAllPermissions(
          getResponseData(
            permissionsResponse
          )
        );

        setAllPermissionGroups([]);
        setUserPermissionGroups([]);
      },
      []
    );

  /* =======================================================
     OPEN PERMISSION DIALOG
  ======================================================= */

  const openPermDialog =
    async (user: User) => {
      setPermTarget(user);

      setPermDialogOpen(true);

      setPermTab("access");

      setPermLoading(true);

      try {
        const permissionSetsResponse =
          await newPermissionSetApi.list({
            limit: 500,
          });

        setAllPermissionSets(
          getResponseData(
            permissionSetsResponse
          )
        );

        await loadUserPermissionData(
          user.id
        );
      } catch (err: any) {
        toast({
          title:
            "Permission error",
          description:
            err?.response?.data
              ?.error ||
            err?.response?.data
              ?.message ||
            err?.message ||
            "Failed to load permissions",
          variant:
            "destructive" as any,
        });
      } finally {
        setPermLoading(false);
      }
    };

  /* =======================================================
     REFRESH PERMISSIONS
  ======================================================= */

  const refreshPermissions =
    async () => {
      if (!permTarget) {
        return;
      }

      try {
        await loadUserPermissionData(
          permTarget.id
        );
      } catch (err: any) {
        toast({
          title: "Error",
          description:
            err?.message ||
            "Failed to refresh permissions",
          variant:
            "destructive" as any,
        });
      }
    };

  /* =======================================================
     ASSIGN PERMISSION SET
  ======================================================= */

  const handleAssignPermSet =
    async (
      permissionSetId: string,
      assign: boolean
    ) => {
      if (!permTarget) {
        return;
      }

      try {
        if (assign) {
          await userPermissionApi.assignPermissionSets(
            permTarget.id,
            [permissionSetId]
          );

          toast({
            title:
              "Permission set assigned",
            description:
              "The permission set is now assigned to this user.",
          });
        } else {
          await userPermissionApi.unassignPermissionSet(
            permTarget.id,
            permissionSetId
          );

          toast({
            title:
              "Permission set removed",
            description:
              "The permission set was removed from this user.",
          });
        }

        await refreshPermissions();
        await refreshAuth();
      } catch (err: any) {
        toast({
          title: "Error",
          description:
            err?.response?.data
              ?.message ||
            err?.message ||
            "Permission set operation failed",
          variant:
            "destructive" as any,
        });
      }
    };

  /* =======================================================
     ASSIGN PERMISSION SET GROUP
  ======================================================= */

  const handleAssignGroup =
    async (
      groupId: string,
      assign: boolean
    ) => {
      if (!permTarget) {
        return;
      }

      try {
        if (assign) {
          await userPermissionSetGroupApi.assign(
            permTarget.id,
            [groupId]
          );

          toast({
            title:
              "Permission group assigned",
            description:
              "The permission set group is now assigned.",
          });
        } else {
          await userPermissionSetGroupApi.unassign(
            permTarget.id,
            groupId
          );

          toast({
            title:
              "Permission group removed",
            description:
              "The permission set group was removed.",
          });
        }

        await refreshPermissions();
        await refreshAuth();
      } catch (err: any) {
        toast({
          title: "Error",
          description:
            err?.response?.data
              ?.message ||
            err?.message ||
            "Permission group operation failed",
          variant:
            "destructive" as any,
        });
      }
    };

  /* =======================================================
     DIRECT PERMISSION
  ======================================================= */

  const handleDirectPermission =
    async (
      permissionId: string,
      assigned: boolean
    ) => {
      if (!permTarget) {
        return;
      }

      try {
        if (assigned) {
          await userPermissionApi.removeDirectPermission(
            permTarget.id,
            permissionId
          );
        } else {
          await userPermissionApi.addDirectPermissions(
            permTarget.id,
            [permissionId]
          );
        }

        await refreshPermissions();
        await refreshAuth();

        toast({
          title: assigned
            ? "Permission removed"
            : "Permission added",
          description:
            assigned
              ? "Direct permission removed."
              : "Direct permission added.",
        });
      } catch (err: any) {
        toast({
          title: "Error",
          description:
            err?.response?.data
              ?.message ||
            err?.message ||
            "Permission operation failed",
          variant:
            "destructive" as any,
        });
      }
    };

  /* =======================================================
     LOADING
  ======================================================= */

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Skeleton className="mb-2 h-8 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>

          <Skeleton className="h-10 w-36" />
        </div>

        <Card>
          <CardContent className="p-6">
            <div className="space-y-4">
              {Array.from({
                length: 6,
              }).map((_, index) => (
                <Skeleton
                  key={index}
                  className="h-12 w-full"
                />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* =======================================================
     ERROR
  ======================================================= */

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold">
            Users
          </h1>

          <p className="text-muted-foreground">
            Manage system users
          </p>
        </div>

        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="mb-4 text-destructive">
              {error}
            </p>

            <Button
              onClick={fetchUsers}
              variant="outline"
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* =======================================================
     MAIN UI
  ======================================================= */

  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-sm">

      {/* HEADER */}

      <div className="flex items-center justify-between border-b px-5 py-4">

        <div>
          <h1 className="text-xl font-semibold">
            Users
          </h1>

          <p className="text-sm text-muted-foreground">
            Manage users, profiles, roles and permissions
          </p>
        </div>

        <Button
          onClick={openCreateDialog}
        >
          <Plus className="mr-2 h-4 w-4" />
          New User
        </Button>
      </div>

      {/* TOP TABS */}

      <div className="flex border-b px-5">

        <button
          className={`border-b-2 px-4 py-3 text-sm font-medium ${
            activeTab === "users"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground"
          }`}
          onClick={() =>
            setActiveTab("users")
          }
        >
          Users ({users.length})
        </button>

        <button
          className={`border-b-2 px-4 py-3 text-sm font-medium ${
            activeTab === "activate"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground"
          }`}
          onClick={() =>
            setActiveTab("activate")
          }
        >
          Activate Users ({activeUsers.length})
        </button>
      </div>

      {/* ===================================================
          ACTIVATE TAB
      =================================================== */}

      {activeTab === "activate" ? (
        <div className="p-5">

          <div className="mb-5 flex items-center justify-between">

            <div>
              <h2 className="text-lg font-semibold">
                Activate Users
              </h2>

              <p className="text-sm text-muted-foreground">
                Activate or deactivate users.
              </p>
            </div>

            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />

              <Input
                placeholder="Search users"
                value={searchQuery}
                onChange={(event) =>
                  setSearchQuery(
                    event.target.value
                  )
                }
                className="pl-9"
              />
            </div>
          </div>

          <div className="rounded-md border">

            <Table>

              <TableHeader>
                <TableRow>

                  <TableHead>
                    Full Name
                  </TableHead>

                  <TableHead>
                    Email
                  </TableHead>

                  <TableHead>
                    Role
                  </TableHead>

                  <TableHead>
                    Profile
                  </TableHead>

                  <TableHead>
                    Status
                  </TableHead>

                  <TableHead>
                    Is Logged In
                  </TableHead>

                  <TableHead className="text-right">
                    Action
                  </TableHead>

                </TableRow>
              </TableHeader>

              <TableBody>

                {filteredUsers.map(
                  (user) => (
                    <TableRow
                      key={user.id}
                    >

                      <TableCell className="font-medium">
                        {user.name ||
                          "Unnamed user"}
                      </TableCell>

                      <TableCell>
                        {user.email}
                      </TableCell>

                      <TableCell>
                        {user.role?.name ||
                          user.roles
                            ?.map(
                              (item) =>
                                item.role
                                  ?.name
                            )
                            .join(", ") ||
                          "-"}
                      </TableCell>

                      <TableCell>
                        {user.profile?.name ||
                          "-"}
                      </TableCell>

                      <TableCell>
                        <Badge
                          variant={
                            user.isActive
                              ? "default"
                              : "secondary"
                          }
                        >
                          {user.isActive
                            ? "Active"
                            : "Inactive"}
                        </Badge>
                      </TableCell>

                      <TableCell>
                        <LoggedInBadge online={Boolean(user.isLoggedIn)} lastSeenAt={user.lastSeenAt} />
                      </TableCell>

                      <TableCell className="text-right">

                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            handleToggleStatus(
                              user
                            )
                          }
                        >
                          {user.isActive
                            ? "Deactivate"
                            : "Activate"}
                        </Button>

                      </TableCell>

                    </TableRow>
                  )
                )}

              </TableBody>

            </Table>

          </div>
        </div>
      ) : (

        /* =================================================
           USERS TAB
        ================================================= */

        <div className="grid min-h-[650px] md:grid-cols-[minmax(340px,42%)_1fr]">

          {/* USER LIST */}

          <div className="border-r">

            <div className="flex items-center justify-between border-b px-5 py-4">

              <div className="flex items-center gap-2 text-sm font-medium">

                <Users className="h-4 w-4" />

                Active Users (
                {
                  users.filter(
                    (user) =>
                      user.isActive
                  ).length
                }
                )

              </div>

              <span className="text-xs text-muted-foreground">
                {filteredUsers.length} shown
              </span>

            </div>

            <div className="border-b px-5 py-3">

              <div className="relative">

                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />

                <Input
                  placeholder="Search users"
                  value={searchQuery}
                  onChange={(event) =>
                    setSearchQuery(
                      event.target.value
                    )
                  }
                  className="pl-9"
                />

              </div>

              <label className="mt-3 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={onlineOnly} onChange={(event) => setOnlineOnly(event.target.checked)} />
                Online users only
              </label>

            </div>

            <ScrollArea className="h-[560px]">

              {filteredUsers.map(
                (user) => (

                  <button
                    key={user.id}
                    onClick={() =>
                      setDetailUser(
                        user
                      )
                    }
                    className={`flex w-full items-center gap-3 border-b px-5 py-4 text-left transition-colors hover:bg-muted/50 ${
                      detailUser?.id ===
                      user.id
                        ? "bg-primary/5"
                        : ""
                    }`}
                  >

                    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-semibold text-muted-foreground">

                      {user.avatar ? (
                        <img
                          src={user.avatar}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        getInitials(
                          user.name
                        )
                      )}

                    </div>

                    <div className="min-w-0 flex-1">

                      <p className="flex items-center gap-2 truncate font-medium">
                        <span className="truncate">{user.name || "Unnamed user"}</span>
                        <LoggedInBadge online={Boolean(user.isLoggedIn)} lastSeenAt={user.lastSeenAt} />
                      </p>

                      <p className="truncate text-sm text-muted-foreground">
                        {user.profile?.name ||
                          user.role?.name ||
                          "No access profile"}
                      </p>

                      <p className="truncate text-xs text-muted-foreground">
                        {user.email}
                      </p>

                    </div>

                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        user.isActive
                          ? "bg-emerald-500"
                          : "bg-muted-foreground/40"
                      }`}
                    />

                  </button>

                )
              )}

              {filteredUsers.length ===
                0 && (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  No users found.
                </p>
              )}

            </ScrollArea>
          </div>

          {/* USER DETAILS */}

          <div className="p-6">

            {detailUser ? (
              <>

                {/* USER HEADER */}

                <div className="flex items-start gap-4 border-b pb-6">

                  <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xl font-semibold text-muted-foreground">

                    {detailUser.avatar ? (
                      <img
                        src={
                          detailUser.avatar
                        }
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      getInitials(
                        detailUser.name
                      )
                    )}

                  </div>

                  <div className="min-w-0 flex-1">

                    <div className="flex flex-wrap items-center gap-2">

                      <h2 className="text-xl font-semibold">
                        {detailUser.name ||
                          "Unnamed user"}
                      </h2>
                      <LoggedInBadge online={Boolean(detailUser.isLoggedIn)} lastSeenAt={detailUser.lastSeenAt} />

                      <Badge
                        variant={
                          detailUser.isActive
                            ? "default"
                            : "secondary"
                        }
                      >
                        {detailUser.isActive
                          ? "Active"
                          : "Inactive"}
                      </Badge>

                    </div>

                    <p className="mt-1 text-muted-foreground">
                      {detailUser.profile?.name ||
                        "No profile assigned"}
                    </p>

                    <div className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">

                      <span className="inline-flex items-center gap-2">
                        <Mail className="h-4 w-4" />
                        {detailUser.email}
                      </span>

                      {detailUser.phone && (
                        <span className="inline-flex items-center gap-2">
                          <Phone className="h-4 w-4" />
                          {detailUser.phone}
                        </span>
                      )}

                    </div>

                  </div>

                  {(isAdmin || isSuperAdmin) && (
                    <Button
                      variant="outline"
                      onClick={async () => {
                        if (!window.confirm(`Force logout ${detailUser.name}?`)) return;
                        await presenceApi.forceLogoutUser(detailUser.id);
                        await fetchUsers();
                      }}
                    >
                      Force logout
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      openEditDialog(
                        detailUser
                      )
                    }
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>

                </div>

                {/* INFORMATION */}

                <div className="mt-6 grid gap-6 sm:grid-cols-2">

                  <div>

                    <h3 className="font-semibold">
                      User Information
                    </h3>

                    <dl className="mt-4 space-y-3 text-sm">

                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">
                          First name
                        </dt>

                        <dd>
                          {detailUser.firstName ||
                            "-"}
                        </dd>
                      </div>

                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">
                          Last name
                        </dt>

                        <dd>
                          {detailUser.lastName ||
                            "-"}
                        </dd>
                      </div>

                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">
                          Email
                        </dt>

                        <dd className="truncate">
                          {detailUser.email}
                        </dd>
                      </div>

                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">
                          Phone
                        </dt>

                        <dd>
                          {detailUser.phone ||
                            "-"}
                        </dd>
                      </div>

                    </dl>

                  </div>

                  <div>

                    <h3 className="font-semibold">
                      Access Information
                    </h3>

                    <dl className="mt-4 space-y-3 text-sm">

                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">
                          Profile
                        </dt>

                        <dd>
                          {detailUser.profile?.name ||
                            "-"}
                        </dd>
                      </div>

                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">
                          Primary Role
                        </dt>

                        <dd>
                          {detailUser.role?.name ||
                            "-"}
                        </dd>
                      </div>

                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">
                          Roles
                        </dt>

                        <dd>
                          {detailUser.roles
                            ?.map(
                              (item) =>
                                item.role?.name
                            )
                            .join(", ") ||
                            "-"}
                        </dd>
                      </div>

                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">
                          Created
                        </dt>

                        <dd>
                          {detailUser.createdAt
                            ? new Date(
                                detailUser.createdAt
                              ).toLocaleDateString()
                            : "-"}
                        </dd>
                      </div>

                    </dl>

                  </div>

                </div>

                {/* ACTIONS */}

                <div className="mt-8 border-t pt-5">

                  <h3 className="flex items-center gap-2 font-semibold">
                    <Clock3 className="h-4 w-4" />
                    Account Actions
                  </h3>

                  <div className="mt-4 flex flex-wrap gap-2">

                    <Button
                      variant="outline"
                      onClick={() =>
                        openPermDialog(
                          detailUser
                        )
                      }
                    >
                      <Shield className="mr-2 h-4 w-4" />
                      Manage Access
                    </Button>

                    <Button
                      variant="outline"
                      onClick={() => void handleLoginAsUser(detailUser)}
                    >
                      <LogIn className="mr-2 h-4 w-4" />
                      Login as user
                    </Button>

                    <Button
                      variant="outline"
                      onClick={() =>
                        openEditDialog(
                          detailUser
                        )
                      }
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit User
                    </Button>

                    <Button
                      variant="outline"
                      onClick={() =>
                        handleToggleStatus(
                          detailUser
                        )
                      }
                    >
                      {detailUser.isActive ? (
                        <>
                          <UserX className="mr-2 h-4 w-4" />
                          Deactivate
                        </>
                      ) : (
                        <>
                          <UserCheck className="mr-2 h-4 w-4" />
                          Activate
                        </>
                      )}
                    </Button>

                  </div>

                </div>

              </>
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                Select a user to view details.
              </div>
            )}

          </div>

        </div>
      )}

      {/* ===================================================
          CREATE / EDIT USER
      =================================================== */}

      <Dialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      >

        <DialogContent className="sm:max-w-lg">

          <DialogHeader>

            <DialogTitle>
              {dialogMode ===
              "create"
                ? "Create User"
                : "Edit User"}
            </DialogTitle>

            <DialogDescription>
              {dialogMode ===
              "create"
                ? "Create a new organization user and assign access."
                : "Update user information and access settings."}
            </DialogDescription>

          </DialogHeader>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              handleSave();
            }}
          >

            <div className="space-y-4">

              {/* NAME */}

              <div className="space-y-2">

                <Label>
                  Full Name *
                </Label>

                <Input
                  value={formData.name}
                  onChange={(event) =>
                    setFormData(
                      (current) => ({
                        ...current,
                        name: event.target.value,
                      })
                    )
                  }
                  placeholder="Enter full name"
                />

              </div>

              {/* EMAIL */}

              <div className="space-y-2">

                <Label>
                  Email *
                </Label>

                <Input
                  type="email"
                  value={
                    formData.email
                  }
                  onChange={(event) =>
                    setFormData(
                      (current) => ({
                        ...current,
                        email:
                          event.target
                            .value,
                      })
                    )
                  }
                  placeholder="Enter email address"
                />

              </div>

              {/* PHONE */}

              <div className="space-y-2">

                <Label>
                  Phone <span className="text-destructive">*</span>
                </Label>

                <Input
                  value={
                    formData.phone
                  }
                  onChange={(event) =>
                    setFormData(
                      (current) => ({
                        ...current,
                        phone:
                          event.target
                            .value,
                      })
                    )
                  }
                  placeholder="+91 98765 43210"
                  aria-invalid={Boolean(phoneError)}
                />
                {phoneError && <p className="text-sm text-destructive">{phoneError}</p>}

              </div>

              {/* PASSWORD */}

              <div className="space-y-2">
                <Label>
                  {dialogMode === "create" ? "Password *" : "Reset Password"}
                </Label>
                <Input
                  type="password"
                  value={formData.password}
                  onChange={(event) =>
                    setFormData((current) => ({
                      ...current,
                      password: event.target.value,
                    }))
                  }
                  placeholder={dialogMode === "create" ? "At least 8 characters" : "Leave blank to keep current password"}
                />
                {dialogMode === "edit" && <p className="text-xs text-muted-foreground">Enter a new password only when you want to reset it.</p>}
              </div>

              {/* PROFILE */}

              <div className="space-y-2">

                <Label>
                  Profile
                </Label>

                <Select
                  value={
                    formData.profileId
                  }
                  onValueChange={(
                    value
                  ) =>
                    setFormData(
                      (current) => ({
                        ...current,
                        profileId:
                          value,
                      })
                    )
                  }
                >

                  <SelectTrigger>
                    <SelectValue placeholder="Select profile" />
                  </SelectTrigger>

                  <SelectContent>

                    {availableProfiles.map(
                      (profile) => (
                        <SelectItem
                          key={
                            profile.id
                          }
                          value={
                            profile.id
                          }
                        >
                          {profile.name}{profile.isGlobal ? " (Shared)" : ""}
                        </SelectItem>
                      )
                    )}

                  </SelectContent>

                </Select>

              </div>

              {/* ROLE */}

              <div className="space-y-2">

                <Label>
                  Primary Role
                </Label>

                <Select
                  value={
                    formData.roleId
                  }
                  onValueChange={(
                    value
                  ) =>
                    setFormData(
                      (current) => ({
                        ...current,
                        roleId:
                          value,
                      })
                    )
                  }
                >

                  <SelectTrigger>
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>

                  <SelectContent>

                    {availableRoles.map(
                      (role) => (
                        <SelectItem
                          key={
                            role.id
                          }
                          value={
                            role.id
                          }
                        >
                          <span style={{ paddingLeft: role.depth * 12 }}>
                            {role.depth > 0 ? "↳ " : ""}
                            {role.name}
                          </span>
                        </SelectItem>
                      )
                    )}

                  </SelectContent>

                </Select>

              </div>

              {/* STATUS */}

              <div className="space-y-2">

                <Label>
                  Status
                </Label>

                <Select
                  value={
                    formData.status
                  }
                  onValueChange={(
                    value
                  ) =>
                    setFormData(
                      (current) => ({
                        ...current,
                        status:
                          value as
                            | "active"
                            | "inactive",
                      })
                    )
                  }
                >

                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>

                  <SelectContent>

                    <SelectItem value="active">
                      Active
                    </SelectItem>

                    <SelectItem value="inactive">
                      Inactive
                    </SelectItem>

                  </SelectContent>

                </Select>

              </div>

            </div>

            <DialogFooter className="mt-6">

              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDialogOpen(
                    false
                  )
                }
                disabled={saving}
              >
                Cancel
              </Button>

              <Button
                type="submit"
                disabled={saving || Boolean(phoneError) || !formData.name.trim() || !formData.email.trim()}
              >
                {saving
                  ? "Saving..."
                  : dialogMode ===
                      "create"
                    ? "Create User"
                    : "Save Changes"}
              </Button>

            </DialogFooter>

          </form>

        </DialogContent>

      </Dialog>

      {/* ===================================================
          DELETE / DEACTIVATE
      =================================================== */}

      <AlertDialog
        open={
          deleteDialogOpen
        }
        onOpenChange={
          setDeleteDialogOpen
        }
      >

        <AlertDialogContent>

          <AlertDialogHeader>

            <AlertDialogTitle>
              Deactivate user?
            </AlertDialogTitle>

            <AlertDialogDescription>
              This will deactivate{" "}
              <strong>
                {deleteTarget?.name}
              </strong>
              . The user can be activated again later.
            </AlertDialogDescription>

          </AlertDialogHeader>

          <AlertDialogFooter>

            <AlertDialogCancel
              disabled={deleting}
            >
              Cancel
            </AlertDialogCancel>

            <AlertDialogAction
              onClick={
                handleDelete
              }
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting
                ? "Deactivating..."
                : "Deactivate"}
            </AlertDialogAction>

          </AlertDialogFooter>

        </AlertDialogContent>

      </AlertDialog>

      {/* ===================================================
          MANAGE ACCESS
      =================================================== */}

      <Dialog
        open={permDialogOpen}
        onOpenChange={
          setPermDialogOpen
        }
      >

        <DialogContent className="flex max-h-[88vh] max-w-5xl flex-col overflow-hidden">

          <DialogHeader>

            <DialogTitle className="flex items-center gap-2">

              <Shield className="h-5 w-5" />

              Manage Access

            </DialogTitle>

            <DialogDescription>

              {permTarget?.name}

              {" · "}

              Profile:{" "}
              {permTarget?.profile
                ?.name ||
                "None"}

              {" · "}

              Role:{" "}
              {permTarget?.role
                ?.name ||
                "None"}

            </DialogDescription>

          </DialogHeader>

          {/* PERMISSION TABS */}

          <div className="flex flex-wrap gap-2 border-b pb-3">

            <Button
              size="sm"
              variant={
                permTab ===
                "access"
                  ? "default"
                  : "ghost"
              }
              onClick={() =>
                setPermTab(
                  "access"
                )
              }
            >
              <KeyRound className="mr-2 h-4 w-4" />
              Access
            </Button>

            <Button
              size="sm"
              variant={
                permTab ===
                "sets"
                  ? "default"
                  : "ghost"
              }
              onClick={() =>
                setPermTab(
                  "sets"
                )
              }
            >
              Permission Sets
            </Button>

            <Button
              size="sm"
              variant={
                permTab ===
                "groups"
                  ? "default"
                  : "ghost"
              }
              onClick={() =>
                setPermTab(
                  "groups"
                )
              }
            >
              <Layers3 className="mr-2 h-4 w-4" />
              Permission Groups
            </Button>

            <Button
              size="sm"
              variant={
                permTab ===
                "direct"
                  ? "default"
                  : "ghost"
              }
              onClick={() =>
                setPermTab(
                  "direct"
                )
              }
            >
              Direct Permissions
            </Button>

            <Button
              size="sm"
              variant={
                permTab ===
                "effective"
                  ? "default"
                  : "ghost"
              }
              onClick={() =>
                setPermTab(
                  "effective"
                )
              }
            >
              <Activity className="mr-2 h-4 w-4" />
              Effective
            </Button>

          </div>

          {/* CONTENT */}

          {permLoading ? (

            <div className="flex flex-1 items-center justify-center py-16">

              <div className="text-center">

                <div className="mx-auto mb-3 h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />

                <p className="text-sm text-muted-foreground">
                  Loading access...
                </p>

              </div>

            </div>

          ) : (

            <ScrollArea className="flex-1 pr-4">

              {/* ==========================================
                  ACCESS
              ========================================== */}

              {permTab ===
                "access" && (

                <div className="space-y-6 py-4">

                  <div className="grid gap-4 md:grid-cols-2">

                    <Card>

                      <CardContent className="p-5">

                        <div className="flex items-center gap-3">

                          <div className="rounded-lg bg-primary/10 p-2">
                            <Shield className="h-5 w-5 text-primary" />
                          </div>

                          <div>

                            <p className="text-sm text-muted-foreground">
                              Profile
                            </p>

                            <p className="font-semibold">
                              {permTarget
                                ?.profile
                                ?.name ||
                                "Not assigned"}
                            </p>

                          </div>

                        </div>

                      </CardContent>

                    </Card>

                    <Card>

                      <CardContent className="p-5">

                        <div className="flex items-center gap-3">

                          <div className="rounded-lg bg-primary/10 p-2">
                            <Users className="h-5 w-5 text-primary" />
                          </div>

                          <div>

                            <p className="text-sm text-muted-foreground">
                              Primary Role
                            </p>

                            <p className="font-semibold">
                              {permTarget
                                ?.role
                                ?.name ||
                                "Not assigned"}
                            </p>

                          </div>

                        </div>

                      </CardContent>

                    </Card>

                  </div>

                  <Card>

                    <CardContent className="p-5">

                      <h3 className="font-semibold">
                        Permission Architecture
                      </h3>

                      <div className="mt-4 space-y-3">

                        <div className="flex items-center justify-between rounded-lg border p-3">

                          <div>
                            <p className="font-medium">
                              Profile
                            </p>

                            <p className="text-xs text-muted-foreground">
                              Base system and object access
                            </p>
                          </div>

                          <Badge>
                            Base
                          </Badge>

                        </div>

                        <div className="flex items-center justify-between rounded-lg border p-3">

                          <div>
                            <p className="font-medium">
                              Permission Sets
                            </p>

                            <p className="text-xs text-muted-foreground">
                              Additional permissions
                            </p>
                          </div>

                          <Badge variant="outline">
                            {userPermSets.length}
                          </Badge>

                        </div>

                        <div className="flex items-center justify-between rounded-lg border p-3">

                          <div>
                            <p className="font-medium">
                              Permission Set Groups
                            </p>

                            <p className="text-xs text-muted-foreground">
                              Bundled permission sets
                            </p>
                          </div>

                          <Badge variant="outline">
                            {
                              userPermissionGroups.length
                            }
                          </Badge>

                        </div>

                        <div className="flex items-center justify-between rounded-lg border p-3">

                          <div>
                            <p className="font-medium">
                              Direct Permissions
                            </p>

                            <p className="text-xs text-muted-foreground">
                              User-specific system permissions
                            </p>
                          </div>

                          <Badge variant="outline">
                            {
                              userDirectPerms.length
                            }
                          </Badge>

                        </div>

                      </div>

                    </CardContent>

                  </Card>

                </div>
              )}

              {/* ==========================================
                  PERMISSION SETS
              ========================================== */}

              {permTab ===
                "sets" && (

                <div className="space-y-3 py-4">

                  {allPermissionSets.length ===
                  0 ? (

                    <div className="rounded-lg border p-8 text-center">

                      <p className="font-medium">
                        No permission sets
                      </p>

                      <p className="mt-1 text-sm text-muted-foreground">
                        Create permission sets first.
                      </p>

                    </div>

                  ) : (

                    allPermissionSets.map(
                      (permissionSet) => {

                        const assigned =
                          userPermSets.some(
                            (item) =>
                              item.id ===
                              permissionSet.id
                          );

                        return (
                          <div
                            key={
                              permissionSet.id
                            }
                            className="flex items-center justify-between rounded-lg border p-4"
                          >

                            <div>

                              <p className="font-medium">
                                {
                                  permissionSet.name
                                }
                              </p>

                              <p className="text-sm text-muted-foreground">
                                {permissionSet.description ||
                                  `${
                                    permissionSet
                                      .items
                                      ?.length ||
                                    0
                                  } permissions`}
                              </p>

                            </div>

                            <Button
                              size="sm"
                              variant={
                                assigned
                                  ? "destructive"
                                  : "default"
                              }
                              onClick={() =>
                                handleAssignPermSet(
                                  permissionSet.id,
                                  !assigned
                                )
                              }
                            >
                              {assigned
                                ? "Remove"
                                : "Assign"}
                            </Button>

                          </div>
                        );
                      }
                    )

                  )}

                </div>
              )}

              {/* ==========================================
                  PERMISSION SET GROUPS
              ========================================== */}

              {permTab ===
                "groups" && (

                <div className="space-y-3 py-4">

                  {allPermissionGroups.length ===
                  0 ? (

                    <div className="rounded-lg border p-8 text-center">

                      <p className="font-medium">
                        No permission groups
                      </p>

                      <p className="mt-1 text-sm text-muted-foreground">
                        Create permission set groups first.
                      </p>

                    </div>

                  ) : (

                    allPermissionGroups.map(
                      (group) => {

                        const assigned =
                          userPermissionGroups.some(
                            (item) =>
                              item.id ===
                              group.id
                          );

                        return (
                          <div
                            key={
                              group.id
                            }
                            className="flex items-center justify-between rounded-lg border p-4"
                          >

                            <div>

                              <p className="font-medium">
                                {group.name}
                              </p>

                              <p className="text-sm text-muted-foreground">
                                {group.description ||
                                  `${
                                    group
                                      .assignments
                                      ?.length ||
                                    0
                                  } permission sets`}
                              </p>

                            </div>

                            <Button
                              size="sm"
                              variant={
                                assigned
                                  ? "destructive"
                                  : "default"
                              }
                              onClick={() =>
                                handleAssignGroup(
                                  group.id,
                                  !assigned
                                )
                              }
                            >
                              {assigned
                                ? "Remove"
                                : "Assign"}
                            </Button>

                          </div>
                        );
                      }
                    )

                  )}

                </div>
              )}

              {/* ==========================================
                  DIRECT PERMISSIONS
              ========================================== */}

              {permTab ===
                "direct" && (

                <div className="space-y-6 py-4">

                  <div>

                    <h3 className="font-semibold">
                      Direct User Permissions
                    </h3>

                    <p className="text-sm text-muted-foreground">
                      These permissions are assigned directly to this user.
                    </p>

                  </div>

                  <div className="space-y-2">

                    {allPermissions.length ===
                    0 ? (

                      <p className="text-sm text-muted-foreground">
                        No permissions available.
                      </p>

                    ) : (

                      Object.entries(
                        allPermissions.reduce(
                          (
                            result: Record<
                              string,
                              Permission[]
                            >,
                            permission
                          ) => {

                            const permissionModule =
                              permission.module ||
                              "General";

                            if (
                              !result[
                                permissionModule
                              ]
                            ) {
                              result[
                                permissionModule
                              ] = [];
                            }

                            result[
                              permissionModule
                            ].push(
                              permission
                            );

                            return result;
                          },
                          {}
                        )
                      ).map(
                        ([
                          module,
                          permissions,
                        ]) => (

                          <div
                            key={
                              module
                            }
                            className="rounded-lg border p-4"
                          >

                            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {module}
                            </p>

                            <div className="flex flex-wrap gap-2">

                              {permissions.map(
                                (
                                  permission
                                ) => {

                                  const assigned =
                                    userDirectPerms.some(
                                      (
                                        direct
                                      ) =>
                                        direct
                                          .permission
                                          ?.id ===
                                        permission.id
                                    );

                                  return (
                                    <Button
                                      key={
                                        permission.id
                                      }
                                      size="sm"
                                      variant={
                                        assigned
                                          ? "secondary"
                                          : "outline"
                                      }
                                      className="h-8"
                                      onClick={() =>
                                        handleDirectPermission(
                                          permission.id,
                                          assigned
                                        )
                                      }
                                    >

                                      {assigned && (
                                        <Check className="mr-1 h-3 w-3" />
                                      )}

                                      {
                                        permission.label
                                      }

                                    </Button>
                                  );
                                }
                              )}

                            </div>

                          </div>

                        )
                      )

                    )}

                  </div>

                </div>
              )}

              {/* ==========================================
                  EFFECTIVE PERMISSIONS
              ========================================== */}

              {permTab ===
                "effective" && (

                <div className="space-y-5 py-4">

                  {!effectivePerms ? (

                    <div className="rounded-lg border p-8 text-center">

                      <p className="text-sm text-muted-foreground">
                        Effective permission information is not available.
                      </p>

                    </div>

                  ) : (

                    <>

                      <div className="grid gap-3 md:grid-cols-3">

                        <Card>
                          <CardContent className="p-4 text-center">

                            <p className="text-xl font-bold">
                              {
                                effectivePerms.total ??
                                0
                              }
                            </p>

                            <p className="text-xs text-muted-foreground">
                              Total Permissions
                            </p>

                          </CardContent>
                        </Card>

                        <Card>
                          <CardContent className="p-4 text-center">

                            <p className="text-xl font-bold">
                              {
                                effectivePerms
                                  .sources
                                  ?.profile
                                  ?.length ??
                                0
                              }
                            </p>

                            <p className="text-xs text-muted-foreground">
                              From Profile
                            </p>

                          </CardContent>
                        </Card>

                        <Card>
                          <CardContent className="p-4 text-center">

                            <p className="text-xl font-bold">
                              {
                                effectivePerms
                                  .sources
                                  ?.permissionSets
                                  ?.length ??
                                0
                              }
                            </p>

                            <p className="text-xs text-muted-foreground">
                              From Permission Sets
                            </p>

                          </CardContent>
                        </Card>

                      </div>

                      {effectivePerms.hasFullAccess && (
                        <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm font-medium text-green-800">
                          Full system access
                        </div>
                      )}

                      {Object.entries(
                        effectivePerms.byModule ||
                          {}
                      ).map(
                        ([
                          module,
                          permissions,
                        ]: [
                          string,
                          any
                        ]) => (

                          <div
                            key={
                              module
                            }
                            className="rounded-lg border p-4"
                          >

                            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {module}
                            </p>

                            <div className="flex flex-wrap gap-2">

                              {(permissions ||
                                []).map(
                                (
                                  permission: any
                                ) => (

                                  <Badge
                                    key={
                                      permission.name
                                    }
                                    variant="outline"
                                  >

                                    {
                                      permission.name
                                    }

                                    {permission.source && (
                                      <span className="ml-1 text-muted-foreground">
                                        ·{" "}
                                        {
                                          permission.source
                                        }
                                      </span>
                                    )}

                                  </Badge>

                                )
                              )}

                            </div>

                          </div>

                        )
                      )}

                    </>

                  )}

                </div>
              )}

            </ScrollArea>
          )}

          <DialogFooter>

            <Button
              variant="outline"
              onClick={() =>
                setPermDialogOpen(
                  false
                )
              }
            >
              Close
            </Button>

          </DialogFooter>

        </DialogContent>

      </Dialog>

    </div>
  );
}
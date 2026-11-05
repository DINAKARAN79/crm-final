"use client";

import * as React from "react";
import { getDefaultLeadStatusLabel, normalizePermissionName } from "@dct-crm/shared";
import {
  authApi,
  ApiResponse,
  clearSessionToken,
  getSessionLastActivity,
  getSessionToken,
  getSessionTokenExpiry,
  impersonationApi,
  impersonationMeta,
  recordSessionActivity,
  refreshSessionToken,
  SESSION_IDLE_TIMEOUT_MS,
  leadApi,
} from "@/lib/api";

export interface LeadStatusOption {
  statusId: string;
  status: string;
  label: string;
  enabled: boolean;
}

export interface UserProfile {
  id: string;
  name: string;
  description?: string;
  isAdmin?: boolean;
}

export interface UserData {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatar?: string;
  phone?: string;
  isSuperAdmin?: boolean;
  impersonatedBy?: string | null;
}

export interface AuthContextType {
  user: UserData | null;
  profile: UserProfile | null;
  roles: string[];
  permissions: Record<string, any>;
  effectivePermissions: string[];
  effectivePermissionsByModule: Record<string, string[]>;
  hasFullAccess: boolean;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  tenant: { id: string; name: string; slug: string; country?: string | null } | null;
  leadStatuses: LeadStatusOption[];
  getLeadStatusLabel: (status: string) => string;
  isLoading: boolean;
  isAuthenticated: boolean;
  hasRole: (role: string) => boolean;
  hasPermission: (objectName: string, action: string) => boolean;
  hasEffectivePermission: (permissionName: string) => boolean;
  hasAnyEffectivePermission: (permissionNames: string[]) => boolean;
  hasModulePermission: (module: string, action: string) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  stopImpersonating: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<UserData | null>(null);
  const [profile, setProfile] = React.useState<UserProfile | null>(null);
  const [roles, setRoles] = React.useState<string[]>([]);
  const [permissions, setPermissions] = React.useState<Record<string, any>>({});
  const [effectivePermissions, setEffectivePermissions] = React.useState<string[]>([]);
  const [effectivePermissionsByModule, setEffectivePermissionsByModule] = React.useState<Record<string, string[]>>({});
  const [hasFullAccess, setHasFullAccess] = React.useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = React.useState(false);
  const [isAdmin, setIsAdmin] = React.useState(false);
  const [tenant, setTenant] = React.useState<{ id: string; name: string; slug: string; country?: string | null } | null>(null);
  const [leadStatuses, setLeadStatuses] = React.useState<LeadStatusOption[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const authRetryTimer = React.useRef<number | null>(null);
  const loadUserRef = React.useRef<() => Promise<void>>(async () => undefined);

  const loadUser = React.useCallback(async () => {
    let retrying = false;
    try {
      const res = await authApi.me();
      if (res.data.success && res.data.data) {
        const data = res.data.data;
        setUser(data.user);
        setRoles(data.roles || []);
        setPermissions(data.permissions || {});
        setEffectivePermissions(data.effectivePermissions || []);
        setEffectivePermissionsByModule(data.effectivePermissionsByModule || {});
        setHasFullAccess(data.hasFullAccess || false);
        setIsSuperAdmin(data.user?.isSuperAdmin || false);
        setTenant(data.tenant);
        try {
          const statusResponse = await leadApi.statuses();
          const statuses = statusResponse.data?.data;
          setLeadStatuses(Array.isArray(statuses) ? statuses : []);
        } catch {
          setLeadStatuses([]);
        }
        if (data.profile) {
          setProfile(data.profile);
        }
        setIsAdmin(Boolean(data.user?.isSuperAdmin || data.profile?.isAdmin));
      }
    } catch (error) {
      const status = typeof error === 'object' && error && 'response' in error
        ? (error as { response?: { status?: number } }).response?.status
        : undefined;
      if (getSessionToken() && (status === undefined || status === 409 || status === 429 || status >= 500)) {
        retrying = true;
        if (authRetryTimer.current !== null) window.clearTimeout(authRetryTimer.current);
        authRetryTimer.current = window.setTimeout(() => {
          authRetryTimer.current = null;
          void loadUserRef.current();
        }, 5_000);
      }
    } finally {
      if (!retrying) setIsLoading(false);
    }
  }, []);
  loadUserRef.current = loadUser;

  React.useEffect(() => {
    loadUser();
  }, [loadUser]);

  React.useEffect(() => () => {
    if (authRetryTimer.current !== null) window.clearTimeout(authRetryTimer.current);
  }, []);

  React.useEffect(() => {
    if (!user || !getSessionToken()) return;

    let active = true;
    let timer: number | undefined;
    let consecutiveFailures = 0;
    const scheduleRefresh = () => {
      if (!active || !getSessionToken()) return;
      const expiry = getSessionTokenExpiry();
      const delay = expiry === null ? 0 : Math.max(0, expiry - Date.now() - 60_000);
      timer = window.setTimeout(() => {
        void refreshBeforeExpiry();
      }, delay);
    };
    const refreshBeforeExpiry = async () => {
      try {
        await refreshSessionToken();
        consecutiveFailures = 0;
        scheduleRefresh();
      } catch (error) {
        const status = typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
        if (status === 401) return;
        consecutiveFailures += 1;
        const retryDelay = Math.min(5_000 * (2 ** (consecutiveFailures - 1)), 60_000);
        timer = window.setTimeout(() => {
          void refreshBeforeExpiry();
        }, retryDelay);
      }
    };

    scheduleRefresh();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [user]);

  React.useEffect(() => {
    if (!user || !getSessionToken()) return;

    let idleTimer: ReturnType<typeof setTimeout>;
    const endSessionIfIdle = () => {
      const remaining = SESSION_IDLE_TIMEOUT_MS - (Date.now() - getSessionLastActivity());
      if (remaining <= 0) {
        const finish = () => {
          clearSessionToken();
          window.location.replace("/login");
        };
        if (impersonationMeta()) {
          void impersonationApi.exit().catch(() => undefined).finally(finish);
          return;
        }
        void authApi.logout().catch(() => undefined).finally(finish);
        return;
      }
      idleTimer = setTimeout(endSessionIfIdle, remaining);
    };

    const handleActivity = () => {
      if (Date.now() - getSessionLastActivity() >= 250) {
        recordSessionActivity();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(endSessionIfIdle, SESSION_IDLE_TIMEOUT_MS);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(idleTimer);
        endSessionIfIdle();
      }
    };

    endSessionIfIdle();
    window.addEventListener("pointerdown", handleActivity, { passive: true });
    window.addEventListener("mousemove", handleActivity, { passive: true });
    window.addEventListener("keydown", handleActivity);
    window.addEventListener("touchstart", handleActivity, { passive: true });
    window.addEventListener("wheel", handleActivity, { passive: true });
    window.addEventListener("scroll", handleActivity, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);

    let heartbeatTimer: number | undefined;
    const scheduleHeartbeat = (delayMs: number) => {
      if (document.visibilityState !== "visible") return;
      if (heartbeatTimer) window.clearTimeout(heartbeatTimer);
      heartbeatTimer = window.setTimeout(() => {
        void sendHeartbeat();
      }, delayMs);
    };
    const sendHeartbeat = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await authApi.heartbeat();
        const nextInMs = Number(response.data?.data?.nextInMs);
        scheduleHeartbeat(
          Number.isFinite(nextInMs) && nextInMs >= 15_000 && nextInMs <= 120_000
            ? nextInMs
            : 30_000,
        );
      } catch {
        scheduleHeartbeat(30_000);
      }
    };
    const armHeartbeat = () => {
      if (heartbeatTimer) window.clearTimeout(heartbeatTimer);
      if (document.visibilityState !== "visible") return;
      heartbeatTimer = undefined;
      void sendHeartbeat();
    };
    const pauseHeartbeat = () => {
      if (document.visibilityState === "visible") {
        armHeartbeat();
        return;
      }
      if (heartbeatTimer) window.clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    };
    const sendCloseBeacon = () => {
      const token = getSessionToken();
      if (!token) return;
      const body = new Blob([JSON.stringify({ token })], { type: "application/json" });
      navigator.sendBeacon("/api/proxy/api/auth/leave", body);
    };
    armHeartbeat();
    document.addEventListener("visibilitychange", pauseHeartbeat);
    window.addEventListener("pagehide", sendCloseBeacon);

    return () => {
      clearTimeout(idleTimer);
      window.removeEventListener("pointerdown", handleActivity);
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("touchstart", handleActivity);
      window.removeEventListener("wheel", handleActivity);
      window.removeEventListener("scroll", handleActivity);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (heartbeatTimer) window.clearInterval(heartbeatTimer);
      document.removeEventListener("visibilitychange", pauseHeartbeat);
      window.removeEventListener("pagehide", sendCloseBeacon);
    };
  }, [user]);

  const hasRole = React.useCallback(
    (role: string) => roles.includes(role),
    [roles]
  );

  const hasEffectivePermission = React.useCallback(
    (permissionName: string) => {
      if (hasFullAccess) return true;
      const requestedPermission = normalizePermissionName(permissionName);
      return effectivePermissions.some(
        (grantedPermission) => normalizePermissionName(grantedPermission) === requestedPermission
      );
    },
    [effectivePermissions, hasFullAccess]
  );

  const hasPermission = React.useCallback(
    (objectName: string, action?: string) => {
      if (!action) {
        return hasEffectivePermission(objectName);
      }

      const normalizedAction = (action || "").toLowerCase();
      const aliasMap: Record<string, string> = {
        view: "read",
        edit: "update",
        delect: "delete",
      };
      const normalizedPermission = aliasMap[normalizedAction] || normalizedAction;

      const objectNameCandidates = new Set<string>([
        objectName,
        objectName.replace(/([a-z])([A-Z])/g, "$1_$2"),
        objectName.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase(),
      ]);

      const objPerms = Array.from(objectNameCandidates).reduce<Record<string, any> | undefined>((result, candidate) => {
        if (result) return result;
        return permissions[candidate] || result;
      }, undefined);

      if (objPerms) {
        if (objPerms.modifyAll) return true;
        if (normalizedPermission === "read" && objPerms.viewAll) return true;
        return !!objPerms[normalizedPermission];
      }

      const moduleName = objectName.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
      const permissionName = `${moduleName}_${normalizedPermission.toUpperCase()}`;
      if (normalizedPermission === "read" && hasEffectivePermission(`${moduleName}_VIEW_ALL`)) return true;
      if (normalizedPermission === "delete" && hasEffectivePermission(`${moduleName}_MODIFY_ALL`)) return true;
      if (normalizedPermission === "update" && hasEffectivePermission(`${moduleName}_MODIFY_ALL`)) return true;
      return hasEffectivePermission(permissionName);
    },
    [hasEffectivePermission, permissions]
  );

  const hasAnyEffectivePermission = React.useCallback(
    (permissionNames: string[]) => {
      if (hasFullAccess) return true;
      return permissionNames.some((name) => hasEffectivePermission(name));
    },
    [hasEffectivePermission, hasFullAccess]
  );

  const hasModulePermission = React.useCallback(
    (module: string, action: string) => {
      if (hasFullAccess) return true;
      return hasEffectivePermission(`${module}_${action}`);
    },
    [hasEffectivePermission, hasFullAccess]
  );
  const getLeadStatusLabel = React.useCallback(
    (status: string) => leadStatuses.find((item) => item.status === status)?.label || getDefaultLeadStatusLabel(status),
    [leadStatuses],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        roles,
        permissions,
        effectivePermissions,
        effectivePermissionsByModule,
        hasFullAccess,
        isSuperAdmin,
        isAdmin,
        tenant,
        leadStatuses,
        getLeadStatusLabel,
        isLoading,
        isAuthenticated: !!user,
        hasRole,
        hasPermission,
        hasEffectivePermission,
        hasAnyEffectivePermission,
        hasModulePermission,
        refresh: loadUser,
        logout: async () => {
          try {
            await authApi.logout();
          } catch (e) {
            // ignore
          } finally {
            clearSessionToken();
            setUser(null);
            setProfile(null);
            setRoles([]);
            setPermissions({});
            setEffectivePermissions([]);
            setEffectivePermissionsByModule({});
            setHasFullAccess(false);
            setIsSuperAdmin(false);
            setIsAdmin(false);
            setTenant(null);
            setLeadStatuses([]);
            window.location.href = "/login";
          }
        },
        stopImpersonating: async () => {
          try {
            await authApi.stopImpersonation();
          } finally {
            window.location.href = "/home";
          }
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

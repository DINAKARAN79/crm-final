"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Boxes,
  Building2,
  ClipboardList,
  FileKey2,
  GitBranch,
  Globe,
  KeyRound,
  LayoutTemplate,
  Phone,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { companyApi } from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";

const groups = [
  {
    title: "General",
    description: "Manage people and organization details.",
    items: [
      { label: "Users", href: "/setup/general/users", icon: Users },
      { label: "Active Sessions", href: "/setup/general/users/active-sessions", icon: Users },
      { label: "Company Settings", href: "/setup/general/company-settings", icon: Building2 },
    ],
  },
  {
    title: "Security Control",
    description: "Control access and review changes.",
    items: [
      { label: "Profiles", href: "/setup/security/profiles", icon: ShieldCheck },
      { label: "Permission Sets", href: "/setup/security/permission-sets", icon: KeyRound },
      { label: "Roles", href: "/setup/security/roles", icon: GitBranch },
    ],
  },
  {
    title: "Custom Portal Details",
    description: "Manage CP Portal access and GRE forms.",
    items: [
      { label: "CP Portal Accounts", href: "/cp-portal-accounts", icon: KeyRound },
      { label: "CP Portal", href: "http://localhost:3002/login", icon: Globe, external: true },
      { label: "GRE Forms", href: "/setup/developer/gre", icon: FileKey2 },
    ],
  },
  {
    title: "Customization",
    description: "Shape CRM data and user experiences.",
    items: [
      { label: "Round Robins", href: "/setup/customization/rrqueues", icon: GitBranch },
      { label: "Object Manager", href: "/admin/object-manager", icon: Boxes },
    ],
  },
  {
    title: "Integrations",
    description: "Connect the CRM to outside systems.",
    items: [
      { label: "Telephony", href: "/setup/integrations/telephony", icon: Phone },
      { label: "API access", href: "/setup/integrations/api-access", icon: KeyRound },
    ],
  },
  {
    title: "Data Administration",
    description: "Prepare the system for data operations.",
    items: [
      { label: "Data Import", href: "/setup/data/import", icon: ClipboardList },
      { label: "Data Update", href: "/setup/data/update", icon: ArrowRight },
    ],
  },
];

export default function SetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isLoading, isAuthenticated, isAdmin, isSuperAdmin, hasFullAccess, hasEffectivePermission } = useAuth();
  const requestedTenantId = searchParams.get("tenantId") || "";
  const [companyName, setCompanyName] = React.useState("");
  const [companyError, setCompanyError] = React.useState("");
  const tenantId = isSuperAdmin ? requestedTenantId : "";
  const canManageObjects =
    isSuperAdmin || (isAdmin && (hasFullAccess || hasEffectivePermission("PROFILE_PERMISSION_MANAGE")));

  React.useEffect(() => {
    if (!tenantId) {
      setCompanyName("");
      setCompanyError("");
      return;
    }
    let active = true;
    setCompanyError("");
    companyApi.get(tenantId)
      .then((response) => {
        if (active) setCompanyName(response.data.data?.name || "");
      })
      .catch((error) => {
        if (active) {
          setCompanyName("");
          setCompanyError(error?.response?.data?.error || "Unable to load company Setup Home.");
        }
      });
    return () => {
      active = false;
    };
  }, [tenantId]);

  React.useEffect(() => {
    if (!isLoading && (!isAuthenticated || !isAdmin)) {
      router.replace(isAuthenticated ? "/home" : "/login?redirect=/setup");
    }
  }, [isAuthenticated, isAdmin, isLoading, router]);

  if (isLoading || !isAuthenticated || !isAdmin) return null;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4 border-b border-sky-100 pb-6">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-[#278db8]">Administration</p>
          <h1 className="mt-1 text-xl font-bold tracking-tight text-[#075d91]">Setup</h1>
          <p className="mt-2 max-w-2xl text-[#1479a8]">
            Configure your CRM, manage access, and keep your organization secure.
          </p>
          {tenantId && companyName && (
            <p className="mt-2 text-sm font-medium text-[#075d91]">Company: {companyName}</p>
          )}
          {companyError && <p role="alert" className="mt-2 text-sm text-destructive">{companyError}</p>}
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-sky-100 bg-gradient-to-br from-white to-sky-50 text-blue-600 shadow-sm"><Settings className="h-6 w-6" /></div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => {
          const visibleItems = group.items.filter(
            (item) => item.href !== "/admin/object-manager" || canManageObjects,
          );
          if (visibleItems.length === 0) return null;
          return (
          <section key={group.title} className="rounded-xl border border-sky-100 bg-gradient-to-br from-white to-[#f5fbff] p-5 shadow-sm">
            <h2 className="font-bold text-[#075d91]">{group.title}</h2>
            <p className="mt-1 text-sm text-[#1479a8]">{group.description}</p>
            <div className="mt-5 divide-y divide-sky-100">
              {visibleItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.label}
                    href={tenantId && !("external" in item && item.external)
                      ? `${item.href}${item.href.includes("?") ? "&" : "?"}tenantId=${encodeURIComponent(tenantId)}`
                      : item.href}
                    target={"external" in item && item.external ? "_blank" : undefined}
                    rel={"external" in item && item.external ? "noopener noreferrer" : undefined}
                    className="flex items-center gap-3 py-3 text-sm text-[#075d91] transition-colors hover:text-blue-600"
                  >
                    <Icon className="h-4 w-4 text-[#278db8]" />
                    <span className="flex-1">{item.label}</span>
                    <ArrowRight className="h-4 w-4 text-[#278db8]" />
                  </Link>
                );
              })}
            </div>
          </section>
          );
        })}
      </div>
    </div>
  );
}
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SetupPage from "./page";
import SetupSectionPage from "./section-page";

const setupContext = vi.hoisted(() => ({
  canManageObjects: true,
  isSuperAdmin: false,
  tenantId: "",
}));
const companyApiMock = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue({ data: { data: { id: "tenant-1", name: "Acme CRM" } } }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(
    setupContext.tenantId ? `tenantId=${encodeURIComponent(setupContext.tenantId)}` : "",
  ),
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    isLoading: false,
    isAuthenticated: true,
    isAdmin: true,
    isSuperAdmin: setupContext.isSuperAdmin,
    hasFullAccess: false,
    hasEffectivePermission: () => setupContext.canManageObjects,
  }),
}));

vi.mock("@/lib/api", () => ({
  companyApi: companyApiMock,
}));

describe("SetupPage", () => {
  beforeEach(() => {
    setupContext.canManageObjects = true;
    setupContext.isSuperAdmin = false;
    setupContext.tenantId = "";
    companyApiMock.get.mockClear();
  });

  it("provides links to GRE Forms and Object Manager to admins with object-management permission", () => {
    render(<SetupPage />);

    expect(screen.getByRole("link", { name: /GRE Forms/i })).toHaveAttribute(
      "href",
      "/setup/developer/gre",
    );
    expect(screen.getByRole("link", { name: /Object Manager/i })).toHaveAttribute(
      "href",
      "/admin/object-manager",
    );
  });

  it("hides Object Manager from admins without object-management permission", () => {
    setupContext.canManageObjects = false;

    render(<SetupPage />);

    expect(screen.getByRole("link", { name: /GRE Forms/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Object Manager/i })).not.toBeInTheDocument();
  });

  it("groups portal links under Custom Portal Details and omits duplicate and recycle-bin links", () => {
    render(<SetupPage />);

    expect(screen.getByRole("heading", { name: "Custom Portal Details" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /CP Portal$/i })).toHaveAttribute(
      "href",
      "http://localhost:3002/login",
    );
    expect(screen.getByRole("link", { name: /GRE Forms/i })).toHaveAttribute(
      "href",
      "/setup/developer/gre",
    );
    expect(screen.queryByRole("heading", { name: "Sites" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "GRE" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Duplicate Management/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Recycle Bin/i })).not.toBeInTheDocument();
  });

  it("scopes each Setup Home section and its settings links to the selected company", async () => {
    setupContext.isSuperAdmin = true;
    setupContext.tenantId = "tenant-1";
    render(<SetupPage />);

    for (const heading of ["General", "Security Control", "Custom Portal Details", "Customization", "Data Administration"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(await screen.findByText("Company: Acme CRM")).toBeInTheDocument();
    expect(companyApiMock.get).toHaveBeenCalledWith("tenant-1");
    expect(screen.getByRole("link", { name: /Users/i })).toHaveAttribute(
      "href",
      "/setup/general/users?tenantId=tenant-1",
    );
    expect(screen.getByRole("link", { name: /Profiles/i })).toHaveAttribute(
      "href",
      "/setup/security/profiles?tenantId=tenant-1",
    );
    expect(screen.getByRole("link", { name: /CP Portal Accounts/i })).toHaveAttribute(
      "href",
      "/cp-portal-accounts?tenantId=tenant-1",
    );
    expect(screen.getByRole("link", { name: /Object Manager/i })).toHaveAttribute(
      "href",
      "/admin/object-manager?tenantId=tenant-1",
    );
    expect(screen.getByRole("link", { name: /Data Import/i })).toHaveAttribute(
      "href",
      "/setup/data/import?tenantId=tenant-1",
    );
    expect(screen.getByRole("link", { name: /Data Update/i })).toHaveAttribute(
      "href",
      "/setup/data/update?tenantId=tenant-1",
    );
    expect(screen.getByRole("link", { name: /CP Portal$/i })).toHaveAttribute(
      "href",
      "http://localhost:3002/login",
    );
  });

  it("preserves the selected company when navigating between setup sections", () => {
    setupContext.isSuperAdmin = true;
    setupContext.tenantId = "tenant-1";
    render(
      <SetupSectionPage
        title="General"
        description="Company administration"
        items={[{ label: "Users", description: "Manage users", href: "/setup/general/users" }]}
      />,
    );

    expect(screen.getByRole("link", { name: /Back to Setup/i })).toHaveAttribute(
      "href",
      "/setup?tenantId=tenant-1",
    );
    expect(screen.getByRole("link", { name: /Users/i })).toHaveAttribute(
      "href",
      "/setup/general/users?tenantId=tenant-1",
    );
  });
});

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  createLead: vi.fn(),
  listFields: vi.fn(),
  listProjects: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: testState.push }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: testState.toast }),
}));

vi.mock("@/lib/api", () => ({
  leadApi: {
    create: testState.createLead,
  },
  projectApi: { listAll: testState.listProjects },
  objectDefinitionApi: { fields: testState.listFields },
}));

import NewLeadPage from "../app/(dashboard)/leads/new/page";

beforeEach(() => {
  vi.clearAllMocks();
  testState.listProjects.mockResolvedValue([{ id: "project-1", name: "DCT Heights" }]);
  testState.listFields.mockResolvedValue({
    data: {
      data: [
        { name: "source", fieldType: "picklist", picklistValues: [{ label: "Website", value: "WEBSITE" }] },
        { name: "firstCampaign", fieldType: "picklist", picklistValues: [{ label: "Summer", value: "SUMMER" }] },
        { name: "lastCampaign", fieldType: "picklist", picklistValues: [{ label: "Landing page", value: "LANDING_PAGE" }] },
        { name: "leadInterest", fieldType: "picklist", picklistValues: [{ label: "Prospect", value: "PROSPECT" }] },
      ],
    },
  });
  testState.createLead.mockResolvedValue({
    data: { success: true, action: "NEW_LEAD", leadId: "lead-new" },
  });
});

async function fillRequiredLeadFields() {
  await screen.findByLabelText(/Primary Phone/);
  fireEvent.change(screen.getByLabelText(/Last Name/), { target: { value: "Customer" } });
  fireEvent.change(screen.getByLabelText(/Primary Phone/), { target: { value: "9876543210" } });
  fireEvent.change(screen.getByLabelText(/Lead Source/), { target: { value: "WEBSITE" } });
  fireEvent.change(screen.getByLabelText(/Project Name/), { target: { value: "project-1" } });
  fireEvent.change(screen.getByLabelText(/Lead Interest/), { target: { value: "PROSPECT" } });
  fireEvent.change(screen.getByLabelText((content) => content.replace("*", "").trim() === "Campaign"), { target: { value: "SUMMER" } });
  fireEvent.change(screen.getByLabelText(/Sub Campaign/), { target: { value: "LANDING_PAGE" } });
}

describe("Create Lead duplicate handling", () => {
  it("shows a tenant-safe duplicate response without linking to another lead", async () => {
    testState.createLead.mockRejectedValue({
      response: {
        status: 409,
        data: {
          success: false,
          code: "DUPLICATE_LEAD",
          fields: ["phone"],
          error: "This phone number already exists in your tenant.",
        },
      },
    });

    render(<NewLeadPage />);
    await fillRequiredLeadFields();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(testState.createLead).toHaveBeenCalledWith(expect.objectContaining({
        lastName: "Customer",
        phone: "9876543210",
        projectId: "project-1",
        firstCampaign: "SUMMER",
        lastCampaign: "LANDING_PAGE",
      }));
    });
    expect(testState.createLead.mock.calls[0][0]).not.toHaveProperty("linkToLeadId");
    expect(await screen.findByRole("alert")).toHaveTextContent("This phone number already exists in your tenant.");
    expect(testState.push).not.toHaveBeenCalled();
  });

  it("reports both duplicate contact fields without exposing a matched lead", async () => {
    testState.createLead.mockRejectedValue({
      response: {
        status: 409,
        data: {
          success: false,
          code: "DUPLICATE_LEAD",
          fields: ["phone", "email"],
          error: "This phone number and email already exist in your tenant.",
        },
      },
    });

    render(<NewLeadPage />);
    await fillRequiredLeadFields();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This phone number and email already exist in your tenant.");
    expect(testState.createLead).toHaveBeenCalledOnce();
    expect(testState.createLead.mock.calls[0][0]).not.toHaveProperty("linkToLeadId");
    expect(testState.push).not.toHaveBeenCalled();
  });
});

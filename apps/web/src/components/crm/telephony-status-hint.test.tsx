import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TelephonyStatusHint } from "./telephony-status-hint";
import { buildTelephonySettingsHref, getSafeTelephonyReturnTo, getTelephonySettingsHash } from "@/lib/telephony-navigation";

describe("TelephonyStatusHint", () => {
  it.each([
    ["NO_PERMISSION", "You do not have permission to place calls. Ask an admin to grant the Telephony permission."],
    ["DISABLED", "Telephony is switched off for this company."],
    ["PERMISSION_UNAVAILABLE", "The telephony permission is not set up on this server."],
    ["DIALPAD_EMBED_BLOCKED", "The Bizcall dialpad is not allowed on this site."],
    ["INVALID_PHONE", "This phone number is not valid for calling."],
    ["IMPERSONATING", "Calls are disabled while viewing as another user."],
    ["HTTPS_REQUIRED", "Calls need HTTPS because browsers block the microphone on plain HTTP."],
  ])("shows the specific explanation for %s", (reasonCode, message) => {
    render(<TelephonyStatusHint reasonCode={reasonCode} />);
    fireEvent.click(screen.getByRole("button", { name: "Why can't I call this number?" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(message);
  });

  it("offers admins the correct settings deep link and safe return path", () => {
    render(<TelephonyStatusHint reasonCode="PERMISSION_UNAVAILABLE" isAdmin leadId="lead/123" />);
    fireEvent.click(screen.getByRole("button", { name: "Why can't I call this number?" }));
    expect(screen.getByRole("link", { name: "Open Telephony settings" })).toHaveAttribute(
      "href",
      "/setup/integrations/telephony?returnTo=%2Fleads%2Flead%252F123#agents",
    );
  });

  it("asks non-admins to contact an administrator without exposing settings", () => {
    render(<TelephonyStatusHint reasonCode="DISABLED" />);
    fireEvent.click(screen.getByRole("button", { name: "Why can't I call this number?" }));
    expect(screen.getByText("Ask your administrator to enable telephony.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Telephony settings" })).not.toBeInTheDocument();
  });

  it("supports Escape and outside-click dismissal and restores focus", async () => {
    render(<TelephonyStatusHint reasonCode="NO_PERMISSION" />);
    const trigger = screen.getByRole("button", { name: "Why can't I call this number?" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("does not render a hint when the phone is clickable", () => {
    render(<TelephonyStatusHint reasonCode="NO_PERMISSION" isClickable />);
    expect(screen.queryByRole("button", { name: "Why can't I call this number?" })).not.toBeInTheDocument();
  });
});

describe("telephony settings navigation", () => {
  it.each([
    ["DISABLED", "bizcall-connection"],
    ["NO_PERMISSION", "agents"],
    ["PERMISSION_UNAVAILABLE", "agents"],
    ["DIALPAD_EMBED_BLOCKED", "dialpad"],
  ])("routes %s to #%s", (reasonCode, hash) => {
    expect(getTelephonySettingsHash(reasonCode)).toBe(hash);
    expect(buildTelephonySettingsHref(reasonCode)).toBe(`/setup/integrations/telephony#${hash}`);
  });

  it("accepts same-origin return paths and rejects external or unsafe values", () => {
    const origin = "https://crm.example.com";
    expect(getSafeTelephonyReturnTo("/leads/123?tab=details", origin)).toBe("/leads/123?tab=details");
    expect(getSafeTelephonyReturnTo("//evil.com", origin)).toBeNull();
    expect(getSafeTelephonyReturnTo("https://evil.com", origin)).toBeNull();
    expect(getSafeTelephonyReturnTo("/leads//evil.com", origin)).toBeNull();
  });
});

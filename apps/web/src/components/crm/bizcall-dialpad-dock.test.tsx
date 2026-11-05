import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dockMocks = vi.hoisted(() => ({
  clientConfig: vi.fn(),
  dialpadCallStarted: vi.fn(),
  dialpadEvent: vi.fn(),
  dialHandler: undefined as undefined | ((request: { leadId: string; phoneField: "phone"; leadName: string; taskId?: string }) => Promise<unknown>),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/leads" }));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    user: { id: "agent-1" },
    tenant: { id: "tenant-1" },
    isLoading: false,
    isAuthenticated: true,
    isAdmin: true,
    isSuperAdmin: false,
    hasEffectivePermission: () => true,
  }),
}));
vi.mock("@/lib/api", () => ({
  impersonationMeta: () => null,
  telephonyDialpadApi: {
    clientConfig: dockMocks.clientConfig,
    dialpadCallStarted: dockMocks.dialpadCallStarted,
    dialpadEvent: dockMocks.dialpadEvent,
  },
}));
vi.mock("@/lib/telephony-client", () => ({
  registerDialerCommandHandler: vi.fn(() => () => undefined),
  registerTelephonyDialHandler: (handler: typeof dockMocks.dialHandler) => {
    dockMocks.dialHandler = handler;
    return () => { dockMocks.dialHandler = undefined; };
  },
  setTelephonyStatus: vi.fn(),
  setTelephonyNumberMasking: vi.fn(),
}));

import { BizcallDialpadDock } from "./bizcall-dialpad-dock";

const baseDialpadUrl = "https://bizcall.cxteletech.com/embed/dialpad?userId=agent-1&theme=light";
const callUrl = `${baseDialpadUrl}&number=%2B14155552671&autocall=false`;

function callStartedResponse(dialpadUrl = callUrl) {
  return {
    data: {
      data: {
        callDetailId: "call-detail-1",
        number: "+14155552671",
        leadName: "Lead One",
        recordId: "lead-1",
        tenantId: "tenant-1",
        dialpadUrl,
      },
    },
  };
}

describe("BizcallDialpadDock dialpad URL flow", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
    dockMocks.clientConfig.mockReset().mockResolvedValue({
      data: { data: {
        active: true,
        dialpadUrl: baseDialpadUrl,
        dialpadOrigin: "https://bizcall.cxteletech.com",
        dialpadMode: "DOCKED",
        theme: "CRM",
        defaultDockState: "EXPANDED",
        maskNumbers: false,
        sendTenantIdInDial: true,
        autoDialOnClick: false,
      } },
    });
    dockMocks.dialpadCallStarted.mockReset().mockResolvedValue(callStartedResponse());
    dockMocks.dialpadEvent.mockReset().mockResolvedValue({ data: { success: true } });
    dockMocks.dialHandler = undefined;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("uses one server validation request and loads the returned URL without REST calls or DIAL messages", async () => {
    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });
    expect(await screen.findByTitle("Bizcall dialpad")).toBeInTheDocument();

    let result: unknown;
    await act(async () => {
      result = await dockMocks.dialHandler?.({ leadId: "lead-1", phoneField: "phone", leadName: "Lead One" });
    });
    expect(result).toMatchObject({ ok: true, code: "NUMBER_LOADED", step: "prepared_in_dialpad" });
    expect(dockMocks.dialpadCallStarted).toHaveBeenCalledOnce();
    expect(dockMocks.dialpadCallStarted).toHaveBeenCalledWith({ leadId: "lead-1", phoneField: "phone" });
    expect(dockMocks.dialpadEvent).not.toHaveBeenCalled();
    expect(screen.getByTitle("Bizcall dialpad")).toHaveAttribute("src", callUrl);
    expect(screen.getByText("Connecting dialpad. Call duration and disposition will appear after Bizcall syncs.")).toBeInTheDocument();
  });

  it("opens a named blank tab synchronously in new-tab mode and navigates to the validated response", async () => {
    dockMocks.clientConfig.mockResolvedValue({
      data: { data: {
        active: true,
        dialpadUrl: baseDialpadUrl,
        dialpadOrigin: "https://bizcall.cxteletech.com",
        dialpadMode: "NEW_TAB",
        theme: "CRM",
        defaultDockState: "COLLAPSED",
        maskNumbers: false,
        sendTenantIdInDial: true,
        autoDialOnClick: false,
      } },
    });
    const popup = {
      closed: false,
      focus: vi.fn(),
      location: { replace: vi.fn() },
    };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });

    let callPromise: Promise<unknown> | undefined;
    act(() => {
      callPromise = dockMocks.dialHandler?.({ leadId: "lead-1", phoneField: "phone", leadName: "Lead One" });
    });
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("about:blank", "bizcall-dialpad");
    await act(async () => { await callPromise; });
    expect(popup.location.replace).toHaveBeenCalledWith(callUrl);
    expect(screen.queryByTitle("Bizcall dialpad")).not.toBeInTheDocument();
    open.mockRestore();
  });

  it("does not navigate on a refused server check and closes the synchronous popup", async () => {
    dockMocks.clientConfig.mockResolvedValue({
      data: { data: {
        active: true,
        dialpadUrl: baseDialpadUrl,
        dialpadOrigin: "https://bizcall.cxteletech.com",
        dialpadMode: "NEW_TAB",
        theme: "CRM",
        defaultDockState: "COLLAPSED",
        maskNumbers: false,
        sendTenantIdInDial: true,
        autoDialOnClick: false,
      } },
    });
    const popup = { closed: false, close: vi.fn(), focus: vi.fn(), location: { replace: vi.fn() } };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    dockMocks.dialpadCallStarted.mockRejectedValue({
      response: { data: { code: "DO_NOT_CALL", message: "This number is on the Do-Not-Call list." } },
    });
    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });

    await act(async () => {
      await dockMocks.dialHandler?.({ leadId: "lead-1", phoneField: "phone", leadName: "Lead One" });
    });
    expect(popup.close).toHaveBeenCalledOnce();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(dockMocks.dialpadCallStarted).toHaveBeenCalledOnce();
  });

  it("shows a microphone warning only for messages from the trusted dialpad window and origin", async () => {
    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });
    const iframe = await screen.findByTitle("Bizcall dialpad") as HTMLIFrameElement;
    fireEvent.load(iframe);

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://untrusted.example",
        source: iframe.contentWindow,
        data: { type: "BIZCALL_MICROPHONE_ERROR", error: { name: "NotAllowedError" } },
      }));
    });
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://bizcall.cxteletech.com",
        source: iframe.contentWindow,
        data: { type: "BIZCALL_MICROPHONE_ERROR", error: { name: "NotAllowedError" } },
      }));
    });
    await waitFor(() => expect(screen.getByText(
      "The browser blocked the microphone for this site. Click the lock icon in the address bar, set Microphone to Allow, and reload.",
    )).toBeInTheDocument());
  });
});

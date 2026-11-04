import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dockMocks = vi.hoisted(() => ({
  clientConfig: vi.fn(),
  dialpadCallStarted: vi.fn(),
  dialpadEvent: vi.fn(),
  placeLeadCall: vi.fn(),
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
  clickToCallApi: {
    clientConfig: dockMocks.clientConfig,
    dialpadCallStarted: dockMocks.dialpadCallStarted,
    dialpadEvent: dockMocks.dialpadEvent,
  },
}));
vi.mock("@/lib/click-to-call", () => ({
  placeLeadCall: dockMocks.placeLeadCall,
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

describe("BizcallDialpadDock blocked state", () => {
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
      data: {
        data: {
          active: true,
          dialpadUrl: "https://bizcall.cxteletech.com/embed/dialpad",
          dialpadOrigin: "https://bizcall.cxteletech.com",
          dialpadMode: "DOCKED",
          callMethod: "SERVER_API",
          theme: "CRM",
          defaultDockState: "EXPANDED",
          maskNumbers: false,
          sendTenantIdInDial: true,
          autoDialOnClick: true,
        },
      },
    });
    dockMocks.placeLeadCall.mockReset();
    dockMocks.dialpadCallStarted.mockReset();
    dockMocks.dialpadEvent.mockReset().mockResolvedValue({ data: { success: true } });
    dockMocks.dialHandler = undefined;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not require the dialpad to be online for the Server API method", async () => {
    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });
    expect(screen.getByTitle("Bizcall dialpad")).toBeInTheDocument();
    const iframe = screen.getByTitle("Bizcall dialpad") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);

    dockMocks.placeLeadCall.mockResolvedValue({
      ok: true, code: "INITIATED", step: "sent_to_provider", message: "sent",
      ignored: false, callDetailId: "call-rest", leadStatus: null, statusChanged: false, leadName: "Lead One",
    });
    await act(async () => {
      await dockMocks.dialHandler?.({ leadId: "lead-1", phoneField: "phone", leadName: "Lead One" });
    });
    expect(dockMocks.placeLeadCall).toHaveBeenCalledTimes(1);
    expect(dockMocks.dialpadCallStarted).not.toHaveBeenCalled();
    expect(postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === "DIAL")).toHaveLength(0);
  });

  it("shows a microphone permission banner only for trusted Bizcall error messages", async () => {
    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });
    const iframe = screen.getByTitle("Bizcall dialpad") as HTMLIFrameElement;
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
    expect(screen.getByText(
      "The browser blocked the microphone for this site. Click the lock icon in the address bar, set Microphone to Allow, and reload.",
    )).toBeInTheDocument();
  });

  it("authorizes through the server and sends one exact DIAL only after registration", async () => {
    dockMocks.clientConfig.mockResolvedValue({
      data: { data: {
        active: true,
        dialpadUrl: "https://bizcall.cxteletech.com/embed/dialpad",
        dialpadOrigin: "https://bizcall.cxteletech.com",
        dialpadMode: "DOCKED",
        callMethod: "DIALPAD_MESSAGE",
        theme: "CRM",
        defaultDockState: "EXPANDED",
        maskNumbers: false,
        sendTenantIdInDial: true,
        autoDialOnClick: true,
      } },
    });
    dockMocks.dialpadCallStarted.mockResolvedValue({ data: { data: {
      allowed: true,
      callDetailId: "call-1",
      normalizedNumber: "+12125550123",
      leadName: "Test Lead",
      recordId: "lead-1",
      taskId: "followup-1",
      tenantId: "tenant-from-session",
    } } });

    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });
    const iframe = screen.getByTitle("Bizcall dialpad") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);

    let result: unknown;
    let clickPromise: Promise<unknown> | undefined;
    await act(async () => {
      clickPromise = dockMocks.dialHandler?.({
        leadId: "lead-1",
        phoneField: "phone",
        leadName: "Test Lead",
        taskId: "followup-1",
      });
      await Promise.resolve();
    });
    expect(dockMocks.dialpadCallStarted).toHaveBeenCalledWith({
      leadId: "lead-1",
      phoneField: "phone",
      taskId: "followup-1",
    });
    expect(postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === "DIAL")).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://bizcall.cxteletech.com",
        source: iframe.contentWindow,
        data: { type: "BIZCALL_AGENT_REGISTERED", name: "Agent", extension: "101" },
      }));
      await Promise.resolve();
    });
    await act(async () => {
      result = await clickPromise;
    });
    await waitFor(() => {
      expect(postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === "DIAL")).toHaveLength(1);
    });
    expect(result).toMatchObject({ ok: true, code: "INITIATED" });
    expect(postMessage).toHaveBeenCalledWith({
      type: "DIAL",
      number: "+12125550123",
      recordId: "lead-1",
      leadName: "Test Lead",
      taskId: "followup-1",
      tenantId: "tenant-from-session",
    }, "https://bizcall.cxteletech.com");
    expect(dockMocks.placeLeadCall).not.toHaveBeenCalled();
  });

  it("does not send DIAL when server validation refuses the click", async () => {
    dockMocks.clientConfig.mockResolvedValue({
      data: { data: {
        active: true, dialpadUrl: "https://bizcall.cxteletech.com/embed/dialpad",
        dialpadOrigin: "https://bizcall.cxteletech.com", dialpadMode: "DOCKED",
        callMethod: "DIALPAD_MESSAGE", theme: "CRM", defaultDockState: "EXPANDED",
        maskNumbers: false, sendTenantIdInDial: true, autoDialOnClick: true,
      } },
    });
    dockMocks.dialpadCallStarted.mockRejectedValue({
      response: { data: { message: "This number is on the Do-Not-Call list." } },
    });
    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });
    const iframe = screen.getByTitle("Bizcall dialpad") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    await act(async () => {
      await dockMocks.dialHandler?.({ leadId: "lead-dnc", phoneField: "phone", leadName: "Lead" });
    });
    expect(postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === "DIAL")).toHaveLength(0);
    expect(dockMocks.placeLeadCall).not.toHaveBeenCalled();
  });

  it("keeps an authorized DIAL queued after five seconds and retries without a second server request", async () => {
    vi.useFakeTimers();
    dockMocks.clientConfig.mockResolvedValue({
      data: { data: {
        active: true, dialpadUrl: "https://bizcall.cxteletech.com/embed/dialpad",
        dialpadOrigin: "https://bizcall.cxteletech.com", dialpadMode: "DOCKED",
        callMethod: "DIALPAD_MESSAGE", theme: "CRM", defaultDockState: "EXPANDED",
        maskNumbers: false, sendTenantIdInDial: true, autoDialOnClick: true,
      } },
    });
    dockMocks.dialpadCallStarted.mockResolvedValue({ data: { data: {
      allowed: true, callDetailId: "call-retry", normalizedNumber: "+12125550123",
      leadName: "Test Lead", recordId: "lead-retry", tenantId: "tenant-1",
    } } });
    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });
    const iframe = screen.getByTitle("Bizcall dialpad") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);

    let clickPromise: Promise<unknown> | undefined;
    await act(async () => {
      clickPromise = dockMocks.dialHandler?.({ leadId: "lead-retry", phoneField: "phone", leadName: "Test Lead" });
      await Promise.resolve();
    });
    expect(dockMocks.dialpadCallStarted).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    let result: unknown;
    await act(async () => {
      result = await clickPromise;
    });
    expect(result).toMatchObject({ ok: false, code: "DIALPAD_CONNECTING" });
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === "DIAL")).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://bizcall.cxteletech.com",
        source: iframe.contentWindow,
        data: { type: "BIZCALL_AGENT_REGISTERED", name: "Agent", extension: "101" },
      }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dockMocks.dialpadCallStarted).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === "DIAL")).toHaveLength(1);
  });

  it("prefills the iframe without DIAL when Auto-dial on click is off", async () => {
    dockMocks.clientConfig.mockResolvedValue({
      data: { data: {
        active: true, dialpadUrl: "https://bizcall.cxteletech.com/embed/dialpad",
        dialpadOrigin: "https://bizcall.cxteletech.com", dialpadMode: "DOCKED",
        callMethod: "DIALPAD_MESSAGE", theme: "CRM", defaultDockState: "EXPANDED",
        maskNumbers: false, sendTenantIdInDial: true, autoDialOnClick: false,
      } },
    });
    dockMocks.dialpadCallStarted.mockResolvedValue({ data: { data: {
      allowed: true, callDetailId: "call-prefill", normalizedNumber: "+12125550123",
      leadName: "Test Lead", recordId: "lead-prefill", tenantId: "tenant-1",
    } } });
    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });
    const iframe = screen.getByTitle("Bizcall dialpad") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    await act(async () => {
      await dockMocks.dialHandler?.({ leadId: "lead-prefill", phoneField: "phone", leadName: "Test Lead" });
    });
    expect(new URL(iframe.src).searchParams.get("number")).toBe("+12125550123");
    expect(screen.getByText("Number is ready in the dialpad. Press the green call button to place the call.")).toBeInTheDocument();
    expect(postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === "DIAL")).toHaveLength(0);
    expect(dockMocks.placeLeadCall).not.toHaveBeenCalled();
  });

  it("sends DIAL to the named new-tab window with the configured origin", async () => {
    const targetPostMessage = vi.fn();
    const target = { closed: false, postMessage: targetPostMessage } as unknown as WindowProxy;
    const open = vi.spyOn(window, "open").mockReturnValue(target);
    dockMocks.clientConfig.mockResolvedValue({
      data: { data: {
        active: true, dialpadUrl: "https://bizcall.cxteletech.com/embed/dialpad",
        dialpadOrigin: "https://bizcall.cxteletech.com", dialpadMode: "NEW_TAB",
        callMethod: "DIALPAD_MESSAGE", theme: "CRM", defaultDockState: "EXPANDED",
        maskNumbers: false, sendTenantIdInDial: false, autoDialOnClick: true,
      } },
    });
    dockMocks.dialpadCallStarted.mockResolvedValue({ data: { data: {
      allowed: true, callDetailId: "call-new-tab", normalizedNumber: "+12125550123",
      leadName: "Test Lead", recordId: "lead-new-tab", tenantId: "tenant-from-session",
    } } });
    await act(async () => {
      render(<BizcallDialpadDock />);
      await Promise.resolve();
    });

    let callPromise: Promise<unknown> | undefined;
    await act(async () => {
      callPromise = dockMocks.dialHandler?.({
        leadId: "lead-new-tab",
        phoneField: "phone",
        leadName: "Test Lead",
      });
      await Promise.resolve();
    });
    expect(open).toHaveBeenCalledWith(
      "https://bizcall.cxteletech.com/embed/dialpad?userId=agent-1&theme=light",
      expect.stringContaining("bizcall-dialpad"),
    );

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://bizcall.cxteletech.com",
        source: target,
        data: { type: "BIZCALL_AGENT_REGISTERED", name: "Agent", extension: "101" },
      }));
      await Promise.resolve();
    });
    await act(async () => {
      await callPromise;
    });
    expect(targetPostMessage).toHaveBeenCalledWith({ type: "INIT_USER", userId: "agent-1" }, "https://bizcall.cxteletech.com");
    expect(targetPostMessage).toHaveBeenCalledWith({
      type: "DIAL",
      number: "+12125550123",
      recordId: "lead-new-tab",
      leadName: "Test Lead",
    }, "https://bizcall.cxteletech.com");
    expect(targetPostMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === "DIAL")).toHaveLength(1);
    expect(dockMocks.placeLeadCall).not.toHaveBeenCalled();
    open.mockRestore();
    open.mockRestore();
  });
});

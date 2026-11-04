"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Phone, RefreshCw, X } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { clickToCallApi, impersonationMeta } from "@/lib/api";
import {
  buildBizcallDialpadUrl,
  buildBizcallNamespaceKey,
  BIZCALL_DIALPAD_WINDOW_NAME,
  claimDialpadLock,
  isDialpadLockStale,
  isTrustedBizcallMessage,
  openBizcallDialpad,
  maskDialpadNumber,
  readDialpadLock,
  recordDialpadMonitorEntry,
  sanitizeDialpadFields,
  sendDialerCommand,
  type DialerCommand,
} from "@/lib/bizcall-dialpad";
import { placeLeadCall, type ClickToCallOutcome } from "@/lib/click-to-call";
import { registerDialerCommandHandler, registerTelephonyDialHandler, setTelephonyNumberMasking, setTelephonyStatus } from "@/lib/telephony-client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type DialpadConfig = {
  active: boolean;
  dialpadUrl: string;
  dialpadOrigin: string;
  dialpadMode: "DOCKED" | "NEW_TAB";
  callMethod: "SERVER_API" | "DIALPAD_MESSAGE";
  theme: "CRM" | "LIGHT" | "DARK";
  defaultDockState: "COLLAPSED" | "EXPANDED";
  maskNumbers: boolean;
  sendTenantIdInDial: boolean;
  autoDialOnClick: boolean;
};

type DialRequest = { leadId: string; phoneField: "phone" | "mobile" | "secondaryPhone"; leadName: string; taskId?: string };
type MessageData = {
  type?: unknown;
  name?: unknown;
  errorName?: unknown;
  error?: unknown;
  message?: unknown;
  extension?: unknown;
  number?: unknown;
  leadName?: unknown;
  callUuid?: unknown;
  duration?: unknown;
  durationFormatted?: unknown;
  disposition?: unknown;
  notes?: unknown;
  [key: string]: unknown;
};

const BIZCALL_EVENTS = [
  "BIZCALL_AGENT_REGISTERED",
  "BIZCALL_CALL_STARTING",
  "BIZCALL_CALL_CONNECTED",
  "BIZCALL_CALL_ENDED",
  "BIZCALL_DISPOSITION_SUBMITTED",
] as const;
type BizcallEventName = (typeof BIZCALL_EVENTS)[number];

function isBizcallEventName(value: unknown): value is BizcallEventName {
  return typeof value === "string" && (BIZCALL_EVENTS as readonly string[]).includes(value);
}

const LOCK_HEARTBEAT_MS = 2_000;
const LOCK_STALE_MS = 5_000;

function outcome(ok: boolean, code: string, message: string, step: ClickToCallOutcome["step"] = "blocked_before_send", callDetailId: string | null = null): ClickToCallOutcome {
  return { ok, code, message, step, ignored: false, callDetailId, leadStatus: null, statusChanged: false, leadName: null };
}

function safeText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, limit) : "";
}

function formatCallDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function dialpadUrlFor(config: DialpadConfig, userId: string, number?: string) {
  return buildBizcallDialpadUrl(config.dialpadUrl, userId, config.theme, number);
}

function openDialpadTab(config: DialpadConfig, userId: string, tenantId: string, number?: string) {
  return openBizcallDialpad(config.dialpadUrl, userId, tenantId, config.theme, (url, target) => window.open(url, target), number);
}

export function BizcallDialpadDock() {
  const pathname = usePathname();
  const { toast } = useToast();
  const { user, tenant, isLoading, isAuthenticated, hasEffectivePermission, refresh } = useAuth();
  const showOnPage = !pathname.startsWith("/setup") || pathname === "/setup/integrations/telephony";
  const allowed = hasEffectivePermission("TELEPHONY_CALL");
  const impersonating = Boolean(user?.impersonatedBy || impersonationMeta());
  const tenantId = tenant?.id || "";
  const [config, setConfig] = React.useState<DialpadConfig | null>(null);
  const [reasonCode, setReasonCode] = React.useState("NOT_CONFIGURED");
  const [secureTransport, setSecureTransport] = React.useState(true);
  const [expanded, setExpanded] = React.useState(false);
  const [dockOpen, setDockOpen] = React.useState(true);
  const [online, setOnline] = React.useState(false);
  const [extension, setExtension] = React.useState("");
  const [agentName, setAgentName] = React.useState("");
  const [callNumber, setCallNumber] = React.useState("");
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const [endedSummary, setEndedSummary] = React.useState("");
  const [disposition, setDisposition] = React.useState("");
  const [dispositionNotes, setDispositionNotes] = React.useState("");
  const [iframeLoaded, setIframeLoaded] = React.useState(false);
  const [callState, setCallState] = React.useState("Connecting");
  const [activeCall, setActiveCall] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [statusMessage, setStatusMessage] = React.useState("");
  const [microphoneBlocked, setMicrophoneBlocked] = React.useState(false);
  const [prefillNumber, setPrefillNumber] = React.useState("");
  const [ownsLock, setOwnsLock] = React.useState(false);
  const [otherTab, setOtherTab] = React.useState(false);
  const [takingOver, setTakingOver] = React.useState(false);
  const [blocked, setBlocked] = React.useState(false);
  const [iframeGeneration, setIframeGeneration] = React.useState(0);
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const dialpadTabRef = React.useRef<WindowProxy | null>(null);
  const dialpadTabReadyRef = React.useRef(false);
  const forceTabTargetRef = React.useRef(false);
  const permissionRefreshRequestedRef = React.useRef(false);
  const onlineRef = React.useRef(false);
  const callInProgressRef = React.useRef(false);
  const closeAfterHangupRef = React.useRef(false);
  const waiterRef = React.useRef<(() => void) | null>(null);
  const configRef = React.useRef<DialpadConfig | null>(null);
  const userIdRef = React.useRef(user?.id || "");
  const activeCallRef = React.useRef<{
    leadId: string;
    leadName: string;
    taskId?: string;
    number: string;
    callUuid?: string;
    callDetailId?: string;
  } | null>(null);
  const queuedDialRef = React.useRef<DialerCommand | null>(null);
  const activeCallTimerRef = React.useRef<number | null>(null);
  const tabIdRef = React.useRef("");
  const lockOwnerRef = React.useRef(false);
  const dockedDialpadUrl = config?.dialpadMode === "DOCKED" ? dialpadUrlFor(config, user?.id || "", prefillNumber || undefined) : null;
  const lockEnabled = Boolean(config?.active && (config.dialpadMode === "DOCKED" || config.callMethod === "DIALPAD_MESSAGE"));

  const sendCommand = React.useCallback((command: DialerCommand, justLoaded = false) => {
    if (command.type !== "BIZCALL_HANGUP" && (!allowed || impersonating)) {
      return { ok: false, reason: "NO_PERMISSION" };
    }
    const useTabTarget = configRef.current?.dialpadMode === "NEW_TAB" || forceTabTargetRef.current;
    const target = useTabTarget ? dialpadTabRef.current : frameRef.current?.contentWindow;
    if (useTabTarget && (!target || target.closed)) {
      dialpadTabReadyRef.current = false;
      onlineRef.current = false;
      setOnline(false);
      setStatusMessage("The Bizcall dialpad tab is closed. Open it again and retry.");
      return { ok: false, reason: "IFRAME_NOT_READY" };
    }
    const result = sendDialerCommand(
      target,
      configRef.current?.dialpadOrigin || "",
      useTabTarget ? dialpadTabReadyRef.current || justLoaded : iframeLoaded || justLoaded,
      command,
    );
    if (result.ok && user?.id && tenantId) {
      const { type, ...fields } = command;
      recordDialpadMonitorEntry(tenantId, user.id, {
        direction: "command",
        name: type,
        leadId: command.type === "DIAL" ? command.recordId : null,
        fields,
      });
    }
    return result;
  }, [allowed, iframeLoaded, impersonating, tenantId, user?.id]);

  const sendCommandRef = React.useRef(sendCommand);
  sendCommandRef.current = sendCommand;

  React.useEffect(() => registerDialerCommandHandler(sendCommand), [sendCommand]);

  React.useEffect(() => {
    onlineRef.current = online;
  }, [online]);
  React.useEffect(() => {
    configRef.current = config;
  }, [config]);
  React.useEffect(() => {
    userIdRef.current = user?.id || "";
  }, [user?.id]);

  React.useEffect(() => {
    const blockedDialpad = Boolean(blocked && config?.callMethod === "DIALPAD_MESSAGE");
    const insecureDialpad = Boolean(!secureTransport && config?.callMethod === "DIALPAD_MESSAGE");
    setTelephonyStatus(
      Boolean(isAuthenticated && allowed && config?.active && !impersonating && !blockedDialpad && !insecureDialpad),
      impersonating
        ? "IMPERSONATING"
        : reasonCode === "PERMISSION_UNAVAILABLE"
          ? reasonCode
          : !isAuthenticated
            ? "NOT_CONFIGURED"
            : !allowed
              ? "NO_PERMISSION"
              : insecureDialpad
                ? "HTTPS_REQUIRED"
                : blockedDialpad
                  ? "DIALPAD_EMBED_BLOCKED"
                  : config?.active
                    ? "ACTIVE"
                    : reasonCode,
    );
    setTelephonyNumberMasking(Boolean(isAuthenticated && allowed && config?.active && !impersonating && config.maskNumbers));
    return () => {
      setTelephonyStatus(false, "NOT_CONFIGURED");
      setTelephonyNumberMasking(false);
    };
  }, [allowed, blocked, config?.active, config?.callMethod, config?.maskNumbers, impersonating, isAuthenticated, reasonCode, secureTransport]);

  React.useLayoutEffect(() => {
    return () => {
      if (callInProgressRef.current) sendCommandRef.current({ type: "BIZCALL_HANGUP" });
      if (activeCallTimerRef.current !== null) window.clearInterval(activeCallTimerRef.current);
      activeCallRef.current = null;
      callInProgressRef.current = false;
      closeAfterHangupRef.current = false;
      queuedDialRef.current = null;
      dialpadTabRef.current = null;
      dialpadTabReadyRef.current = false;
      forceTabTargetRef.current = false;
    };
  }, [allowed, config?.active, impersonating, isAuthenticated, tenantId, user?.id]);

  React.useEffect(() => {
    if (!isAuthenticated || impersonating || !user?.id || !tenantId) {
      activeCallRef.current = null;
      callInProgressRef.current = false;
      closeAfterHangupRef.current = false;
      queuedDialRef.current = null;
      setActiveCall(false);
      setCallNumber("");
      setElapsedSeconds(0);
      setEndedSummary("");
      setDisposition("");
      setDispositionNotes("");
      setCallState("Connecting");
      setIframeLoaded(false);
      onlineRef.current = false;
      setOnline(false);
      return;
    }
    activeCallRef.current = null;
    callInProgressRef.current = false;
    closeAfterHangupRef.current = false;
    queuedDialRef.current = null;
    setActiveCall(false);
    setCallNumber("");
    setElapsedSeconds(0);
    setEndedSummary("");
    setDisposition("");
    setDispositionNotes("");
    setCallState("Connecting");
    setIframeLoaded(false);
    onlineRef.current = false;
    setOnline(false);
    dialpadTabRef.current = null;
    dialpadTabReadyRef.current = false;
    forceTabTargetRef.current = false;
    setIframeGeneration((generation) => generation + 1);
  }, [impersonating, isAuthenticated, tenantId, user?.id]);

  React.useEffect(() => {
    if (!activeCall || callState !== "Connected") return;
    activeCallTimerRef.current = window.setInterval(() => setElapsedSeconds((value) => value + 1), 1000);
    return () => {
      if (activeCallTimerRef.current !== null) window.clearInterval(activeCallTimerRef.current);
      activeCallTimerRef.current = null;
    };
  }, [activeCall, callState]);

  React.useEffect(() => {
    if (typeof window !== "undefined") {
      const hostname = window.location.hostname.toLowerCase();
      const isLocal = process.env.NODE_ENV !== "production" && (
        hostname === "localhost" || hostname === "::1" ||
        (hostname.split(".").length === 4 && Number(hostname.split(".")[0]) === 127)
      );
      setSecureTransport(window.location.protocol === "https:" || isLocal);
    }
    if (isLoading) return;
    if (!isAuthenticated) {
      setConfig(null);
      setOnline(false);
      setReasonCode("NOT_CONFIGURED");
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const response = await clickToCallApi.clientConfig();
        if (!active) return;
        const data = response.data.data as DialpadConfig & { reasonCode?: string; permissionGranted?: boolean };
        if (data?.permissionGranted && !allowed && !permissionRefreshRequestedRef.current) {
          permissionRefreshRequestedRef.current = true;
          await refresh();
        } else if (!data?.permissionGranted || allowed) {
          permissionRefreshRequestedRef.current = false;
        }
        if (data?.active && data.dialpadUrl && new URL(data.dialpadUrl).origin === data.dialpadOrigin) {
          setConfig(data);
            setReasonCode("ACTIVE");
            if (!configRef.current) setExpanded(data.defaultDockState === "EXPANDED");
        } else {
            setConfig(null);
            setOnline(false);
            setReasonCode(data?.reasonCode || "CONFIG_UNAVAILABLE");
        }
      } catch (error: unknown) {
        if (active) {
            setConfig(null);
            setOnline(false);
            const responseCode = error && typeof error === "object" && "response" in error
              ? (error as { response?: { data?: { code?: string } } }).response?.data?.code
              : undefined;
            setReasonCode(responseCode === "TELEPHONY_CONFIG_UNAVAILABLE" ? "SETTINGS_UNAVAILABLE" : "PROXY_UNAVAILABLE");
        }
      }
    };
    void load();
    const isLeadPage = pathname === "/leads" || pathname.startsWith("/leads/");
    const refreshInterval = isLeadPage && (!allowed || reasonCode === "PERMISSION_UNAVAILABLE") ? 5_000 : 30_000;
    const refreshTimer = window.setInterval(() => void load(), refreshInterval);
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
    };
  }, [allowed, isAuthenticated, isLoading, pathname, reasonCode, refresh]);

  React.useEffect(() => {
    if (!lockEnabled || !user?.id || !tenantId || !showOnPage || impersonating) {
      setOwnsLock(false);
      setOtherTab(false);
      return;
    }
    const key = buildBizcallNamespaceKey(tenantId, user.id, "lock");
    const tabId = tabIdRef.current || (tabIdRef.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(buildBizcallNamespaceKey(tenantId, user.id, "channel")) : null;
    const setOwnership = (owns: boolean) => {
      lockOwnerRef.current = owns;
      setOwnsLock(owns);
      setOtherTab(!owns);
      if (owns) setTakingOver(false);
    };
    const getLock = () => readDialpadLock(localStorage, key);
    const claimOrHeartbeat = () => {
      const current = getLock();
      const stale = isDialpadLockStale(current, Date.now(), LOCK_STALE_MS);
      if (current?.ownerId === tabId || stale) {
        const acquired = claimDialpadLock(localStorage, key, tabId, Date.now(), LOCK_STALE_MS);
        setOwnership(acquired);
        if (acquired) channel?.postMessage({ type: "heartbeat", ownerId: tabId, heartbeatAt: Date.now() });
        if (!acquired) setStatusMessage("Cross-tab protection is unavailable. Use one CRM tab for the dialpad.");
        return acquired;
      }
      setOwnership(false);
      return false;
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      const current = getLock();
      if (current?.ownerId !== tabId) setOwnership(false);
      else setOwnership(true);
    };
    const releaseOnPageHide = () => {
      if (getLock()?.ownerId === tabId) {
        localStorage.removeItem(key);
        channel?.postMessage({ type: "released", ownerId: tabId });
      }
    };
    const onBroadcast = (event: MessageEvent<{ type?: string; ownerId?: string; requesterId?: string }>) => {
      const message = event.data;
      if (message?.type === "takeover" && lockOwnerRef.current && message.requesterId && message.requesterId !== tabId) {
        const current = getLock();
        if (current?.ownerId === tabId) localStorage.removeItem(key);
        channel?.postMessage({ type: "released", ownerId: tabId });
        setOwnership(false);
        return;
      }
      if (["heartbeat", "released"].includes(message?.type || "") && message.ownerId !== tabId) {
        const current = getLock();
        if (current?.ownerId !== tabId) setOwnership(false);
      }
    };
    setOwnership(claimOrHeartbeat());
    const heartbeatTimer = window.setInterval(() => {
      if (lockOwnerRef.current || isDialpadLockStale(getLock(), Date.now(), LOCK_STALE_MS)) claimOrHeartbeat();
    }, LOCK_HEARTBEAT_MS);
    const staleLockTimer = window.setInterval(() => {
      if (!lockOwnerRef.current && isDialpadLockStale(getLock(), Date.now(), LOCK_STALE_MS)) claimOrHeartbeat();
    }, 250);
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", releaseOnPageHide);
    channel?.addEventListener("message", onBroadcast);
    return () => {
      window.clearInterval(heartbeatTimer);
      window.clearInterval(staleLockTimer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", releaseOnPageHide);
      try {
        if (getLock()?.ownerId === tabId) localStorage.removeItem(key);
      } catch { /* local storage can be disabled by browser policy */ }
      channel?.removeEventListener("message", onBroadcast);
      channel?.close();
      lockOwnerRef.current = false;
    };
  }, [impersonating, lockEnabled, showOnPage, tenantId, user?.id]);

  const queueDialUntilRegistered = React.useCallback(async (command: DialerCommand) => {
    if (command.type !== "DIAL") return false;
    const targetReady = configRef.current?.dialpadMode === "NEW_TAB" || forceTabTargetRef.current
      ? dialpadTabReadyRef.current
      : iframeLoaded;
    if (onlineRef.current && targetReady) {
      const sent = sendCommand(command).ok;
      if (sent) {
        queuedDialRef.current = null;
      }
      return sent;
    }
    queuedDialRef.current = command;
    setStatusMessage("Dialpad is connecting. Allow the microphone if the browser asks.");
    return new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => {
        waiterRef.current = null;
        setStatusMessage("Dialpad is connecting. Allow the microphone if the browser asks.");
        resolve(false);
      }, 5000);
      waiterRef.current = () => {
        window.clearTimeout(timeout);
        waiterRef.current = null;
        const queued = queuedDialRef.current;
        queuedDialRef.current = null;
        resolve(queued?.type === "DIAL" && sendCommand(queued).ok);
      };
      const currentTargetReady = configRef.current?.dialpadMode === "NEW_TAB" || forceTabTargetRef.current
        ? dialpadTabReadyRef.current
        : iframeLoaded;
      if (onlineRef.current && currentTargetReady) waiterRef.current();
    });
  }, [iframeLoaded, sendCommand]);

  const placeRequest = React.useCallback(async (request: DialRequest): Promise<ClickToCallOutcome> => {
    const currentConfig = configRef.current;
    if (!currentConfig?.active) return outcome(false, "TELEPHONY_NOT_CONFIGURED", "Telephony is not active for this company.");
    if (impersonating) return outcome(false, "IMPERSONATION_DISABLED", "Calls are disabled while viewing as another user.");
    if (!allowed) return outcome(false, "NO_PERMISSION", "Telephony permission is required.");
    if (currentConfig.callMethod === "DIALPAD_MESSAGE" && !secureTransport) {
      return outcome(false, "HTTPS_REQUIRED", "Calls need HTTPS because browsers block the microphone on plain HTTP.");
    }
    if (busy || queuedDialRef.current) return outcome(false, "CALL_IN_PROGRESS", "A call request is already being prepared.");
    if (activeCall && !window.confirm("A call may still be in progress. Start another call anyway?")) {
      return outcome(false, "CALL_IN_PROGRESS", "The current call is still in progress.");
    }
    if (currentConfig.callMethod === "DIALPAD_MESSAGE" && !ownsLock) {
      setOtherTab(true);
      return outcome(false, "DIALPAD_IN_ANOTHER_TAB", "Dialpad is active in another CRM tab.");
    }
    setExpanded(true);
    setDockOpen(true);
    setStatusMessage("");
    if (
      currentConfig.callMethod === "DIALPAD_MESSAGE"
      && (currentConfig.dialpadMode === "NEW_TAB" || (currentConfig.dialpadMode === "DOCKED" && blocked))
    ) {
      const existingTab = dialpadTabRef.current;
      const tab = existingTab && !existingTab.closed
        ? existingTab
        : openDialpadTab(currentConfig, userIdRef.current, tenantId);
      if (!tab) {
        setBusy(false);
        setStatusMessage("The dialpad popup was blocked. Allow popups and retry, or use Open dialpad in a new tab.");
        return outcome(false, "DIALPAD_POPUP_BLOCKED", "The dialpad popup was blocked. Allow popups and retry.");
      }
      dialpadTabRef.current = tab;
      dialpadTabReadyRef.current = false;
      forceTabTargetRef.current = currentConfig.dialpadMode === "DOCKED";
    }
    if (currentConfig.callMethod === "SERVER_API") {
      setBusy(true);
      const result = await placeLeadCall(request.leadId, request.phoneField);
      setBusy(false);
      if (result.ok) {
        setActiveCall(true);
        setCallState("Calling");
        if (currentConfig.dialpadMode === "NEW_TAB") setStatusMessage("Keep the Bizcall dialpad tab open and allow the microphone.");
      }
      return result;
    }
    setBusy(true);
    try {
      const response = await clickToCallApi.dialpadCallStarted({
        leadId: request.leadId,
        phoneField: request.phoneField,
        ...(request.taskId ? { taskId: request.taskId } : {}),
      });
      const data = response.data.data as {
        allowed: boolean;
        callDetailId: string;
        normalizedNumber: string;
        leadName: string;
        recordId: string;
        taskId?: string;
        tenantId: string;
      };
      if (!data.allowed || !data.normalizedNumber || !/^\+[1-9]\d{1,14}$/.test(data.normalizedNumber) || !data.recordId || !data.tenantId) {
        setBusy(false);
        return outcome(false, "CALL_START_FAILED", "The server did not authorize this call.");
      }
      activeCallRef.current = {
        leadId: data.recordId,
        leadName: safeText(data.leadName || request.leadName, 200),
        taskId: data.taskId,
        number: data.normalizedNumber,
        callDetailId: data.callDetailId,
      };
      setCallNumber(data.normalizedNumber);
      setEndedSummary("");
      setElapsedSeconds(0);
      window.dispatchEvent(new CustomEvent("crm:call-details-updated", { detail: { leadId: data.recordId } }));
      if (!currentConfig.autoDialOnClick) {
        if (currentConfig.dialpadMode === "NEW_TAB" || forceTabTargetRef.current) {
          const tab = openDialpadTab(currentConfig, userIdRef.current, tenantId, data.normalizedNumber);
          if (!tab) {
            setBusy(false);
            setStatusMessage("The dialpad popup was blocked. Allow popups and retry.");
            return outcome(false, "DIALPAD_POPUP_BLOCKED", "The dialpad popup was blocked. Allow popups and retry.", "blocked_before_send", data.callDetailId);
          }
          dialpadTabRef.current = tab;
          dialpadTabReadyRef.current = false;
        } else {
          setPrefillNumber(data.normalizedNumber);
        }
        setBusy(false);
        setStatusMessage("Number is ready in the dialpad. Press the green call button to place the call.");
        return {
          ...outcome(true, "PREFILLED", "Number is ready in the dialpad. Press the green call button to place the call.", "prepared_in_dialpad", data.callDetailId),
          leadName: data.leadName,
        };
      }
      const command: DialerCommand = {
        type: "DIAL",
        number: data.normalizedNumber,
        recordId: data.recordId,
        leadName: safeText(data.leadName || request.leadName, 200),
        ...(data.taskId ? { taskId: data.taskId } : {}),
        ...(currentConfig.sendTenantIdInDial ? { tenantId: data.tenantId } : {}),
      };
      setPrefillNumber("");
      const sent = await queueDialUntilRegistered(command);
      if (!sent) {
        setBusy(false);
        return outcome(false, "DIALPAD_CONNECTING", "Dialpad is connecting. Allow the microphone if the browser asks.", "blocked_before_send", data.callDetailId);
      }
      setActiveCall(true);
      setCallState("Calling");
      setBusy(false);
      return outcome(true, "INITIATED", "Calling through the Bizcall dialpad.", "sent_to_provider", data.callDetailId);
    } catch (error) {
      setBusy(false);
      const body = (error as { response?: { data?: { message?: string } } })?.response?.data;
      return outcome(false, "DIALPAD_CALL_FAILED", body?.message || "The call could not be started.");
    }
  }, [activeCall, allowed, blocked, busy, impersonating, ownsLock, queueDialUntilRegistered, secureTransport, tenantId]);

  const retryQueuedDial = React.useCallback(async () => {
    const command = queuedDialRef.current;
    if (!command || command.type !== "DIAL" || busy) return;
    setBusy(true);
    const sent = await queueDialUntilRegistered(command);
    setBusy(false);
    if (!sent) return;
    setActiveCall(true);
    setCallState("Calling");
    setStatusMessage("");
  }, [busy, queueDialUntilRegistered]);

  React.useEffect(() => registerTelephonyDialHandler(placeRequest), [placeRequest]);

  React.useEffect(() => {
    const currentConfig = configRef.current;
    if (!currentConfig || !ownsLock || !showOnPage) return;
    const onMessage = (event: MessageEvent<MessageData>) => {
      const useTabTarget = currentConfig.dialpadMode === "NEW_TAB" || forceTabTargetRef.current;
      const expectedWindow = useTabTarget ? dialpadTabRef.current : frameRef.current?.contentWindow;
      if (!isTrustedBizcallMessage(event.origin, event.source, currentConfig.dialpadOrigin, expectedWindow) || !event.data) return;
      const message = event.data;
      const eventName = message.type;
      if (!isBizcallEventName(eventName)) {
        const errorObject = message.error && typeof message.error === "object"
          ? message.error as { name?: unknown; message?: unknown }
          : null;
        const errorName = message.errorName ?? errorObject?.name ?? message.name;
        const errorText = [message.error, message.message, errorObject?.message]
          .filter((value): value is string => typeof value === "string")
          .join(" ");
        if (errorName === "NotAllowedError" || /NotAllowedError/.test(errorText)) {
          setMicrophoneBlocked(true);
        }
        return;
      }
      let context = activeCallRef.current;
      if (eventName === "BIZCALL_CALL_STARTING" && !context) {
        context = {
          leadId: "",
          leadName: safeText(message.leadName, 200),
          number: typeof message.number === "string" ? message.number : "",
        };
        activeCallRef.current = context;
      }
      const rawNumber = typeof message.number === "string" && /^\+[1-9]\d{1,14}$/.test(message.number)
        ? message.number
        : context?.number || "";
      const rawDuration = typeof message.duration === "number" && Number.isFinite(message.duration)
        ? Math.max(0, Math.min(86_400, Math.floor(message.duration)))
        : undefined;
      const rawNotes = safeText(message.notes, 2000);
      const safeDisposition = safeText(message.disposition, 120);
      const safeCallUuid = safeText(message.callUuid, 255) || context?.callUuid || "";
      const safeRawFields = sanitizeDialpadFields(
        Object.fromEntries(Object.entries(message).filter(([key]) => key !== "type")),
      );
      const normalizedEvent = {
        event: eventName,
        receivedAt: new Date().toISOString(),
        tenantId,
        userId: user?.id || "",
        leadId: context?.leadId || null,
        callUuid: safeCallUuid || null,
        number: rawNumber ? maskDialpadNumber(rawNumber) : null,
        duration: rawDuration ?? null,
        disposition: safeDisposition || null,
        notes: rawNotes || null,
        rawFields: safeRawFields,
      };
      window.dispatchEvent(new CustomEvent("crm:bizcall-event", { detail: normalizedEvent }));
      if (tenantId && user?.id) {
        recordDialpadMonitorEntry(tenantId, user.id, {
          direction: "event",
          name: eventName,
          leadId: context?.leadId || null,
          fields: {
            ...normalizedEvent,
            notes: rawNotes ? "[redacted]" : "",
            ...Object.fromEntries(Object.entries(safeRawFields).map(([key, value]) => [`raw_${key}`, value])),
          },
        });
      }

      if (eventName === "BIZCALL_AGENT_REGISTERED") {
        if (useTabTarget) {
          dialpadTabReadyRef.current = true;
          sendCommandRef.current({ type: "INIT_USER", userId: user?.id || "" });
        }
        onlineRef.current = true;
        setOnline(true);
        setBlocked(false);
        setCallState("ONLINE");
        setExtension(safeText(message.extension, 40));
        setAgentName(safeText(message.name, 120));
        setStatusMessage((current) => current.startsWith("Dialpad is connecting") ? "" : current);
        if (queuedDialRef.current) {
          if (waiterRef.current) waiterRef.current();
          else setStatusMessage("Dialpad is ONLINE. Retry the pending call.");
        }
      }
      if (eventName === "BIZCALL_CALL_STARTING" && callState !== "Connected" && callState !== "Ended") {
        setElapsedSeconds(0);
        setEndedSummary("");
        setDisposition("");
        setDispositionNotes("");
        if (!activeCallRef.current && rawNumber) {
          activeCallRef.current = {
            leadId: "",
            leadName: safeText(message.leadName, 200),
            number: rawNumber,
            ...(safeCallUuid ? { callUuid: safeCallUuid } : {}),
          };
        }
        setCallNumber(rawNumber);
        setCallState("Calling");
        setActiveCall(true);
        callInProgressRef.current = true;
      } else if (eventName === "BIZCALL_CALL_CONNECTED" && callState !== "Ended") {
        if (activeCallRef.current && safeCallUuid) activeCallRef.current.callUuid = safeCallUuid;
        setCallNumber(rawNumber);
        setCallState("Connected");
        setActiveCall(true);
        callInProgressRef.current = true;
      } else if (eventName === "BIZCALL_CALL_ENDED") {
        if (activeCallTimerRef.current !== null) window.clearInterval(activeCallTimerRef.current);
        activeCallTimerRef.current = null;
        setElapsedSeconds(rawDuration || 0);
        setCallState("Ended");
        setActiveCall(false);
        callInProgressRef.current = false;
        const formatted = safeText(message.durationFormatted, 32) || formatCallDuration(rawDuration || 0);
        setEndedSummary(`${formatted}${context?.leadName ? ` · ${context.leadName}` : ""}`);
        if (closeAfterHangupRef.current) {
          closeAfterHangupRef.current = false;
          setIframeLoaded(false);
          setDockOpen(false);
        }
      } else if (eventName === "BIZCALL_DISPOSITION_SUBMITTED") {
        setDisposition(safeDisposition);
        setDispositionNotes(rawNotes);
        setStatusMessage("Disposition saved");
        toast({ title: "Disposition saved" });
        window.setTimeout(() => setStatusMessage((value) => value === "Disposition saved" ? "" : value), 3000);
      }

      if (eventName !== "BIZCALL_AGENT_REGISTERED") {
        const body = {
          event: eventName,
          ...(context?.leadId ? { leadId: context.leadId } : {}),
          ...(safeCallUuid ? { callUuid: safeCallUuid } : {}),
          ...(rawNumber ? { number: rawNumber } : {}),
          ...(rawDuration !== undefined ? { duration: rawDuration } : {}),
          ...(typeof message.durationFormatted === "string" ? { durationFormatted: safeText(message.durationFormatted, 32) } : {}),
          ...(safeDisposition ? { disposition: safeDisposition } : {}),
          ...(rawNotes ? { notes: rawNotes } : {}),
        };
        void clickToCallApi.dialpadEvent(body)
          .then(() => {
            if (context?.leadId) window.dispatchEvent(new CustomEvent("crm:call-details-updated", { detail: { leadId: context.leadId } }));
            if (eventName === "BIZCALL_DISPOSITION_SUBMITTED") activeCallRef.current = null;
          })
          .catch(() => setStatusMessage("Call event could not be saved. Refresh Call Details and try again."));
      } else {
        void clickToCallApi.dialpadEvent({
          event: eventName,
          name: safeText(message.name, 120),
          extension: safeText(message.extension, 40),
        }).catch(() => setStatusMessage("Dialpad registration could not be recorded."));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [callState, config, iframeGeneration, ownsLock, showOnPage, tenantId, toast, user?.id]);

  const resetDialpad = () => {
    if (activeCall) {
      setStatusMessage("End the active call before reloading the dialpad.");
      return;
    }
    onlineRef.current = false;
    setIframeLoaded(false);
    setOnline(false);
    setBlocked(false);
    setMicrophoneBlocked(false);
    forceTabTargetRef.current = false;
    dialpadTabReadyRef.current = false;
    dialpadTabRef.current = null;
    setCallState("Connecting");
    setStatusMessage("");
    setIframeGeneration((generation) => generation + 1);
  };

  const takeOverHere = () => {
    if (!user?.id || !tenantId) return;
    setTakingOver(true);
    setExpanded(true);
    const key = buildBizcallNamespaceKey(tenantId, user.id, "lock");
    try {
      const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(buildBizcallNamespaceKey(tenantId, user.id, "channel")) : null;
      channel?.postMessage({ type: "takeover", requesterId: tabIdRef.current });
      const acquired = claimDialpadLock(localStorage, key, tabIdRef.current, Date.now(), LOCK_STALE_MS);
      lockOwnerRef.current = acquired;
      setOwnsLock(acquired);
      setOtherTab(!acquired);
      if (!acquired) {
        const retryTakeover = (attempt: number) => window.setTimeout(() => {
          try {
            const tookOver = claimDialpadLock(localStorage, key, tabIdRef.current, Date.now(), LOCK_STALE_MS);
            lockOwnerRef.current = tookOver;
            setOwnsLock(tookOver);
            setOtherTab(!tookOver);
            if (!tookOver && attempt < 24) {
              retryTakeover(attempt + 1);
              return;
            }
          } catch {
            setStatusMessage("Could not take over the dialpad in this browser.");
          }
          setTakingOver(false);
        }, 200);
        retryTakeover(0);
      } else {
        setTakingOver(false);
      }
      channel?.close();
    } catch {
      setTakingOver(false);
      setStatusMessage("Could not take over the dialpad in this browser.");
    }
  };

  const openDialpadInTab = (number?: string) => {
    if (!config || !user?.id) return false;
    const existingTab = dialpadTabRef.current;
    const tab = existingTab && !existingTab.closed
      ? number
        ? openDialpadTab(config, user.id, tenantId, number)
        : existingTab
      : openDialpadTab(config, user.id, tenantId, number);
    if (!tab) {
      setStatusMessage("The dialpad popup was blocked. Allow popups and try again.");
      return false;
    }
    dialpadTabRef.current = tab;
    dialpadTabReadyRef.current = false;
    if (config.dialpadMode === "DOCKED") forceTabTargetRef.current = true;
    return true;
  };

  if (isLoading || !isAuthenticated) return null;
  if (impersonating) {
    return <div role="status" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border bg-background p-3 text-sm shadow-lg">Calls are disabled while viewing as another user.</div>;
  }
  if (!allowed || !config?.active || !showOnPage) return null;
  if (!secureTransport) {
    return (
      <div role="alert" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950 shadow-lg dark:bg-amber-950 dark:text-amber-100">
        Calls need HTTPS. Microphone access is blocked on plain HTTP.
      </div>
    );
  }
  if (otherTab) {
    return (
      <div className="fixed bottom-4 right-4 z-40 rounded-lg border bg-background p-3 text-sm shadow-lg">
        <p>Dialpad is active in another CRM tab</p>
        <Button className="mt-2" size="sm" disabled={takingOver} onClick={takeOverHere}>{takingOver ? "Taking over…" : "Use dialpad here"}</Button>
      </div>
    );
  }
  if (!ownsLock && config.dialpadMode === "DOCKED") {
    return <div className="fixed bottom-4 right-4 z-40 rounded-lg border bg-background px-3 py-2 text-sm shadow-lg">Connecting to the Bizcall dialpad…</div>;
  }
  if (config.dialpadMode === "NEW_TAB") {
    return (
      <div className="fixed bottom-4 right-4 z-40 rounded-lg border bg-background p-3 text-xs shadow-lg">
        <p>Keep the Bizcall dialpad tab open and allow the microphone.</p>
        {statusMessage ? <p role="status" className="mt-2">{statusMessage}</p> : null}
        {queuedDialRef.current?.type === "DIAL" ? <Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={() => void retryQueuedDial()}>Retry</Button> : null}
        <Button className="mt-2" size="sm" onClick={() => openDialpadInTab()}>Open dialpad in a new tab</Button>
      </div>
    );
  }
  if (!dockOpen) {
    return (
      <Button type="button" className="fixed bottom-4 right-4 z-50 shadow-lg" onClick={() => {
        setStatusMessage("");
        setDockOpen(true);
      }}>
        Open Bizcall Dialpad
      </Button>
    );
  }

  const dialpadUrl = dialpadUrlFor(config, user?.id || "", prefillNumber || undefined);
  const crmOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const endCall = () => {
    const result = sendCommand({ type: "BIZCALL_HANGUP" });
    if (!result.ok) setStatusMessage("The dialpad is not ready to receive BIZCALL_HANGUP.");
  };
  const closeDock = () => {
    if (activeCall && callInProgressRef.current && !window.confirm("End the active call and close the dialpad?")) return;
    if (callInProgressRef.current) {
      const result = sendCommand({ type: "BIZCALL_HANGUP" });
      if (!result.ok) {
        setStatusMessage("The dialpad is not ready to receive BIZCALL_HANGUP.");
        return;
      }
      closeAfterHangupRef.current = true;
      setStatusMessage("Ending the call before closing the dialpad…");
      return;
    }
    if (activeCallTimerRef.current !== null) window.clearInterval(activeCallTimerRef.current);
    activeCallTimerRef.current = null;
    activeCallRef.current = null;
    callInProgressRef.current = false;
    closeAfterHangupRef.current = false;
    queuedDialRef.current = null;
    setActiveCall(false);
    setCallNumber("");
    setElapsedSeconds(0);
    setIframeLoaded(false);
    setOnline(false);
    onlineRef.current = false;
    setExpanded(false);
    setDockOpen(false);
  };

  return (
    <aside className="fixed bottom-3 right-3 z-50 w-[min(360px,calc(100vw-1.5rem))] overflow-hidden rounded-xl border bg-background shadow-2xl md:bottom-4 md:right-4">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-slate-400"}`} />
          <span>Bizcall Dialpad</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {[agentName, extension, callState, activeCall && callState === "Connected" ? formatCallDuration(elapsedSeconds) : ""].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className="flex gap-1">
          {config.callMethod === "DIALPAD_MESSAGE" && activeCall && (callState === "Calling" || callState === "Connected") && (
            <Button type="button" variant="outline" size="sm" onClick={endCall}>End call</Button>
          )}
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={expanded ? "Minimize dialpad" : "Expand dialpad"} onClick={() => setExpanded((value) => !value)}>
            <Phone className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="Reload dialpad" disabled={activeCall} onClick={resetDialpad}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-red-600 hover:bg-red-50 hover:text-red-700" aria-label="Close dialpad and end call" onClick={closeDock}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>
      {(callState === "Calling" || callState === "Connected") && callNumber && (
        <div className="border-b px-3 py-2 text-xs text-muted-foreground">
          {callState} · {maskDialpadNumber(callNumber)}{activeCallRef.current?.leadName ? ` · ${activeCallRef.current.leadName}` : ""}
        </div>
      )}
      {endedSummary && <div className="border-b bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800">Call ended · {endedSummary}</div>}
      {disposition && (
        <div className="border-b px-3 py-2 text-xs text-muted-foreground">
          Disposition saved · {disposition}{dispositionNotes ? " · Notes saved" : ""}
        </div>
      )}
      {microphoneBlocked ? (
        <div role="alert" className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">
          The browser blocked the microphone for this site. Click the lock icon in the address bar, set Microphone to Allow, and reload.
        </div>
      ) : null}
      <div className={expanded ? "block" : "h-0 overflow-hidden"}>
        {statusMessage ? (
          <div className="flex items-center justify-between gap-2 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span>{statusMessage}</span>
            {queuedDialRef.current?.type === "DIAL" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void retryQueuedDial()}>Retry</Button> : null}
          </div>
        ) : null}
        {busy ? <p className="px-3 py-1 text-xs text-muted-foreground">Preparing call…</p> : null}
        {blocked ? (
          <div className="space-y-3 p-4 text-sm">
            <p className="font-medium">Bizcall did not allow this site to embed the dialpad</p>
            {crmOrigin ? <p className="break-all text-muted-foreground">Ask Bizcall to allow this origin in frame-ancestors: <code>{crmOrigin}</code></p> : null}
            <Button className="w-full" onClick={() => openDialpadInTab()}>Open dialpad in a new tab</Button>
          </div>
        ) : (
          <iframe
            key={`${iframeGeneration}:${tenantId}:${user?.id || ""}`}
            ref={frameRef}
            id={BIZCALL_DIALPAD_WINDOW_NAME}
            src={dialpadUrl}
            title="Bizcall dialpad"
            allow="microphone; autoplay"
            width={360}
            height={620}
            className="h-[min(620px,calc(100dvh-6rem))] w-full border-0"
            onLoad={() => {
              setIframeLoaded(true);
              if (user?.id) sendCommandRef.current({ type: "INIT_USER", userId: user.id }, true);
            }}
            onError={() => {
              setIframeLoaded(false);
              onlineRef.current = false;
              setOnline(false);
              setBlocked(true);
              setCallState("Blocked");
            }}
          />
        )}
      </div>
    </aside>
  );
}

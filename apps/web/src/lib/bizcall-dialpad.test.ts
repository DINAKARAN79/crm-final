import { describe, expect, it, vi } from "vitest";
import {
  BIZCALL_DIALPAD_WINDOW_NAME,
  buildBizcallNamespaceKey,
  claimDialpadLock,
  isDialpadLockStale,
  isTrustedBizcallMessage,
  maskDialpadNumber,
  sanitizeDialpadFields,
  sendDialerCommand,
} from "./bizcall-dialpad";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("Bizcall dialpad browser helpers", () => {
  it("isolates locks, channels, and monitor storage by tenant and user", () => {
    expect(buildBizcallNamespaceKey("tenant-a", "user-1", "lock")).not.toBe(
      buildBizcallNamespaceKey("tenant-b", "user-1", "lock"),
    );
    expect(buildBizcallNamespaceKey("tenant-a", "user-1", "channel")).not.toBe(
      buildBizcallNamespaceKey("tenant-a", "user-2", "channel"),
    );
    expect(buildBizcallNamespaceKey("tenant-a", "user-1", "monitor")).toBe("bizcall:tenant-a:user-1:monitor");
  });

  it("expires a closed tab's heartbeat after five seconds and lets another tab take over", () => {
    const storage = memoryStorage();
    storage.setItem("lock", JSON.stringify({ ownerId: "closed-tab", heartbeatAt: 1000 }));

    expect(isDialpadLockStale({ ownerId: "closed-tab", heartbeatAt: 1000 }, 6000)).toBe(false);
    expect(claimDialpadLock(storage, "lock", "other-tab", 6001)).toBe(true);
    expect(JSON.parse(storage.getItem("lock") || "{}")).toMatchObject({ ownerId: "other-tab", heartbeatAt: 6001 });
  });

  it("does not claim a fresh heartbeat until the owner releases it", () => {
    const storage = memoryStorage();
    storage.setItem("lock", JSON.stringify({ ownerId: "current-tab", heartbeatAt: 1000 }));
    expect(claimDialpadLock(storage, "lock", "other-tab", 2000)).toBe(false);
    expect(JSON.parse(storage.getItem("lock") || "{}").ownerId).toBe("current-tab");
  });

  it("rejects messages from other origins or other windows", () => {
    const dialpadWindow = {};
    expect(isTrustedBizcallMessage("https://bizcall.cxteletech.com", dialpadWindow, "https://bizcall.cxteletech.com", dialpadWindow)).toBe(true);
    expect(isTrustedBizcallMessage("https://attacker.example", dialpadWindow, "https://bizcall.cxteletech.com", dialpadWindow)).toBe(false);
    expect(isTrustedBizcallMessage("https://bizcall.cxteletech.com", {}, "https://bizcall.cxteletech.com", dialpadWindow)).toBe(false);
  });

  it("sends only HANGUP to the configured dialpad origin", () => {
    const target = { postMessage: vi.fn() };
    const origin = "https://bizcall.cxteletech.com";
    expect(sendDialerCommand(target, origin, true, { type: "BIZCALL_HANGUP" })).toEqual({ ok: true });
    expect(target.postMessage).toHaveBeenCalledOnce();
    expect(target.postMessage).toHaveBeenCalledWith({ type: "BIZCALL_HANGUP" }, origin);
  });

  it("refuses commands until loaded and rejects unsafe origins", () => {
    const target = { postMessage: vi.fn() };
    expect(sendDialerCommand(target, "https://bizcall.cxteletech.com", false, { type: "BIZCALL_HANGUP" }))
      .toMatchObject({ ok: false, reason: "IFRAME_NOT_READY" });
    expect(sendDialerCommand(target, "*", true, { type: "BIZCALL_HANGUP" })).toMatchObject({ ok: false, reason: "INVALID_ORIGIN" });
    expect(target.postMessage).not.toHaveBeenCalled();
  });

  it("masks phone numbers and redacts notes before monitor storage", () => {
    expect(maskDialpadNumber("+14155552671")).toBe("+14•••••2671");
    expect(sanitizeDialpadFields({
      number: "+14155552671",
      notes: "private call notes",
      extension: "101",
      unknown: { secret: "value" },
      email: "agent@example.com",
      accessToken: "secret-token",
      caller: "+14155552671",
    })).toEqual({
      number: "+14•••••2671",
      notes: "[redacted]",
      extension: "101",
      unknown: "[omitted]",
      email: "a•••@example.com",
      accessToken: "[redacted]",
      caller: "+14•••••2671",
    });
  });
});

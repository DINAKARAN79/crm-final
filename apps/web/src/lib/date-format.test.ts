import { afterEach, describe, expect, it } from "vitest";
import { dateKey, formatDateTime, getTenantTimezone, setTenantTimezone } from "./date-format";

afterEach(() => setTenantTimezone(null));

describe("tenant timezone formatting", () => {
  it("uses the configured tenant timezone and defaults to Asia/Kolkata", () => {
    const instant = "2026-01-01T01:00:00.000Z";
    expect(formatDateTime(instant)).toContain("1 Jan 2026");

    setTenantTimezone("America/Los_Angeles");
    expect(getTenantTimezone()).toBe("America/Los_Angeles");
    expect(formatDateTime(instant)).toContain("31 Dec 2025");
    expect(dateKey(instant)).toBe("2025-12-31");
  });

  it("falls back safely when the tenant timezone is missing or invalid", () => {
    setTenantTimezone("Invalid/Timezone");
    expect(getTenantTimezone()).toBe("Asia/Kolkata");
  });
});

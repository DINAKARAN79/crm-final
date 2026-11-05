import { normalizeUserPhone } from "@dct-crm/shared";

const telephonySettingsHashes: Record<string, string> = {
  DISABLED: "bizcall-connection",
  NOT_CONFIGURED: "bizcall-connection",
  PERMISSION_UNAVAILABLE: "agents",
  NO_PERMISSION: "agents",
  DIALPAD_BLOCKED: "dialpad",
  DIALPAD_EMBED_BLOCKED: "dialpad",
  DIALPAD_POPUP_BLOCKED: "dialpad",
  EMBED_BLOCKED: "dialpad",
  IFRAME_BLOCKED: "dialpad",
  TELEPHONY_NOT_CONFIGURED: "bizcall-connection",
};

export function getTelephonySettingsHash(reasonCode: string) {
  return telephonySettingsHashes[reasonCode] || null;
}

export function buildTelephonySettingsHref(reasonCode: string, leadId?: string, tenantId?: string) {
  const hash = getTelephonySettingsHash(reasonCode);
  const queryParams = new URLSearchParams();
  if (tenantId) queryParams.set("tenantId", tenantId);
  if (leadId) queryParams.set("returnTo", `/leads/${encodeURIComponent(leadId)}`);
  const query = queryParams.size ? `?${queryParams.toString()}` : "";
  return `/setup/integrations/telephony${query}${hash ? `#${hash}` : ""}`;
}

export function getSafeTelephonyReturnTo(value: string | null, origin: string) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("//") ||
    value.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    return null;
  }

  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function isValidTelephonyNumber(value: string | null | undefined, countryCode?: string | null) {
  if (!value) return false;
  return "e164" in normalizeUserPhone(value, countryCode);
}

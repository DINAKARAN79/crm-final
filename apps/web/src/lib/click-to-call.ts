import { clickToCallApi } from "@/lib/api";

export type ClickToCallField = "phone" | "mobile" | "secondaryPhone";
export type ClickToCallStep = "blocked_before_send" | "sent_to_provider" | "prepared_in_dialpad";

export type ClickToCallOutcome = {
  ok: boolean;
  code: string;
  step: ClickToCallStep;
  message: string;
  ignored: boolean;
  callDetailId: string | null;
  leadStatus: string | null;
  statusChanged: boolean;
  leadName: string | null;
};

export function clickToCallToast(result: ClickToCallOutcome, isAdmin: boolean) {
  const sent = result.step === "sent_to_provider";
  const unreachable = result.code === "PROVIDER_TIMEOUT" || result.code === "PROVIDER_UNREACHABLE";
  return {
    title: result.step === "prepared_in_dialpad"
      ? "Number ready in dialpad"
      : sent ? "Request sent to Bizcall" : unreachable ? "Request did not reach Bizcall" : "Blocked before sending",
    description: result.message,
    variant: result.ok ? undefined : "destructive" as const,
    showSettingsLink: ["TELEPHONY_NOT_CONFIGURED", "TELEPHONY_KEY_MISSING", "PROVIDER_AUTH_REJECTED", "PROVIDER_REJECTED"].includes(result.code) && isAdmin,
  };
}

function readOutcome(body: any, fallback: string): ClickToCallOutcome {
  const data = body?.data || {};
  return {
    ok: Boolean(body?.ok ?? body?.success),
    code: body?.code || "",
    step: body?.step === "sent_to_provider"
      ? "sent_to_provider"
      : body?.step === "prepared_in_dialpad"
        ? "prepared_in_dialpad"
        : "blocked_before_send",
    message: body?.message || body?.error || fallback,
    ignored: Boolean(data.ignored),
    callDetailId: data.callDetailId || null,
    leadStatus: data.leadStatus || null,
    statusChanged: Boolean(data.statusChanged),
    leadName: data.leadName || null,
  };
}

export async function placeLeadCall(leadId: string, phoneField: ClickToCallField): Promise<ClickToCallOutcome> {
  try {
    const response = await clickToCallApi.place({ leadId, phoneField });
    return readOutcome(response.data, "The call could not be started.");
  } catch (error: any) {
    return readOutcome(error?.response?.data, "The call could not be started.");
  }
}

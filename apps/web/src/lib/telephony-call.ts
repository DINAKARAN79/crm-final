export type DialpadCallField = "phone" | "mobile" | "secondaryPhone";
export type DialpadCallStep = "blocked_before_send" | "prepared_in_dialpad";

export type DialpadCallOutcome = {
  ok: boolean;
  code: string;
  step: DialpadCallStep;
  message: string;
  callDetailId: string | null;
  leadName: string | null;
};

export function dialpadCallToast(result: DialpadCallOutcome, isAdmin: boolean) {
  return {
    title: result.ok ? "Number ready in dialpad" : "Call not started",
    description: result.message,
    variant: result.ok ? undefined : "destructive" as const,
    showSettingsLink: ["TELEPHONY_INACTIVE", "INVALID_DIALPAD_URL"].includes(result.code) && isAdmin,
  };
}

"use client";

import React from "react";
import Link from "next/link";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buildTelephonySettingsHref } from "@/lib/telephony-navigation";

function reasonMessage(reasonCode: string) {
  if (["IMPERSONATING", "IMPERSONATION_DISABLED"].includes(reasonCode)) return "Calls are disabled while viewing as another user.";
  if (reasonCode === "NO_PERMISSION") return "You do not have permission to place calls. Ask an admin to grant the Telephony permission.";
  if (reasonCode === "PERMISSION_UNAVAILABLE") return "The telephony permission is not set up on this server.";
  if (reasonCode === "DISABLED") return "Telephony is switched off for this company.";
  if (["DIALPAD_BLOCKED", "DIALPAD_EMBED_BLOCKED", "DIALPAD_POPUP_BLOCKED", "EMBED_BLOCKED", "IFRAME_BLOCKED"].includes(reasonCode)) {
    return "The Bizcall dialpad is not allowed on this site.";
  }
  if (["INVALID_NUMBER", "INVALID_PHONE", "PHONE_INVALID"].includes(reasonCode)) {
    return "This phone number is not valid for calling.";
  }
  if (["INSECURE_CONTEXT", "HTTPS_REQUIRED", "INSECURE_PAGE"].includes(reasonCode)) {
    return "Calls need HTTPS because browsers block the microphone on plain HTTP.";
  }
  if (reasonCode === "NOT_CONFIGURED") return "Telephony is not set up for this company.";
  return "Telephony is unavailable. Ask an admin to check the company telephony settings.";
}

export function TelephonyStatusHint({
  reasonCode,
  isAdmin = false,
  leadId,
  tenantId,
  isClickable = false,
}: {
  reasonCode: string;
  isAdmin?: boolean;
  leadId?: string;
  tenantId?: string;
  isClickable?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const message = reasonMessage(reasonCode);
  const settingsHref = buildTelephonySettingsHref(reasonCode, leadId, tenantId);
  const className = "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
  React.useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("mousedown", dismissOutside, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("mousedown", dismissOutside, true);
    };
  }, [open]);

  if (isClickable) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button ref={triggerRef} type="button" className={className} aria-label="Why can't I call this number?" aria-haspopup="dialog">
          <CircleHelp className="h-4 w-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent ref={contentRef} role="dialog" aria-label="Why calling is unavailable" className="space-y-3">
        <p className="text-sm">{message}</p>
        {isAdmin && settingsHref ? (
          <Button asChild size="sm" className="w-full">
            <Link href={settingsHref}>Open Telephony settings</Link>
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Ask your administrator to enable telephony.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

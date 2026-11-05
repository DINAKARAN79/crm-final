# Telephony and Bizcall dialpad

## Outbound call flow

Clicking any shared lead-phone control sends one authenticated request to
`POST /api/telephony/dialpad-call-started`. The API checks telephony permission,
company activation, lead visibility and tenant, follow-up ownership, phone
normalization, Do-Not-Call settings, duplicate-click and per-user rate limits,
and impersonation. It then creates an outbound `CallDetail` with status
`Initiated`, writes a masked audit value, applies the New-to-Incoming lead rule,
and returns the server-built dialpad URL and validated call metadata.

The browser never constructs a phone URL from lead data and does not call
Bizcall's REST API. It validates that the returned URL uses HTTPS and the
configured Bizcall origin, then loads it into the docked iframe or the
`bizcall-dialpad` tab. A new tab is opened synchronously in the phone-click
handler before the API request, so popup blockers do not prevent the validated
URL from being loaded. A refused preflight closes the blank tab.

`autocall=false` is sent when Auto-dial is off; the agent must press the dialpad
call button. `autocall=true` is sent only when the setting is enabled. Number
masking is display-only: the real E.164 number is sent to Bizcall, while audit
entries, monitor output, and displayed call history use masked numbers.

## Dialpad messages and provider behavior

The CRM does not send `DIAL` or `INIT_USER` commands. It uses the server-returned
URL parameters (`userId`, encoded `number`, explicit `autocall`, and `theme`) to
load the number. The stored legacy REST key and click-to-call columns are not
read, decrypted, returned, or updated.

The Bizcall CTI guide is not present in the repository, and provider-side
behavior could not be independently verified here. In particular, this report
does not claim whether `?number=` pre-fills or starts a call on the live
provider. The implementation uses `autocall=false` to request the agent-presses
call behavior and `autocall=true` only when explicitly enabled in CRM settings.
Confirm those URL semantics against the current Bizcall CTI guide before
enabling Auto-dial in production.

## Events and call records

The dock listens only for the supported Bizcall events from the expected
window and configured origin: agent registered, call starting, call connected,
call ended, and disposition submitted. The API rechecks session permission and
lead visibility and updates Call Details idempotently; terminal calls do not
move backwards. The postMessage monitor masks numbers and redacts notes.

If Bizcall sends no events to the CRM opener, the record remains `Initiated`.
The UI says that call duration and disposition will appear after Bizcall syncs.
The CRM cannot read events from a different tab unless Bizcall posts them to the
opener.

## Settings and retained database fields

Telephony settings include Active, the HTTPS dialpad URL, docked/new-tab mode,
theme, default dock state, CRM origin/iframe check, auto-dial (default off),
tenant context, duplicate guard, calls-per-minute limit, display masking, and
DNC controls. Recent calls are read from `CallDetail`.

The following legacy fields and tables remain in the database, without a
destructive migration, but are unused by the application:

- REST URL, authentication header, caller ID, key ciphertext/key suffix,
  extra-header ciphertext, and call-method selector on `telephony_settings`.
- `telephony_request_logs`, formerly used for REST click-to-call attempts.

They should be considered for removal only in a separate, backed-up schema
cleanup after confirming no external deployment tooling depends on them.

## Validation

Focused API and web tests cover server URL generation, E.164 encoding,
permission/impersonation/inactive/DNC/duplicate/visibility denials, popup
handling, trusted event origin checks, masked logging, and default-off
Auto-dial. Typechecks are run with the workspace commands documented in the
root package scripts.

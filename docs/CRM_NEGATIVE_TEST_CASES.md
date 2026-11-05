# CRM Negative Test Case Catalog

## Purpose and execution rules

This catalog covers negative and boundary behavior across the CRM UI and API. It is based on the implemented application modules and validations, and is intended for QA execution and automation planning. It is not evidence that every scenario has already been executed.

- Run against an isolated QA/staging environment with synthetic users, tenants, leads, projects, units, and contact data. Never use production customer data for destructive tests.
- For each authorization case, test both the UI and the API directly. Hiding a control is not a substitute for server-side authorization.
- For each write rejection, verify the response and that no unintended row, status change, assignment, note, audit side effect, or notification was created.
- Use two tenants and at least three profiles: tenant admin, permitted non-admin, and non-permitted user. Add a second user in the same tenant to exercise record-level scope.
- Unless a case specifies otherwise, expected outcomes are a clear validation response (typically 400/422), unauthenticated response (401), forbidden response (403), or not-found response (404). Do not require a particular status code where the UI/API contract does not define one; do require no data leakage and no partial mutation.
- Do not repeatedly submit rate-limited actions in a live environment. Use test accounts, a controlled rate-limit window, and explicit cleanup.

## Coverage map

| Area | Covered flows |
|---|---|
| Authentication and session | Login, company lifecycle, refresh, logout, heartbeat, concurrent sessions, impersonation |
| CRM records | Leads, enquiries, activities/tasks, follow-ups, notes and timeline |
| Real-estate workflows | Projects, units, site visits, quotations, bookings, receipts and MIS approvals |
| Access and configuration | Profiles, roles, permission sets, users, tenant isolation, object/field/layout configuration |
| Platform features | Search, list views, dashboards, reports, notifications, calendar, imports and exports |
| Integrations | Telephony/dialpad, company API keys, webhook/lead intake, CP portal, GRE/public forms |
| Reliability | Invalid input, stale state, concurrency, retries, partial failures, duplicate requests and unavailable dependencies |

## A. Authentication, login, and session security

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| AUTH-01 | Submit login with empty email, empty password, missing fields, `null` values, or wrong JSON types. | Validation error; no session/token issued; no user details disclosed. |
| AUTH-02 | Submit malformed, overlong, or invalid email and whitespace-only credentials. | Input rejected or normalized according to login contract; no accidental account match. |
| AUTH-03 | Use a nonexistent email, incorrect password, and an inactive user account. | Generic invalid-credentials response for unknown/wrong credentials; inactive users cannot authenticate; no account-enumeration detail. |
| AUTH-04 | Attempt login with correct credentials while the tenant is inactive. | Access denied with the company-deactivated message; no usable session created. |
| AUTH-05 | Attempt login before company start date and after company expiry date as a tenant user; repeat as Super Admin. | Tenant user denied for pending/expired company; Super Admin behavior follows the explicit platform policy and does not accidentally inherit tenant access. |
| AUTH-06 | Configure the API without `DATABASE_URL` or `JWT_SECRET`, then attempt login. | Clear service-configuration failure; no stack trace, credential, or secret in the client response. |
| AUTH-07 | Exceed the login rate limit with a test IP/account. | Further attempts are throttled; no lockout of unrelated users; response does not reveal whether the account exists. |
| AUTH-08 | Call authenticated endpoints without a token, with a malformed token, expired token, altered signature, or token for a deactivated user. | Request rejected; no protected data returned and no mutation performed. |
| AUTH-09 | Refresh with an expired/revoked session or a token from another tenant. | Refresh denied; no replacement token or tenant data returned. |
| AUTH-10 | Logout twice, logout with no session, or replay a token after logout. | Logout is safe/idempotent; revoked session cannot access protected routes. |
| AUTH-11 | Use two sessions for one user; end one session from the active-sessions screen. | Only selected session is invalidated; other session behavior follows policy; stale session cannot heartbeat or refresh. |
| AUTH-12 | Send malformed heartbeat payloads or exceed heartbeat rate limit; heartbeat an ended session. | Invalid or stale heartbeat is rejected/ignored without recreating a session or changing another user's presence. |
| AUTH-13 | Open a tenant route in another tenant's session and alter tenant IDs in query/body/path. | Session tenant controls access; cross-tenant records are not returned or mutated. |
| AUTH-14 | Attempt impersonation as a non-authorized user; target a Super Admin, inactive user, or another tenant; use expired impersonation token. | Impersonation denied unless policy permits; cross-tenant or protected targets denied; impersonation expiry is enforced and audited. |
| AUTH-15 | Stop impersonation twice, logout while impersonating, or use the impersonated session after stop. | Session returns to the real user or ends as specified; stale impersonated credentials no longer work; original identity is not confused with impersonated identity. |
| AUTH-16 | Run telephony or another restricted action while impersonating. | Call/action is blocked server-side even if the client hides or disables its control. |

## B. Navigation, permission enforcement, and tenant boundaries

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| ACCESS-01 | Remove a module read permission, then use its navigation item, deep link, and API route. | Navigation reflects access policy; direct route/API is denied; no data is rendered from a cached response. |
| ACCESS-02 | Grant read but remove create, update, and delete separately; invoke each API directly. | Read remains available; each unauthorized write is denied without side effects. |
| ACCESS-03 | Use a profile with no object permission against list, detail, search, export, and related-record endpoints. | All paths enforce the same permission and record-scope rules; alternate endpoints do not bypass denial. |
| ACCESS-04 | Change IDs in URLs and request bodies to another user's record in the same tenant. | Record visibility rules are enforced; inaccessible data is not disclosed (403 or not-found per route contract). |
| ACCESS-05 | Change tenant IDs in query/body for leads, projects, units, bookings, users, and reports. | Tenant identity comes from the authenticated session except for explicitly authorized Super Admin workflows; ordinary users cannot cross tenants. |
| ACCESS-06 | Submit a valid request with a permission name absent from the permission catalog, or with a stale client permission cache. | API fails safely and logs/returns an actionable diagnostic; no fail-open authorization and no unhandled page crash. |
| ACCESS-07 | Revoke permission while the user has the page open, then retry the write from the stale UI. | Server denial wins; stale UI receives a friendly error and does not report success. |
| ACCESS-08 | Test `isAdmin` profile and System Administrator profile separately on endpoints with explicit permission middleware. | Behavior matches documented server rule; no assumed admin bypass where middleware requires a permission. |
| ACCESS-09 | Request an object ID that does not exist and one that exists only in another tenant. | Both responses do not disclose the foreign record's existence or fields. |
| ACCESS-10 | Attempt bulk operations with mixed accessible/inaccessible record IDs. | Request is rejected or only explicitly supported accessible records are processed atomically; response identifies failures without leaking foreign data. |

## C. Leads, lead details, and lead lifecycle

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| LEAD-01 | Create a lead with no required fields, whitespace-only names, overlong text, invalid email, or invalid JSON types. | Field-level validation is shown; no lead is created. |
| LEAD-02 | Create/update using malformed phone, impossible country code, too-short/too-long number, or number inconsistent with country code. | Phone validation rejects invalid values; accepted values normalize consistently; no partial update. |
| LEAD-03 | Create lead with an existing normalized phone/email; test same field, alternate phone/email field, formatting differences, and duplicate-preview race. | Duplicate warning/blocking follows configured policy; normalization catches equivalent contacts; concurrent requests cannot silently create unintended duplicates. |
| LEAD-04 | Use invalid, inactive, or cross-tenant owner/profile/project references during lead create/update. | Reference rejected; the request cannot assign a record to an invalid or foreign entity. |
| LEAD-05 | Fill a required custom field with blank/null/wrong type or submit unknown custom-field keys. | Required-field and field-definition rules enforced; unknown or invalid fields are not silently persisted. |
| LEAD-06 | Change status to an unknown/disabled status or attempt a prohibited transition from the current status. | Transition denied with an explanatory validation; status and timeline remain unchanged. |
| LEAD-07 | Try a restricted Prospect/PUSH-to-SVC transition with missing reason, project, summary, budget range, property type, bedroom preference, or invalid option. | Transition rejected; no assignment, note, status update, or partial prospect data is written. |
| LEAD-08 | Schedule a visit from an ineligible lead status or use an inactive/cross-tenant project. | Scheduling denied; no site visit created and no lead status promoted. |
| LEAD-09 | Read or edit an unowned lead as a profile without view-all/modify-all or valid record access. | Record scope is enforced on list and detail and write endpoints; IDs cannot be used to bypass scope. |
| LEAD-10 | Update a lead using stale values after another user changes status/owner; retry the same transition. | Stale/conflicting update is rejected or safely reconciled; no status downgrade or duplicate timeline event. |
| LEAD-11 | Delete a lead linked to site visits, quotations, bookings, follow-ups, calls, or notes. | Referential/workflow policy is enforced; deletion does not orphan dependent data or partially remove the lead. |
| LEAD-12 | Open lead detail with invalid ID, foreign ID, or a tab whose permission is missing (e.g. Enquiry, Calls, Activity). | Not-found/permission-specific friendly state; other permitted tabs remain usable; no raw exception or leaked data. |
| LEAD-13 | Click an empty/invalid phone or make a call without permission, while telephony is inactive, or during impersonation. | No call request reaches the provider; no call record is falsely marked successful; reason is visible and appropriate. |
| LEAD-14 | Try changing a lead phone while a call is being prepared; double-click the phone action. | Server validates the current permitted record/number; duplicate guard prevents unintended duplicate calls. |
| LEAD-15 | Import a lead row with invalid status/source, duplicate contact, foreign owner, bad custom field, malformed phone, and formula-like text. | Invalid row is reported with row/field context; valid rows follow import policy; no unsafe formula execution or cross-tenant assignment. |
| LEAD-16 | Fail an update midway through an operation with linked enquiry/round-robin assignment. | Transaction is atomic or partial behavior is explicitly reported; no misleading success and no inconsistent linked records. |

## D. Enquiries, source attribution, and lead conversion

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| ENQ-01 | Read enquiry without `Enquiry:read`/equivalent grant; separately test a System Admin profile lacking the catalog grant. | Friendly permission message; raw exception is not displayed; admin configuration link appears only for authorized users. |
| ENQ-02 | Edit/delete enquiry without the matching permission or outside record scope. | Server rejects request; enquiry and linked lead remain unchanged. |
| ENQ-03 | Submit enquiry with missing/invalid source, contact details, lead association, unknown enquiry ID, or a lead from another tenant. | Validation/visibility rejection; no cross-tenant link or orphan enquiry. |
| ENQ-04 | Reprocess/backfill the same enquiry repeatedly or after a linked lead is deleted/changed. | Processing is idempotent or reports the conflict; duplicate leads/enquiries are not silently created. |
| ENQ-05 | Submit malformed external lead/webhook payload, unsupported source, missing integration key, invalid signature/key, or replay an old payload. | Intake denied safely; no secrets echoed; duplicates/replays handled according to integration policy and audited. |
| ENQ-06 | Provide text resembling SQL, HTML/script, formula, or excessively large values in enquiry fields. | Data is validated/escaped; no script execution, query manipulation, or service exhaustion. |

## E. Activities, tasks, follow-ups, notes, and timeline

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| ACT-01 | Create activity/task with missing subject/title, invalid type/date, excessive text, invalid owner, or foreign lead. | Validation rejects request; no activity or timeline event is created. |
| ACT-02 | Read/update/delete activity without permission or outside its record scope. | API denies access; no data leak or mutation. |
| ACT-03 | Complete an already completed/deleted activity; reopen an activity not eligible for reopening. | State transition is rejected or idempotent per policy; completion timestamp/history is not duplicated. |
| ACT-04 | Complete activity with missing required result/notes, or submit contradictory completion fields. | Clear validation; item remains open and no lead status change occurs. |
| FUP-01 | Create follow-up without lead/title/subject/due date or with a due date that violates future-date rules. | Validation rejects request; no follow-up is created. |
| FUP-02 | Create follow-up for inaccessible/cross-tenant lead, invalid owner/assignee, or invalid enquiry/booking link. | Link and assignment rejected; no foreign record disclosure. |
| FUP-03 | Update or delete another user's follow-up without modify-all/access; change owner to an ineligible user. | Permission and follow-up scope enforced; owner remains unchanged on failure. |
| FUP-04 | Complete, cancel, or reopen a follow-up repeatedly or in an invalid state. | Transition is idempotent or rejected; completed/missed/cancelled state does not regress; audit history is not duplicated. |
| FUP-05 | Submit invalid list filters, date range (end before start/invalid date), sort field, page, or limit. | Request is rejected or safely bounded; no unbounded query or server error. |
| NOTE-01 | Add a blank/oversized note or add a note to an inaccessible lead. | Rejected; no note or timeline update is visible to unauthorized users. |
| NOTE-02 | Inject HTML/script, control characters, secrets, or PII into a note/disposition. | Rendered as safe text; sensitive values are not copied into logs or diagnostic UI. |

## F. Projects and inventory units

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| PROJ-01 | Create/update a project with missing name, name too long, invalid latitude/longitude, only one coordinate, negative/out-of-range radius or unit count. | Validation rejects request; no invalid project/location is saved. |
| PROJ-02 | Read/update/delete project without permission or by substituting a foreign tenant ID. | Denied/not-found; no project or child data leaked or changed. |
| PROJ-03 | Deactivate/delete a project that has units, visits, quotations, or bookings. | Dependency policy enforced; related records remain consistent and no partial deletion occurs. |
| PROJ-04 | Submit malformed map URL, unsupported URL host, invalid geocode coordinates, or geocoding provider timeout. | Invalid input rejected; provider failure reported without corrupting existing coordinates or exposing credentials. |
| UNIT-01 | Create unit with missing project/number/type/price, negative area/price/floor, invalid status, or malformed custom-field key/type. | Validation rejects; no unit code or inventory row is consumed unnecessarily. |
| UNIT-02 | Create duplicate unit number/code in a project; race two creates for the same unit. | Unique constraint/conflict surfaced clearly; at most one unit created. |
| UNIT-03 | Set unknown or illegal availability status, including booking-only statuses through a disallowed endpoint. | State transition denied; status and booking relationships remain consistent. |
| UNIT-04 | Link unit to nonexistent/foreign project, owner, or lead. | Relation validation rejects; no foreign association persisted. |
| UNIT-05 | Edit/delete a unit already reserved/booked/sold or referenced by quotation/receipt. | Lifecycle/relationship restrictions enforced; no silent invalidation of booking data. |
| UNIT-06 | Submit invalid list status, sort field/order, page, limit, or location filter. | Input rejected or bounded; no server exception or excessive query. |

## G. Site visits and scheduling

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| SV-01 | Create visit without lead, project, scheduled time, required notes, or with malformed date-time. | Validation error; no site visit is created. |
| SV-02 | Schedule a visit in the past, too near current time, or in a disallowed timezone/offset. | Shared future-time rule is enforced consistently in UI and API; no visit is created. |
| SV-03 | Use a foreign/inaccessible lead, inactive/foreign project, invalid assignee, or queue from another tenant. | Request denied; no hidden entity details disclosed and no assignment occurs. |
| SV-04 | Submit invalid visit type, transport, rating, feedback length, or custom fields. | Option/range validation enforced; no partial visit data is saved. |
| SV-05 | Complete visit with missing completion time, feedback, notes, rating, or invalid completed-at value. | Completion rejected; visit remains scheduled and lead status unchanged. |
| SV-06 | Complete a cancelled visit, complete twice, or send concurrent completion requests. | Invalid transition rejected or idempotent; only one completion/audit/assignment occurs. |
| SV-07 | Cancel/reschedule without reason, with whitespace reason, or reschedule to invalid/past date/project. | Rejected; original schedule/status remains intact and no duplicate visit is created. |
| SV-08 | Create revisit from a visit that is not eligible, with missing required prospect details or invalid property/budget options. | Revisit denied with required-field feedback; original visit is not changed. |
| SV-09 | Retry failed sales assignment when visit/lead is no longer eligible or user lacks access. | Retry is safe, authorized, and does not create duplicate assignments/history. |
| SV-10 | Delete a visit referenced by quotation or audit history. | Deletion blocked or handled by explicit archival policy; quotation/history does not become orphaned. |
| SV-11 | Query site visits with invalid date range/status/sort or a hidden lead ID filter. | Invalid filters rejected; hidden records are excluded and counts do not reveal them. |

## H. Quotations, booking, payments, and receipts

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| QUO-01 | Create quotation without completed visit, active project, available unit, or accessible lead. | Request rejected; no quotation or unit reservation is created. |
| QUO-02 | Submit zero/negative/non-finite price, negative PLC/discount, or discount producing negative total. | Validation rejects; totals remain finite and non-negative. |
| QUO-03 | Submit no installments, more than maximum, blank/duplicate milestone, percentage <=0 or >100, total not exactly 100%, or missing due offset. | Payment plan rejected with actionable reason; no quotation created. |
| QUO-04 | Quote with unit missing/invalid area or unit that became unavailable between form load and submit. | Server rechecks availability/area transactionally; request fails without partial quotation or reservation. |
| QUO-05 | Generate/download quotation PDF for inaccessible lead, invalid quotation ID, or deleted file/template. | Access denied/not-found or clear generation failure; no foreign PDF or local filesystem path disclosed. |
| BOOK-01 | Create booking without valid quotation, available unit, eligible lead, or required first-applicant details. | Validation/workflow rejects; unit remains available and no booking is created. |
| BOOK-02 | Submit invalid DOB, PAN, state, email, phone, Aadhaar length, photo MIME/size, or malformed applicant address. | Applicant validation rejects; sensitive data is not echoed in errors or logs. |
| BOOK-03 | Add optional second-applicant details without a name; exceed additional-applicant maximum; mismatch same-address values. | Cross-field validation rejects; no partial applicant record saved. |
| BOOK-04 | Submit negative, non-finite, or malformed booking amount; use unknown/read-only booking detail keys or wrong field types. | Amount and booking details are rejected; read-only fields cannot be changed through API tampering. |
| BOOK-05 | Create two bookings concurrently for the same unit or retry after timeout. | Transaction/unique state prevents double reservation; retry does not duplicate booking or consume unit twice. |
| BOOK-06 | Advance booking stage out of order, skip required welcome call/document/receipt step, or repeat a terminal transition. | Workflow transition rejected or idempotent; booking status/history does not regress or advance falsely. |
| BOOK-07 | Create/read/update booking as a user outside Admin/CRM policy, without required permission, or for another tenant's lead/unit. | Server authorization enforced regardless of UI; no booking details leaked. |
| BOOK-08 | Add welcome-call or booking-detail data with oversized notes, invalid types, or unsupported stage values. | Validation rejects; no partial stage update. |
| REC-01 | Create receipt with missing booking/date/sender, invalid date, zero/negative/infinite amount, or unsupported payment mode. | Validation rejects; no receipt or balance change occurs. |
| REC-02 | Record receipt against cancelled/foreign booking, invalid lead, or amount exceeding applicable rules. | Request rejected or explicit overpayment policy applied; no cross-tenant allocation. |
| REC-03 | Submit duplicate transaction/receipt request or retry after client timeout. | Duplicate guard/idempotency prevents duplicate financial records; same request outcome can be safely recovered. |
| REC-04 | Submit MIS approval for non-MIS receipt, already reviewed receipt, or nonexistent/foreign receipt. | Review denied; state, reviewer, and audit history unchanged. |
| REC-05 | Approve a receipt when booking is not in the required reserved state; reject with oversized/HTML note. | Approval transition blocked or safely escaped; booking/receipt states remain consistent. |
| REC-06 | Attempt receipt delete/update without permission or after approval/finalization. | Denied or prevented by lifecycle rule; financial audit trail remains intact. |

## I. Telephony and dialpad integration

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| TEL-01 | Click call as a user lacking `TELEPHONY_CALL`, with a missing permission definition, or inactive telephony. | The server denies before opening/navigating the dialpad; no CallDetail is created. No API key is required. |
| TEL-02 | Call with invalid/empty phone, inaccessible lead, lead in another tenant, or a follow-up/task not linked to that lead. | Preflight denies; no dialpad navigation or CallDetail is created. |
| TEL-03 | Put number on DNC list, double-click within duplicate window, or exceed per-user call rate. | DNC/duplicate/rate limit blocks the request; no dialpad URL is loaded. |
| TEL-04 | Store a malformed, HTTP, or unapproved dialpad URL, or tamper with a returned URL. | The server rejects the setting or URL; the browser requires HTTPS and the configured Bizcall origin. |
| TEL-05 | Block popup, close the named tab, or reload a docked iframe while the agent is not registered. | Show a recoverable popup/connecting message; use one named tab or the docked iframe; do not send a DIAL command. |
| TEL-06 | Call with Auto-dial disabled. | The server returns a URL with `autocall=false`; the agent presses Bizcall's green call button. No call is auto-started by CRM messaging. |
| TEL-07 | Call with Auto-dial enabled. | The server returns a URL with `autocall=true`; the CRM does not send an additional call request or DIAL message. |
| TEL-08 | Send fake Bizcall events from another origin/window, malformed payload, invalid UUID/number, or replay/out-of-order events. | Events ignored/rejected; only the expected dialpad source and origin are accepted; duplicate/backwards events do not regress call status. |
| TEL-09 | Spoof tenantId/userId in a preflight or event body. | Identity and authorization use the authenticated session only; body identifiers do not affect tenant/user/call ownership. |
| TEL-10 | Block microphone, refuse iframe embedding, or Bizcall reports an unknown agent/authentication failure. | UI explains the microphone/embedding/registration limitation without retry loops; CallDetail remains Initiated until a trusted event arrives. |
| TEL-11 | Send provider event with no call UUID and multiple recent open calls; send an unknown UUID. | Events are matched only to the authorized user's recent open call and correct lead; unmatched events are not attached to another user's call. |
| TEL-12 | Submit disposition with invalid/oversized notes or after call terminal state. | Invalid event rejected; call and timeline remain idempotent; sensitive raw values are not logged. |
| TEL-13 | Use dialpad while impersonating, on insecure HTTP, or without lead visibility. | Client and server block; no popup, dialpad URL, or CallDetail is created. |
| TEL-14 | Verify legacy key/REST settings exist in a database row after upgrading. | Settings reads and writes ignore those columns; they remain stored, are never decrypted or returned, and no REST request is made. |

## J. Administration, users, profiles, roles, permissions, and setup

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| ADM-01 | Non-admin opens `/setup`, profile, role, permission set, user administration, or platform-only route directly. | UI/API deny access; direct URL cannot bypass navigation policy. |
| ADM-02 | Create user with missing fields, malformed email, duplicate tenant email, weak/invalid password, invalid profile/role, or foreign tenant ID. | Validation rejects; no user/session/role assignment is created. |
| ADM-03 | Assign inactive/nonexistent/foreign role or profile; remove the last required administrator. | Invalid assignment denied; admin-lockout safeguards apply; operation is atomic. |
| ADM-04 | Deactivate/delete current user, self, last admin, or user with active sessions/owned records. | Policy is enforced and explained; no orphan records or accidental self-lockout. |
| ADM-05 | Change password with wrong current password, too-short/mismatched new password, or attempt to set another user's password without privilege. | Password change denied; no credential disclosure; affected sessions follow configured revocation policy. |
| ADM-06 | Grant unsupported permission key, duplicate permission, or conflicting profile/permission-set assignment. | Invalid/duplicate data rejected or idempotently handled; effective permissions remain deterministic. |
| ADM-07 | Delete a profile, role, permission set, or permission definition still assigned/in use. | Dependency checks prevent unsafe removal or require explicit migration; users are not silently left with unintended access. |
| ADM-08 | Call `GET /api/profiles` as an unauthorized user or use a profile picker after expected 403. | No raw console error; inline access message shown; the rest of the screen remains functional. |
| ADM-09 | Modify company lifecycle dates, capacity, package, status, or logo as non-Super Admin; upload oversized/unsupported logo. | Server denies unauthorized change; invalid media/date/capacity rejected; existing company settings remain intact. |
| ADM-10 | Save malformed personal/company settings, unsupported theme/timezone, or data that violates field constraints. | Validation shown; prior saved value remains; no settings are silently reset. |
| ADM-11 | Change field permissions/layout/object definitions with unknown object/field or invalid layout configuration. | Configuration rejected; existing layout and field access remain unchanged. |
| ADM-12 | Remove a required system permission from the catalog or grant set in QA. | Startup/post-deploy self-check reports missing permission clearly; runtime fails closed without crashing unrelated screens. |

## K. Search, list views, calendar, dashboard, reports, and notifications

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| UX-01 | Search with empty/oversized/control-character input, unknown object, or query designed to match another tenant's data. | Input is bounded/sanitized; results remain permission- and tenant-scoped; no database error is exposed. |
| UX-02 | Open saved list view whose filter references deleted/hidden field, invalid operator, or inaccessible record. | Invalid view is rejected or safely repaired; it cannot broaden visibility beyond permissions. |
| UX-03 | Supply unknown sort key/order, negative page, zero/huge limit, invalid date range, or duplicate filter parameters. | API validates/bounds values; no unbounded query, crash, or record leakage. |
| UX-04 | Open dashboard/report without permission, shared to another user/tenant, or referencing deleted source/field. | Access denied or friendly unavailable state; dashboard execution does not bypass object/field permissions. |
| UX-05 | Create report with no dataset, invalid field/operator, malformed filters, invalid grouping/aggregate, or unsupported export. | Builder/API reports validation; no query executes with broadened access; no misleading empty-success output. |
| UX-06 | Execute report with large date range or unavailable data source; export after permission is revoked. | Request is bounded/fails clearly; server checks current permission; sensitive data is not included in export. |
| UX-07 | Delete/share/clone a dashboard/report owned by another user without privilege; use expired share. | Owner/permission policy enforced; revoked/expired share cannot access data. |
| UX-08 | Mark another user's notification read/delete it, or call read-all/clear-all under wrong session. | Operations affect only authenticated user's notifications; foreign notification IDs reveal no data. |
| UX-09 | Notification references a deleted or inaccessible record. | Safe fallback is shown; click does not expose protected record or crash the app. |
| UX-10 | Calendar receives invalid date boundaries, impossible recurrence, inaccessible linked lead/task, or stale event update. | Validation and permission rules apply; no event duplication or visibility leak. |

## L. Data import, export, dynamic objects, and customization

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| DATA-01 | Import unsupported file type, empty file, malformed CSV/headers, invalid encoding, oversized file, or row count over limit. | Import rejected with useful file/row diagnostics; no partial import unless explicitly supported and clearly reported. |
| DATA-02 | Import invalid enum, required field, foreign relation, duplicate, malformed phone/email, and invalid custom fields. | Row errors identify affected fields; transaction/partial-import behavior matches documented policy; no silently corrupted records. |
| DATA-03 | Include formula payloads, HTML/script, control characters, or CSV delimiters/newlines in imported content. | Values are treated as data; exported CSV is safely escaped; no spreadsheet formula execution. |
| DATA-04 | Export without permission, request unknown object/field, or attempt to export hidden fields/records. | Export denied or filtered by current field/object/record permissions; no foreign data or secrets included. |
| DATA-05 | Create dynamic object with invalid/duplicate name, reserved field, unsupported type, invalid relationship, or too many fields. | Schema/config validation rejects; existing objects and records remain available. |
| DATA-06 | Bulk create/update/delete with mixed valid/invalid rows, duplicate IDs, foreign IDs, or oversized payload. | Atomic or partial behavior is explicit; each failure is reported; unauthorized rows are never processed. |
| DATA-07 | Delete/rename custom object or field used by layouts, reports, records, or integrations. | Dependency policy blocks or performs a documented safe migration; no runtime screens break silently. |
| DATA-08 | Save custom page layout with duplicate/missing sections, unknown fields, invalid component config, or unauthorized field exposure. | Layout save rejected; prior working layout remains; hidden field permissions are not bypassed by layout config. |

## M. Integrations, APIs, partner portal, and GRE/public forms

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| INT-01 | Call company API with missing, invalid, expired, revoked, or wrong-tenant API key; exceed API rate/size limits. | Authentication fails closed; response is generic and does not disclose key validity or tenant secrets. |
| INT-02 | Create/update/revoke API key without admin permission; attempt to read plaintext key after creation. | Unauthorized actions denied; secret is shown only when policy allows and never logged or returned again. |
| INT-03 | Submit webhook with missing/wrong integration key, invalid schema, oversized body, replay, or injected tenant/user ID. | Request rejected or safely deduplicated; identity/tenant comes from validated integration credentials; no spoofed attribution. |
| INT-04 | CP portal login with wrong password, inactive account, expired/reset-required credentials, or brute-force attempts. | Access denied/throttled without account enumeration; portal session is scoped to the partner. |
| INT-05 | CP user requests another partner's lead, notes, project, brochure, or dashboard using guessed ID. | Not-found/forbidden with no data leakage; all API endpoints enforce partner ownership. |
| INT-06 | CP user creates lead/note with invalid contact, foreign owner, oversized content, or attempts to edit/delete outside granted workflow. | Validation and partner policy enforced; no cross-partner mutation or unauthorized delete. |
| INT-07 | CP password reset with invalid token, expired token, weak password, or replayed token. | Reset denied safely; token single-use and no session created from invalid token. |
| INT-08 | GRE/public form submission with missing required field, invalid option, expired/unknown form, invalid token, or excessive submission rate. | Submission rejected with safe feedback; no internal CRM data is exposed; abuse is rate-limited. |
| INT-09 | Update/delete GRE form/submission without the required admin permission; submit stale form version. | Server denies unauthorized update; stale form cannot silently discard/alter submissions. |
| INT-10 | Integration provider times out, returns malformed response, or returns HTTP error after request is sent. | UI presents an actionable failure; retries are idempotent where possible; no false success or duplicate financial/call operation. |

## N. Cross-module end-to-end negative journeys

| ID | Negative scenario and steps | Expected result |
|---|---|---|
| E2E-01 | Create lead → attempt follow-up as unpermitted user → attempt site visit with invalid project → inspect lead timeline. | Each step is denied at the correct boundary; no hidden follow-up/visit or misleading timeline event appears. |
| E2E-02 | Create lead → valid visit → complete with missing feedback → attempt quotation anyway. | Completion remains blocked; quotation cannot bypass prerequisite; unit remains available. |
| E2E-03 | Complete visit → create quotation with installment total 99.99% → retry with same unit after another user books it. | Invalid schedule rejected; subsequent stale quote rejected; no duplicate reservation or quotation. |
| E2E-04 | Create booking → submit duplicate receipt → attempt MIS approval twice, including one concurrent review. | Receipt is not duplicated; exactly one valid review transition occurs; booking/receipt states remain consistent. |
| E2E-05 | Start a dialpad call from a lead → change permissions/tenant scope before an event arrives → submit a trusted-looking event. | Server rechecks authorization and session; event cannot update another tenant/user's CallDetail. |
| E2E-06 | Admin revokes a user's access while user is editing lead/booking/site visit in another tab; user submits stale form. | API rejects based on current authorization; UI indicates failure and preserves unsaved input where practical. |
| E2E-07 | Import a lead then trigger duplicate assignment/round-robin request or retry after timeout. | Assignment is atomic/idempotent; no duplicate owner history or notifications. |
| E2E-08 | Simulate API/database outage during create/update and retry from UI. | No success toast for failed write; no partial records; retry outcome is safe and observable. |
| E2E-09 | Switch tenant/session in one browser tab while another tab has cached detail, then submit update or call. | Session identity is authoritative; stale tab cannot act as the previous tenant/user. |
| E2E-10 | Remove a user's permission while a list/report export is in progress, then retrieve the result URL. | Download revalidates access or uses a short-lived authorized artifact; revoked users cannot retrieve protected data. |

## Execution record template

Copy this table for a run. Keep credentials, tokens, phone numbers, Aadhaar/PAN values, and customer data out of screenshots and test reports.

| Case ID | Build/environment | Profile/tenant | Result (Pass/Fail/Blocked) | Actual response/UI | Evidence reference | Defect |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |

## Completion criteria

1. Every applicable case has a recorded result; cases not supported by the deployed feature set are marked **Not applicable** with a reason, not silently skipped.
2. Authorization is verified at the API boundary for every protected module and mutation.
3. Rejected writes leave no unintended database changes, duplicate records, notifications, assignments, timeline entries, or provider calls.
4. No response, UI message, log, or exported artifact exposes passwords, API keys, session tokens, or another tenant's data.
5. Any behavior whose contract is not yet specified is recorded as a product decision rather than assumed to be a pass.

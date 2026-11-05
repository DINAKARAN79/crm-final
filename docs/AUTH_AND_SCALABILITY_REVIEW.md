# Authentication and concurrency review

## Scope and evidence

The CRM's main browser authentication flow was traced through the Next.js login
route, Express login/auth middleware, browser auth context and API clients,
session-presence service, Prisma `UserSession` model, and API proxy. The
Customer Portal has a separate `cp_token` cookie/JWT flow; it was reviewed for
separation and was not changed. GRE public-form sessions are also independent.

The repository does not contain production incident traces, request metrics, or
database pool telemetry. The confirmed causes below are source-code defects
that can produce the reported symptoms; they do not prove which one caused a
specific historical incident.

## Existing main CRM flow

1. `POST /api/auth/login` in Next.js forwards credentials to Express.
2. Express validates the password, creates a `user_sessions` row, then returns
   a signed 15-minute JWT. The browser stores that JWT in `sessionStorage`.
3. Browser requests pass through the same-origin Next.js proxy with a bearer
   token. Express validates the JWT and loads the user and tenant for each
   authenticated request.
4. The browser sends presence heartbeats while visible. The previous browser
   client also attempted refresh every 15 seconds after user input.
5. Before this change, `/api/auth/refresh` required the existing access JWT.
   There was no separate refresh credential, so an expired access JWT could not
   be refreshed.
6. Both the Axios response interceptor and the `fetch` wrapper immediately
   deleted the token and redirected on any authenticated `401`.

The API uses a shared Prisma client per process. A per-process connection limit
and pool/connect timeouts are now configurable. Session refresh state is stored
in PostgreSQL, not process memory. Roles, permissions, tenant checks, and
impersonation authorization remain server-enforced.

## Confirmed authentication failure paths

1. `authenticate` previously caught JWT errors and unrelated failures from
   session, user, tenant, impersonation, and audit queries in one catch block.
   A database outage or transient query failure was returned as `401 Invalid
   token`. The browser then discarded a valid token. This can affect many users
   at once when they share the same database dependency.
2. Browser clients treated every authenticated `401` as final. They did not
   first try refreshing the access token, and network/5xx errors during auth
   loading could leave a user at the login route despite a still-stored token.
3. The old refresh endpoint was protected by the same expiring access token.
   It was therefore not a recovery path after the 15-minute JWT expiry.
4. Login and heartbeat rate limits were keyed to the API's perceived IP. The
   login proxy did not forward client proxy metadata, and the API did not trust
   its loopback proxy by default. Users behind that proxy could share
   rate-limit buckets. The login limit was 40 requests per 15 minutes; the
   heartbeat limit was 30 requests per minute.
5. The frontend attempted refresh frequently while users interacted, creating
   unnecessary session and user-row writes. Its 15-minute local idle timer also
   differs from the configurable server presence timeout; presence timeout is
   not the same as access-token expiry.

No evidence in the repository establishes a Prisma client leak, duplicate
client-per-user connection creation, clock-skew incident, Node process crash,
or event-loop saturation as the historical cause. The 2 GB production host
alone is not sufficient evidence to diagnose the symptom.

## Implemented changes

- Added per-session, random refresh credentials. Only their SHA-256 hashes and
  expirations are stored in `user_sessions`; raw refresh credentials are sent
  only in per-session `HttpOnly`, `SameSite=Lax` cookies (`Secure` in
  production). Per-session cookie names allow separate tabs/browser sessions
  to rotate independently.
- Added an additive migration for the refresh hash and expiry columns. Normal
  sessions have a rolling 30-day refresh lifetime; impersonation refresh
  credentials cannot outlive the existing impersonation hard expiry.
- Refresh verifies the signed access JWT even after its short access expiry,
  then requires the matching, unexpired, unrevoked database session and refresh
  cookie. It rotates the refresh hash with a conditional database update.
  Revoked sessions cannot be revived; idle-expired presence sessions retain the
  existing presence behavior.
- Browser Axios and `fetch` clients use a shared single-flight refresh promise,
  queue requests behind it, and retry a failed request once. A confirmed
  invalid/expired refresh revokes the browser token; temporary network, 429,
  5xx, and 403 failures do not clear it. Non-replayable streaming fetch bodies
  are not retried.
- Authentication now returns `401` for invalid/expired JWTs and `503` for
  authentication dependency failures. Refresh does not issue a success-shaped
  token if touching or rotating the database session fails.
- Login limits are keyed by a normalized, hashed account identifier and do not
  count successful logins. Heartbeat limits are applied after authentication
  and scoped to the session. The Next.js login proxy forwards client
  `x-forwarded-*` metadata. Express trusts loopback proxy headers by default;
  deployments with other proxy hops must configure `TRUST_PROXY` explicitly
  and ensure their edge proxy overwrites untrusted forwarded headers.
- Removed the 15-second interaction-triggered refresh loop. Heartbeats now use
  the interval returned by the server's presence settings.
- The browser schedules access-token refresh 60 seconds before JWT expiry.
  Temporary refresh failures are retried with bounded exponential backoff;
  Web Locks serialize refresh across tabs where supported, and
  `409 SESSION_REFRESHED` responses are retried for browsers without that lock.
- Recognized database-connection/pool failures during login return `503`;
  unexpected server failures remain `500`. Both are logged as structured auth
  events. The account login limiter does not count server-side `5xx` responses
  as failed credential attempts, so a temporary database outage does not
  consume the account's failed-login allowance.
- Login, identity, and logout proxy requests use a 30-second timeout and return
  `504` on timeout; recognized timeout errors from the general API proxy also
  return `504`, while connection failures return `502`. Login, identity, and
  logout preserve upstream HTTP error statuses, including dependency errors.
- Prisma's singleton client applies configurable per-process connection,
  pool-wait, and connect timeouts. API shutdown closes HTTP connections,
  stops scheduled jobs, and disconnects Prisma gracefully.

## Modified files

- `apps/api/src/middleware/auth.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/impersonation.ts`
- `apps/api/src/services/userPresence.ts`
- `apps/api/src/services/sessionTokens.ts`
- `apps/api/src/index.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/contexts/auth-context.tsx`
- `apps/web/src/app/api/auth/login/route.ts`
- `apps/web/src/app/api/auth/me/route.ts`
- `apps/web/src/app/api/auth/logout/route.ts`
- `apps/web/src/app/api/proxy/[...path]/route.ts`
- `apps/web/src/lib/upstream-error.ts`
- `packages/db/src/index.ts`
- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/20261105130000_session_refresh_tokens/migration.sql`
- `.env.example`
- `apps/api/src/routes/auth.concurrent.test.ts`
- `apps/web/src/lib/api.session-refresh.test.ts`
- `apps/web/src/app/api/auth/login/route.test.ts`
- `apps/web/src/app/api/auth/logout/route.test.ts`
- `apps/web/src/app/api/proxy/[...path]/route.test.ts`
- `apps/web/src/test/customize-home-access.test.tsx`
- `scripts/load-test/crm-auth.js`
- `scripts/load-test/run-crm-auth-stages.sh`
- `docs/AUTH_AND_SCALABILITY_REVIEW.md`

Focused regression tests were added in
`apps/api/src/middleware/sessionGate.test.ts`,
`apps/api/src/routes/auth.refresh.test.ts`,
`apps/api/src/routes/auth.concurrent.test.ts`,
`apps/web/src/lib/api.session-refresh.test.ts`, and
`apps/web/src/app/api/auth/login/route.test.ts`.

## Local migration and deploy precautions

Read-only inspection confirmed the local target is
`localhost:5431/dct_crm`. Prisma found 49 migration folders, while
`_prisma_migrations` contains 18 records: 17 successful and one failed.
`prisma migrate status` reports 31 pending migrations. Two pending folders,
`20261023120000_site_visit_rescheduled_status` and
`20261023121000_mark_rescheduled_site_visits`, have no `migration.sql`.

The failed `20261011180000_commercial_ledger` stopped because
`Quotation.paymentPlan` already existed. Its SQL also creates installment and
allocation tables and a `Receipt` shape that do not match the current Prisma
models; the current local schema has a different `Receipt` model and no
installment/allocation models. Do not mark this legacy migration applied or
retry it until its intended feature state, all partial DDL, and any affected
data have been reconciled.

The live refresh-token columns and unique index are present, but
`20261105130000_session_refresh_tokens` is still pending in migration history.
The live schema diff also reports drift in the CallDetail lead foreign key,
`LayoutAssignment` and `presence_settings` defaults, platform-report audit
columns, telephony defaults, and several indexes. In particular,
`autoDialOnClick` currently defaults to `true`, while the pending
`20261105110000_dialpad_only_autodial_off` changes the default and updates
existing `true` rows to `false`.

No migration or history-resolution command was run. A safe reconciliation
sequence is: back up the local/staging database; recover the two missing
migration definitions from their authoritative source (they are not present in
local Git history); reconcile the failed commercial-ledger migration against
the current data model; review each pending migration against live schema and
data; apply only the approved ordered set in staging; then record migrations as
applied only where their complete effects are verified. Re-run `migrate status`
and schema diff before production review. Do not run `migrate deploy` on this
database or production in its current state.

Existing sessions created before deployment have no refresh-token hash.
Users with those sessions may be asked to sign in again when their current
15-minute access JWT expires. New logins receive refresh credentials.

## Verification results

- API auth integration tests pass for independent sessions at 10, 20, 50, and
  100 mocked users, including database-pool failure recovery. These tests do
  not measure real database or server capacity.
- Browser auth and proxy tests pass for concurrent request single-flight,
  refresh conflict retries, token preservation after 429/503, simulated
  access-token expiry at 20/30/60 minutes, upstream status preservation, and
  502/504 proxy responses. The expiry tests advance simulated time; they are
  not 20-, 30-, or 60-minute live-session runs.
- The latest full API suite reports 502 passed, 5 skipped, and 3 failed tests
  across 4 failing files. Failures are in a missing authorization mock export,
  the API root-route test, lead round-robin assignment, and lead-workflow audit
  expectations; none is in the auth regression tests.
- The latest full web suite, run with `BACKEND_URL=http://127.0.0.1:3001`,
  reports 227 passed and 18 failed tests across 5 failing files. Failures
  include missing React globals in existing components, homepage/navigation
  and lead-duplicate expectations, user lookup rendering, and an existing
  push-to-SVC test import failure. The proxy-header assertion passes when the
  backend URL is configured.
- No customer-portal test script is configured. Workspace typechecks pass;
  API, web, and portal production builds complete. The web build reports
  pre-existing hook-dependency warnings.
- k6 is not installed and no staging account set was supplied. No k6 load run
  was performed.

The reported fixed-interval disconnect and five-minute login failure have not
been reproduced in a live 20-to-60-minute session or with production incident
telemetry. The source-level causes described above are plausible and the
recovery paths have regression tests, but the historical incident's exact
trigger and the absence of all unexpected logout scenarios are not proven.

## Connection and scaling assessment

The Prisma client was already a process-level singleton; it did not create one
client per user. PostgreSQL URL pool settings were previously implicit.
`DATABASE_CONNECTION_LIMIT` defaults to 10, and
`DATABASE_POOL_TIMEOUT`/`DATABASE_CONNECT_TIMEOUT` default to 10 seconds, each
per API process. Set the connection limit so the sum across all app processes
and background workers remains within the database's connection budget.

This is not a claim that the current application supports 100,000 concurrent
active users. For planning only, if each active user causes one API request
every 30 seconds, the request rates are approximately:

| Concurrent active users | Approx. requests/second at 1 request/user/30 seconds |
|---:|---:|
| 10,000 | 333 |
| 25,000 | 833 |
| 50,000 | 1,667 |
| 100,000 | 3,333 |

This estimate excludes page loads, searches, writes, retries, and login bursts.
The current 30-second presence heartbeat also causes database writes; use the
tenant-configured interval (up to 120 seconds) when that presence freshness is
acceptable. Authenticated API requests still perform database-backed identity
and permission work, so the existing monolithic API/database workload must be
measured before final sizing.

Suggested staged AWS direction (planning envelope, not benchmark-proven
capacity):

| Load target | Application direction | Database direction |
|---|---|---|
| 10,000 active | Start with separate web/API Auto Scaling Groups, at least two nodes per tier, behind an ALB; use CloudWatch CPU, memory, latency, and error alarms. | Multi-AZ RDS PostgreSQL; cap aggregate Prisma pools and measure connection/query saturation. |
| 25,000 active | Scale the two stateless tiers independently; add deployment health checks and scale on sustained CPU/latency. | Evaluate PgBouncer or RDS Proxy and a read replica only after identifying read-heavy queries. |
| 50,000 active | Increase horizontally scaled web/API capacity and test rolling deployments/failover under load. | Size RDS from measured CPU, IOPS, locks, and connection use; add read capacity for proven read bottlenecks. |
| 100,000 active | ALB + multi-AZ web/API fleets across AZs; isolate background jobs and apply backpressure to expensive CRM operations. | Managed PostgreSQL with pooling, Multi-AZ backups/PITR, and read replicas where safe; consider Redis for distributed rate-limit/cache coordination only after defining eviction and failure behavior. |

Redis, queues, read replicas, and larger instances were not added because
there is no load profile yet to justify a specific design. The database-backed
refresh token is authoritative across API instances. Existing in-memory
rate-limit stores and short presence/session caches are not distributed stores;
strict cross-instance rate limits and immediate revocation semantics need a
shared store or database design before multi-instance production rollout.

## Production readiness review

- Refresh tokens are 32-byte random secrets, stored as SHA-256 hashes in the
  database and sent as per-session HttpOnly, SameSite=Lax cookies with Secure
  enabled in production. API instances share refresh state through PostgreSQL;
  they must also share a stable `JWT_SECRET`.
- Login limiting and the session-acceptance cache are process-local. Multiple
  API instances can multiply the effective login limit, and a forced logout
  can remain accepted by another instance's five-second cache. Use a shared
  rate-limit/cache store or database-backed coordination before requiring
  strict cross-instance limits or immediate revocation.
- API shutdown stops scheduled jobs, stops accepting new connections, allows
  up to ten seconds for active requests, then closes connections and disconnects
  Prisma. This is code-reviewed, not verified under rolling-deployment load.
- Structured auth metrics, PostgreSQL pool saturation, and query-latency
  telemetry were not available in this environment. Add/verify those monitors
  in staging before increasing traffic; do not rely on client k6 results for
  server resource measurements.
- No AWS deployment/IaC manifests were found in the repository. ALB/Auto
  Scaling, RDS Multi-AZ/PITR backups, pooler sizing, and deployment rollbacks
  therefore remain deployment-owner actions requiring staging verification.

## Load testing and verified results

`scripts/load-test/crm-auth.js` exercises login, authenticated identity, lead
listing, dashboard listing, optional refresh, and optional logout. It emits
RPS, request duration including p95/p99, an auth-success rate, and unexpected
401 counts. The staged runner
`scripts/load-test/run-crm-auth-stages.sh` runs target levels of 100, 1,000,
5,000, 10,000, 25,000, 50,000, and 100,000 VUs sequentially; override
`CRM_USER_STAGES` to select a smaller set. It uses unique pre-created accounts
through `CRM_EMAIL_TEMPLATE` with a `{vu}` placeholder above 40 VUs. Remote
targets require both `CRM_ALLOW_REMOTE_LOAD=yes` and
`CRM_TARGET_ENV=isolated-staging`. Never point it at production.

Example for an isolated local/staging environment:

```bash
CRM_BASE_URL=http://localhost:3000 \
CRM_USER_STAGES="100 1000" \
CRM_EMAIL_TEMPLATE='load-{vu}@example.test' \
CRM_PASSWORD='<isolated-test-account-password>' \
CRM_REFRESH_EVERY_ITERATION=true \
CRM_LOGOUT_EVERY_ITERATION=true \
bash scripts/load-test/run-crm-auth-stages.sh
```

For a remote isolated staging target, also set
`CRM_ALLOW_REMOTE_LOAD=yes` and `CRM_TARGET_ENV=isolated-staging`. Provide the
password through a protected environment/secret mechanism rather than a
committed file.

```bash
k6 run \
  -e CRM_BASE_URL=http://localhost:3000 \
  -e CRM_TARGET_USERS=10 \
  -e 'CRM_EMAIL_TEMPLATE=load-{vu}@example.test' \
  -e CRM_PASSWORD='<isolated-test-account-password>' \
  -e CRM_REFRESH_EVERY_ITERATION=true \
  -e CRM_LOGOUT_EVERY_ITERATION=true \
  scripts/load-test/crm-auth.js
```

The API concurrency tests simulate 10, 20, 50, and 100 independent sessions
with mocked persistence and verify login, refresh, request identity, and
logout. This verifies functional isolation but is not a real database or
capacity test. No k6 binary is installed and no staging account set was
provided, so actual RPS, p95/p99, auth success under load, process CPU/RAM,
PostgreSQL connection/query utilization, and maximum verified capacity remain
**unmeasured**. The maximum verified real concurrent-user capacity is **not
established**. Do not claim 100,000-user support without successful isolated
load-test evidence.

The scripts do not create or mutate CRM business records but do create
authentication sessions and issue read requests. Provision enough isolated
test accounts and database capacity first. Collect Node.js CPU/RAM and
PostgreSQL pool/query metrics externally (for example via staging
CloudWatch/Performance Insights); k6 cannot measure those server-side values
itself. Never run destructive or unbounded tests on production.

## Deployment and rollback

1. Back up PostgreSQL and reconcile the existing pending/failed migration
   history before applying any migration. Validate the session migration and
   the full intended migration set in staging first.
2. Configure a stable, identical `JWT_SECRET` on every web/API instance.
   Configure `TRUST_PROXY` for the actual trusted proxy chain (for a colocated
   Next.js proxy, `loopback`; for remote proxies, their exact IP/CIDR ranges).
3. Set per-process database pool variables based on the aggregate PostgreSQL
   connection budget. Use a managed pooler if the measured instance count
   exceeds the database's connection limit.
4. Deploy the API/schema-compatible release, then the web release. Verify
   health, fresh login, expiry-triggered refresh, logout, independent browser
   sessions, tenant boundaries, and impersonation on staging.
5. Monitor auth 401/403/429/5xx, refresh success/failure, API latency, process
   restarts, CPU/memory, PostgreSQL connections, slow queries, and locks before
   increasing traffic.
6. For rollback, redeploy the previous application images. Keep the two added
   nullable columns and index; the old release ignores them. Do not drop the
   migration or columns during rollback. Existing migrated data is preserved.

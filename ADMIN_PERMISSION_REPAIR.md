# Admin permission repair runbook

Do not use `prisma migrate deploy` or `prisma migrate reset` for this repair. The SQL scripts are additive and can be run directly with `psql`; no production database was accessed while preparing them.

## AWS procedure

1. **Take an RDS snapshot** — backup required; no database changes.
2. **Connect to the direct RDS endpoint** (not RDS Proxy or PgBouncer) and select the production database — connection only.
3. Run `scripts/check-telephony-permission.sql` and `scripts/check-admin-permissions.sql`; save both outputs — read-only.
4. Run `scripts/repair-telephony-permission.sql` — changes telephony schema/data additively; snapshot required.
5. Run `scripts/repair-admin-permissions.sql` — inserts missing catalog rows, reactivates the default Admin permission definitions if disabled, and adds missing default Admin grants; does not delete or reduce grants. Snapshot required.
6. Run both check scripts again and confirm they pass — read-only.
7. Restart the API to clear in-memory permission state and run `npm run postdeploy:check-permissions` — API restart is operational; the check is read-only.
8. Hard-refresh the CRM, open the lead Enquiry tab, and verify profiles and telephony work — browser-only.

The admin-permission SQL is also copied to `packages/db/prisma/migrations/20261104130000_admin_permission_repair/migration.sql` for migration history consistency, but use the standalone SQL in this runbook if Prisma migration history blocks execution.

Use the direct-endpoint connection URL supplied securely in your shell as `DATABASE_URL`:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/check-telephony-permission.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/check-admin-permissions.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/repair-telephony-permission.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/repair-admin-permissions.sql
```

Run the first two commands before repair and repeat them after both repairs.

## Post-deploy check

With the deployment's `DATABASE_URL` set, run:

```sh
npm run postdeploy:check-permissions
```

The check exits non-zero and names missing catalog permissions, missing grants, or inactive default Admin definitions. It does not repair data.

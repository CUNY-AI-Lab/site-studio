# Legacy Account Import Removal

- Status: temporary operational runbook
- Owner: Site Studio maintainers
- Due: the configured `CAIL_ACCOUNT_IMPORT_UNTIL` instant, no later than 30 days after `CAIL_SSO_SWITCHED_AT`
- Scope: temporary authenticated legacy-account import only

The authenticated import path is available only during the configured
`CAIL_SSO_SWITCHED_AT` to `CAIL_ACCOUNT_IMPORT_UNTIL` window. The checked-in
Wrangler configuration leaves identity enforcement disabled and does not set
the window; repository state is not proof that a production import is active.

Review `site_studio.diagnostic.*` events and their bounded `error.type` values
before removal:

- `account_import_completed`: an anonymous namespace finished importing.
- `account_import_not_started` or `account_import_expired`: an authenticated
  request presented an old session outside the half-open import window.
- `account_import_config_invalid` and the specific configuration error codes:
  the deadline contract was absent or invalid.
- `account_import_migration_failed`: an import attempt failed and may have left
  a resumable marker or partial destination data.
- `account_import_pending_cleanup_failed`: an expired resume marker could not
  be deleted and needs operational cleanup.

By the configured `CAIL_ACCOUNT_IMPORT_UNTIL` deadline:

1. Before the deadline, review telemetry and inventory unresolved
   `migration-pending:<subject>` KV markers and `migration:<anonymousUserId>`
   coordinator state. A conditional-copy conflict deliberately preserves both
   namespaces and leaves the claim pending; reconcile the differing destination
   object before resuming. Handle ownership drift also leaves import pending.
2. Confirm the configured deadline has passed. After cutoff, session handling
   deletes the pending marker and replaces the legacy cookie; normal requests
   no longer resume the old namespace. Any remaining recovery is an explicit
   operator procedure, not an automatic retry.
3. Remove the deadline parser and the two deadline variables.
4. Remove the import trigger from authenticated session handling.
5. Remove migration-only coordinator and resume machinery only after verifying
   that no pending imports remain.
6. Retire remaining anonymous session records according to their storage
   lifecycle; do not use public URL reachability as a deletion signal.
7. Keep the public compatibility tests in
   `packages/app/src/routes/regressions.test.ts` and
   `packages/worker/src/index.test.ts` passing.

## Permanent Exception

Legacy published URLs require permanent support. The
`/sites/:userId/:slug/*` routes must continue to:

- redirect to `/u/:handle/:slug/*` when the resolved owner has a handle;
- serve published content directly when the owner has no handle; and
- follow `projects/<anonymousUserId>/.migrated.json` pointers after account
  import so old deep links keep resolving to the live migrated project.

Do not delete `/sites` routing as part of temporary import cleanup.

When a migration pointer remaps a colliding slug, the legacy 301 must use the
mapped slug in its `/u/` destination. Keep that regression covered when the
temporary import implementation is removed.

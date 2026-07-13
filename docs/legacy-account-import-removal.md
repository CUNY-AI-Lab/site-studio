# Legacy Account Import Removal

- Owner: Site Studio maintainers
- Due: the configured `CAIL_ACCOUNT_IMPORT_UNTIL` instant, no later than 30 days after `CAIL_SSO_SWITCHED_AT`
- Scope: temporary authenticated legacy-account import only

The authenticated import path is available only during the configured
`CAIL_SSO_SWITCHED_AT` to `CAIL_ACCOUNT_IMPORT_UNTIL` window. Review Workers
Logs for these structured events before removal:

- `account_import.completed`: an old anonymous namespace finished importing.
- `account_import.refused`: an authenticated request presented an old session
  outside the window.
- `account_import.config_invalid`: the deadline contract was absent or invalid.
- `account_import.pending_cleanup_failed`: an expired resume marker could not
  be deleted and needs operational cleanup.

By the configured `CAIL_ACCOUNT_IMPORT_UNTIL` deadline:

1. Confirm the configured deadline has passed and review account-import
   telemetry for unresolved users.
2. Remove the deadline parser and the two deadline variables.
3. Remove the import trigger from authenticated session handling.
4. Remove migration-only coordinator and resume machinery only after verifying
   that no pending imports remain.
5. Retire remaining anonymous session records according to their storage
   lifecycle; do not use public URL reachability as a deletion signal.
6. Keep the public compatibility tests in
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

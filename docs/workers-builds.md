# Cloudflare Workers Builds production setup

This repository contains the build entrypoint and GitHub release receiver for
making Cloudflare Workers Builds the primary Site Studio release gate. Connecting
the repository or changing the production trigger is an operator action.

Configure the existing `site-studio-app` Worker with these settings:

| Setting | Value |
| --- | --- |
| Git repository | `CUNY-AI-Lab/site-studio` |
| Production branch | `main` |
| Root directory | `/packages/app/` |
| Build command | `cd ../.. && bun run workers:build` |
| Deploy command | `true` |
| Non-production branch builds | Disabled |
| Build watch include paths | `*` |
| Build watch exclude paths | none |
| Build cache | Disabled |

Enter the root directory in Cloudflare's slash-delimited dashboard form exactly
as `/packages/app/`. It contains the Worker configuration, which Cloudflare uses
to locate this project. The build command returns to the repository root so Bun
installs and runs the complete workspace with the root lockfile. The deploy
command is deliberately a no-op: GitHub observes Cloudflare's completed check run
and remains the only production writer.

Set these production-trigger build variables and secrets:

| Name | Value | Kind |
| --- | --- | --- |
| `NODE_VERSION` | `24.18.0` | variable |
| `BUN_VERSION` | `1.3.14` | variable |
| `SKIP_DEPENDENCY_INSTALL` | `1` | variable |
| `NODE_AUTH_TOKEN` | GitHub personal access token (classic) with `read:packages` | secret |

`SKIP_DEPENDENCY_INSTALL=1` is deliberate. The repository entrypoint owns the
locked `bun install --frozen-lockfile`, and fails before installing when the
GitHub Packages token or exact Node and Bun versions are absent. Keep
`NODE_VERSION=24.18.0` aligned with the checked-in `.node-version` and `.nvmrc`.
This prevents the command's move from `/packages/app/` to the repository root
from selecting the old Node 20 runtime for jsdom and undici subprocesses.
`bunfig.toml` sends the package token only to the `@cuny-ai-lab` scope at
`npm.pkg.github.com`. GitHub requires a classic token even for public npm
packages; the token's user must be able to read the three CAIL packages in the
lockfile. Do not add the token to source, a command, or a plain build variable.

Select a Workers Builds API token for the existing `site-studio-app` project as
required by the Cloudflare connection flow. The no-op deploy command does not use
it to publish the Worker. Remove `GITHUB_RELEASE_TOKEN` from Workers Builds; the
Cloudflare GitHub App's check run triggers the receiver without a repository
credential held by Cloudflare.

The build entrypoint verifies the Cloudflare-supplied branch and commit metadata,
runs the frozen install, high-severity audit, repository lint, app tests and type
checks, frontend checks, Chromium download, local browser acceptance, the
production frontend/template build, and a Wrangler dry-run. The Workers path
does not use Playwright's `--with-deps` option because that invokes privileged OS
package installation, which the Cloudflare build user cannot perform. GitHub CI
keeps its `--with-deps` installation. On Cloudflare's Ubuntu Noble image, the
entrypoint uses writable apt state and cache directories with the current build
user as `APT::Sandbox::User`. It downloads and extracts the ten missing runtime
packages into a unique temporary directory, prepends their
`usr/lib/x86_64-linux-gnu` directory to `LD_LIBRARY_PATH` only for browser
acceptance, and removes the temporary tree whether the browser passes or fails.
No root access or system package mutation is required. The browser launch and
full local journey remain the acceptance check. The gate uses deterministic
local bindings; it is integration acceptance, not native R2, Durable Object, or
provider coverage.

Cloudflare marks `Workers Builds: site-studio-app` successful only after the build
and no-op deploy command finish. The GitHub receiver accepts only a completed,
successful `check_run` from Cloudflare app ID `85455`, slug
`cloudflare-workers-and-pages`, with that exact check name, a full lowercase head
SHA, and a lowercase UUID in `external_id`. Before checkout, it queries the check
run by ID through GitHub's API and requires the stored record to match every event
field and the current public `main` SHA. It checks out that exact SHA, rechecks
both HEAD and `main` immediately before mutation, and uses the existing
`site-studio-production` concurrency group. It deploys with the SHA as both the
version tag and part of the message, reads back the single 100% version, canonical
CAIL API binding, and `CAIL_IDENTITY_JWKS` name without reading the secret value,
then runs the existing exact-version public readiness probes.

## Release-order limitation

Workers Builds currently permits concurrent builds at the account level and has
no documented per-Worker concurrency group or serialized production queue. A
native deploy command cannot make its Git ref check and Cloudflare promotion one
atomic operation, so two overlapping production builds could still publish out
of order. `wrangler deploy --strict` protects against conflicting remote
configuration; it is not a commit-order lock.

Therefore Workers Builds is the authoritative install/check/browser/bundle gate,
while GitHub remains the narrow release receiver. The receiver's concurrency
group and immediate current-main check reject an older queued SHA before it can
deploy. This split preserves the existing ordering guarantee and keeps version,
binding, secret-name, and production readiness readback beside the deployment.
The Cloudflare build completes before GitHub receives the `check_run` event, so
Cloudflare cannot report the later GitHub release result. GitHub is the
authoritative release status.

Cloudflare build `de958ae6-f643-4489-90f5-c43ef0f35bd6` and GitHub Actions run
`34765801594` proved the complete path on exact main commit
`5d5d63d4fa25939887e010ad213ec7f5ca5b6825`, including the serialized deployment,
version and binding readback, secret-name check, and production readiness probes.
After this source change is merged, set the GitHub repository variable
`CLOUDFLARE_WORKERS_BUILDS_PRIMARY` to exactly `true` to complete the cutover.
GitHub expression comparisons ignore case, so a small push-only job resolves the
variable with a case-sensitive shell comparison. Exact lowercase `true` skips the
app, frontend, browser, aggregate verification, and deploy jobs for push-to-main
events. Pull requests continue to run every check, and a qualifying Cloudflare
`check_run` continues to run the serialized deploy job. Leaving the variable
unset or assigning any other value retains the push-to-main checks and deployment
as the rollback path.

Non-production builds stay disabled because Site Studio's checked-in bindings
name production R2, KV, and Durable Object state, there is no staging topology,
and Cloudflare does not generate preview URLs for Workers that implement Durable
Objects. Pull requests continue to use GitHub Actions checks until a separate,
state-isolated preview configuration exists.

# Cloudflare Workers Builds production setup

This repository contains the build and deploy entrypoints for making Cloudflare
Workers Builds the primary Site Studio release runner. Connecting the repository
or changing the production trigger is an operator action. Keep the GitHub Actions
workflow enabled until a Workers Build has completed this whole path and the
cutover has been reviewed.

Configure the existing `site-studio-app` Worker with these settings:

| Setting | Value |
| --- | --- |
| Git repository | `CUNY-AI-Lab/site-studio` |
| Production branch | `main` |
| Root directory | `/packages/app/` |
| Build command | `cd ../.. && bun run workers:build` |
| Deploy command | `cd ../.. && bun run workers:dispatch-release` |
| Non-production branch builds | Disabled |
| Build watch include paths | `*` |
| Build watch exclude paths | none |
| Build cache | Disabled |

Enter the root directory in Cloudflare's slash-delimited dashboard form exactly
as `/packages/app/`. It contains the Worker configuration, which Cloudflare uses
to locate this project. The two commands return to the repository root so Bun
installs and runs the complete workspace with the root lockfile.

Set these production-trigger build variables and secrets:

| Name | Value | Kind |
| --- | --- | --- |
| `BUN_VERSION` | `1.3.14` | variable |
| `SKIP_DEPENDENCY_INSTALL` | `1` | variable |
| `NODE_AUTH_TOKEN` | GitHub personal access token (classic) with `read:packages` | secret |
| `GITHUB_RELEASE_TOKEN` | Fine-grained GitHub token limited to this repository with Actions: write | secret |

`SKIP_DEPENDENCY_INSTALL=1` is deliberate. The repository entrypoint owns the
locked `bun install --frozen-lockfile`, and fails before installing when the
GitHub Packages token or exact Bun version is absent. `bunfig.toml` sends that
token only to the `@cuny-ai-lab` scope at `npm.pkg.github.com`. GitHub requires a
classic token even for public npm packages; the token's user must be able to read
the three CAIL packages in the lockfile. Do not add the token to source, a command,
or a plain build variable.

`GITHUB_RELEASE_TOKEN` creates a workflow dispatch for `.github/workflows/ci.yml`.
GitHub requires Actions: write for that endpoint. Limit the token to this
repository and keep it separate from the classic GitHub Packages token. It does
not need Contents, Packages, administration, or workflow-file write permission.
Actions: write can also operate this repository's workflow runs and workflow
enablement, so treat the token as a write credential. The dispatch entrypoint
sends the exact passed SHA and Workers Build UUID as declared inputs and returns
after GitHub accepts the event; it never polls the receiver.

Select a Workers Builds API token for the existing `site-studio-app` project as
required by the Cloudflare connection flow. The Cloudflare deploy command does
not use it to publish the Worker: the checked-in deploy entrypoint dispatches the
passed build to GitHub so the existing serialized release job remains the only
production writer.

The build entrypoint verifies the Cloudflare-supplied branch and commit metadata,
runs the frozen install, high-severity audit, repository lint, app tests and type
checks, frontend checks, Chromium installation, local browser acceptance, the
production frontend/template build, and a Wrangler dry-run. The local browser
gate uses deterministic local bindings; it is integration acceptance, not native
R2, Durable Object, or provider coverage. A first Workers Build must demonstrate
that Playwright's Linux dependency installer is supported by the current build
image. Do not waive the browser gate if the image changes.

After every gate passes, the build writes an ephemeral marker containing its SHA
and Cloudflare build UUID. The deploy entrypoint rejects any branch other than
`main`, requires Cloudflare's metadata and that marker to match the checked-out
commit, resolves public `origin/main`, and sends one `workflow_dispatch` event
targeting `main` with the passed SHA and Workers Build UUID as inputs.
The GitHub receiver checks out that exact SHA, rejects it if `main` advanced, and
uses the existing `site-studio-production` concurrency group. It deploys with the
SHA as both the version tag and part of the message, reads back the single 100%
version, canonical CAIL API binding, and `CAIL_IDENTITY_JWKS` name without reading
the secret value, then runs the existing exact-version public readiness probes.

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
The Cloudflare build will be complete once GitHub accepts the event; Cloudflare
cannot report the later GitHub release result because the entrypoint deliberately
does not poll another runner. GitHub is the authoritative release status.

The current push-triggered GitHub checks and deploy remain enabled during
preparation. Once a real Workers Build and dispatched receiver run have succeeded,
remove only the push-to-main deploy path in a separate reviewed change. Keep the
pull-request checks and the `workflow_dispatch` receiver.

Non-production builds stay disabled because Site Studio's checked-in bindings
name production R2, KV, and Durable Object state, there is no staging topology,
and Cloudflare does not generate preview URLs for Workers that implement Durable
Objects. Pull requests continue to use GitHub Actions checks until a separate,
state-isolated preview configuration exists.

# Site Studio: Dynamic Worker Architecture Plan

## Decision

This is workable as a greenfield Cloudflare app if we treat Site Studio as a static-file site builder and make Dynamic Workers part of the agent execution path:

- project files live in R2
- preview and published output are served directly from Cloudflare
- the agent uses Codemode plus Dynamic Worker Loader for multi-step project work
- clarification remains first-class
- approval is no longer the core UX
- runtime shell / package-install / build-tool execution stays out of scope

## Product Model

The right interaction model for Site Studio is:

- execute by default
- show visible tool activity
- ask focused follow-up questions when ambiguity matters
- add snapshot / restore later instead of blocking approval gates

That matches observed user behavior better than diff approval.

## Core Technical Choices

### 1. One same-origin Cloudflare app

Keep the editor, API, preview, and published-site routes on the same Worker app. That preserves preview behavior and keeps cookies simple.

### 2. R2 is the project system of record

Use:

- `projects/{userId}/{projectId}/{filePath}`
- `projects/{userId}/{projectId}/.metadata.json`
- `uploads/{userId}/{filename}`

### 3. Agents SDK for chat state

Use a project-scoped `AIChatAgent` for:

- persisted messages
- streaming
- resumable sessions
- clarification tool round-trips

### 4. Dynamic Worker Loader for execution

The agent should expose a single `codemode` tool backed by `DynamicWorkerExecutor`.

Inside that sandbox, the model writes JavaScript that uses typed project APIs such as:

- `project.list_files`
- `project.read_file`
- `project.search_files`
- `project.write_file`
- `project.edit_file`
- `project.rename_file`
- `project.delete_file`
- `project.scaffold_template`
- `project.add_page`

External network access stays blocked with `globalOutbound: null`.

### 5. Clarification yes, approval no

Keep `ask_user_question` for layout/content/design ambiguities.

Do not make file writes pause for approval. Users are not meaningfully reviewing diffs, so that friction does not buy us much.

### 6. Static-file preview only

Preview serves project files directly from R2:

- directory requests resolve to `index.html`
- HTML responses can be cache-busted for refreshes
- no build pipeline

## Architecture

```text
SvelteKit frontend
    |
    v
Cloudflare Worker app
  |- Hono routes
  |- SiteBuilderAgent (Durable Object)
  |- R2 project storage
  |- KV-backed sessions
  |- Worker Loader binding
  |- DynamicWorkerExecutor
          |
          v
   Dynamic Worker sandbox
      |- generated JS from the model
      |- typed project APIs
      |- no outbound network
```

## What Stays Out of Scope

- Hugo / npm / Jekyll / Astro / Next.js builds
- shell commands
- local filesystem storage
- R2-to-filesystem sync
- Express compatibility layers
- migration plumbing

## Compatibility We Actually Care About

This is still a new app, but two continuity features are worth preserving:

- old published sites continue to resolve from the same R2 bucket and `/sites/:userId/:slug/*`
- returning anonymous users can still see earlier projects if their legacy `site-studio-session` cookie resolves to the old R2 session record

Those are compatibility reads, not a migration strategy.

## Implementation Phases

### Phase 1: Platform foundation

- Worker app
- Hono routes
- R2 / KV / DO bindings
- Worker Loader binding
- session middleware

Acceptance:

- app runs under Wrangler
- session cookie is stable
- R2 and Worker Loader are available

### Phase 2: Project and file surface

- project CRUD
- file CRUD
- uploads / downloads
- preview
- publish / unpublish
- ZIP export

Acceptance:

- a project can be created, edited, previewed, published, and exported

### Phase 3: Agent plus Codemode

- `SiteBuilderAgent`
- Model wiring (now via the CAIL model proxy; Workers AI models only)
- `codemode` tool backed by `DynamicWorkerExecutor`
- `ask_user_question`
- project operations exposed under a `project.*` namespace in the sandbox

Acceptance:

- a real chat turn invokes `codemode`
- sandboxed code reads and writes project files
- clarification flow still works

### Phase 4: Frontend execution UX

- Cloudflare chat transport in the editor
- running tool cards
- clarification card
- preview refresh after sandboxed edits
- remove approval controls from the normal path

Acceptance:

- a browser user can request a change and see it land in preview without approval clicks

### Phase 5: Hardening

- better result summaries from codemode runs
- version history / snapshot strategy
- upload/file parsing improvements
- publish polish

Acceptance:

- failed runs are recoverable
- users can understand what changed without reading generated code

## Current Recommendation

Proceed with the Dynamic Worker architecture already underway:

- keep the Worker app as the control plane
- keep R2 as the source of truth
- keep the app static-file oriented
- use Codemode for multi-step project work
- treat approval as optional future behavior, not a core requirement

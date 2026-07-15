# Site Studio contributor pointer

Follow [`AGENTS.md`](AGENTS.md) for project-specific agent instructions and
[`README.md`](README.md) for the current architecture, Bun development commands,
configuration, routes, and compatibility contract.

Before making security, storage, publishing, migration, WebSocket, autosave, or
recovery claims, read
[`docs/security-and-recovery.md`](docs/security-and-recovery.md). Adopted
project/file mutations run through the owner-scoped coordinator, while R2 itself
still has no multi-object transaction and publishing remains a live visibility
flag rather than an immutable release.

For current observability behavior, use
[`docs/cail-log-alignment.md`](docs/cail-log-alignment.md).

Use Bun (`bun install`, `bun run dev`, `bun run check`), not npm, Yarn, or pnpm.
Local Worker secrets belong in `packages/app/.dev.vars` and must not be
committed.

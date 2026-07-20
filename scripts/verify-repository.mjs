import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(message) {
  failures.push(message);
}

function repositoryFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8"
  }).split("\0").filter(Boolean);
}

const files = repositoryFiles();

for (const forbidden of [
  ".dev.vars",
  ".env",
  ".site-studio-debug-session.json"
]) {
  if (files.some((file) => file === forbidden || file.endsWith(`/${forbidden}`))) {
    fail(`tracked secret-bearing file: ${forbidden}`);
  }
}

const secretPatterns = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "Stripe live secret", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ }
];

for (const file of files) {
  if (extname(file) === ".png" || extname(file) === ".zip") continue;
  let content;
  try {
    content = readFileSync(resolve(root, file), "utf8");
  } catch {
    continue;
  }
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(content)) fail(`${name} pattern in ${file}`);
  }
  if (
    file.startsWith("packages/frontend/src/") &&
    /https:\/\/fonts\.(?:googleapis|gstatic)\.com\//.test(content)
  ) {
    fail(`third-party Google Fonts request in authenticated frontend source: ${file}`);
  }
}

const markdownFiles = files.filter(
  (file) => file === "README.md" || file === "AGENTS.md" || file === "CLAUDE.md" || (
    file.startsWith("docs/") && file.endsWith(".md")
  )
);
const markdownLink = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

for (const file of markdownFiles) {
  const content = readFileSync(resolve(root, file), "utf8");
  for (const match of content.matchAll(markdownLink)) {
    const target = match[1].replace(/^<|>$/g, "");
    if (
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target) ||
      target.startsWith("/")
    ) {
      continue;
    }
    const localPath = decodeURIComponent(target.split("#", 1)[0]);
    if (localPath && !existsSync(resolve(root, dirname(file), localPath))) {
      fail(`broken local Markdown link in ${file}: ${target}`);
    }
  }
}

const appWrangler = readFileSync(resolve(root, "packages/app/wrangler.jsonc"), "utf8");
for (const binding of [
  '"name": "SITE_BUILDER_AGENT"',
  '"name": "MIGRATION_COORDINATOR"',
  '"name": "MUTATION_COORDINATOR"'
]) {
  if (!appWrangler.includes(binding)) fail(`missing Durable Object binding ${binding}`);
}
for (const migration of [
  '"tag": "v1",\n      "new_sqlite_classes": ["SiteBuilderAgent"]',
  '"tag": "v2",\n      "new_sqlite_classes": ["MigrationCoordinator"]',
  '"tag": "v3",\n      "new_sqlite_classes": ["MutationCoordinator"]'
]) {
  if (!appWrangler.includes(migration)) fail(`missing or reordered Wrangler migration: ${migration}`);
}

const ciWorkflowPath = ".github/workflows/ci.yml";
const ciWorkflow = readFileSync(resolve(root, ciWorkflowPath), "utf8");
const remoteActionUses = [...ciWorkflow.matchAll(/^\s*-\s+uses:\s+([^@\s]+)@([^\s#]+)/gm)];
for (const [, action, revision] of remoteActionUses) {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    fail(`GitHub Action is not pinned to an immutable SHA: ${action}@${revision}`);
  }
}
if (
  !/uses:\s+actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+persist-credentials:\s+false/.test(
    ciWorkflow
  )
) {
  fail("checkout must set persist-credentials: false");
}
const packageTokenUses = ciWorkflow.match(/NODE_AUTH_TOKEN:/g) ?? [];
if (
  packageTokenUses.length !== 1 ||
  !/- name: Install dependencies\n\s+run: bun install --frozen-lockfile\n\s+env:\n\s+NODE_AUTH_TOKEN: \$\{\{ secrets\.CAIL_PACKAGES_TOKEN \}\}/.test(
    ciWorkflow
  )
) {
  fail("CAIL_PACKAGES_TOKEN must be scoped only to the frozen dependency-install step");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Repository verification passed (${markdownFiles.length} docs, ${files.length} repository files).`
  );
}

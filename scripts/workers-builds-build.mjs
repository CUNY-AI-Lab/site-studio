import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_BUN_VERSION = "1.3.14";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GATE_DIRECTORY = resolve(ROOT, ".workers-builds");
const GATE_PATH = resolve(GATE_DIRECTORY, "passed.json");

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function runText(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return result.stdout.trim();
}

function runLane(label, command, args) {
  console.log(`[${label}] starting`);
  const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
  return new Promise((resolveLane, rejectLane) => {
    child.once("error", rejectLane);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        console.log(`[${label}] passed`);
        resolveLane();
        return;
      }
      rejectLane(new Error(`${label} failed with ${signal ? `signal ${signal}` : `status ${code}`}`));
    });
  });
}

async function runQualityLanes() {
  const chromiumInstallScript = process.platform === "linux" ? "e2e:install:ci" : "e2e:install";
  const lanes = [
    runLane("dependency audit", "bun", ["audit", "--audit-level=high"]),
    runLane("repository lint", "bun", ["run", "lint"]),
    runLane("app checks", "bun", ["run", "--cwd", "packages/app", "check"]),
    runLane("frontend checks", "bun", ["run", "--cwd", "packages/frontend", "check"]),
    runLane("Chromium install", "bun", ["run", chromiumInstallScript]),
  ];
  const results = await Promise.allSettled(lanes);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure.reason);
    throw new Error(`${failures.length} Workers Builds quality lane(s) failed`);
  }
}

function verifyWorkersBuildEnvironment() {
  if (requiredEnvironment("WORKERS_CI") !== "1") throw new Error("WORKERS_CI must be 1");
  if (requiredEnvironment("WORKERS_CI_BRANCH") !== "main") {
    throw new Error("Workers Builds production must run only for main");
  }
  const buildSha = requiredEnvironment("WORKERS_CI_COMMIT_SHA");
  if (!SHA_PATTERN.test(buildSha)) throw new Error("WORKERS_CI_COMMIT_SHA must be a full lowercase commit SHA");
  const buildUuid = requiredEnvironment("WORKERS_CI_BUILD_UUID");
  if (!UUID_PATTERN.test(buildUuid)) throw new Error("WORKERS_CI_BUILD_UUID must be a lowercase UUID");
  if (runText("git", ["rev-parse", "HEAD"]) !== buildSha) {
    throw new Error("WORKERS_CI_COMMIT_SHA does not match the checked-out commit");
  }
  requiredEnvironment("NODE_AUTH_TOKEN");
  if (runText("bun", ["--version"]) !== EXPECTED_BUN_VERSION) {
    throw new Error(`Workers Builds must use Bun ${EXPECTED_BUN_VERSION}`);
  }
  return { buildSha, buildUuid };
}

const { buildSha, buildUuid } = verifyWorkersBuildEnvironment();
run("bun", ["install", "--frozen-lockfile"]);
await runQualityLanes();

run("bun", ["run", "--cwd", "packages/frontend", "build"]);
run("bun", ["scripts/local-browser-e2e.ts"]);

run("bun", ["run", "--cwd", "packages/app", "predeploy"]);
run(resolve(ROOT, "packages/app/node_modules/.bin/wrangler"), [
  "deploy",
  "--dry-run",
  "--config",
  "packages/app/wrangler.jsonc",
  "--outdir",
  ".wrangler-dry-run/app",
]);

mkdirSync(GATE_DIRECTORY, { recursive: true });
writeFileSync(GATE_PATH, `${JSON.stringify({ buildSha, buildUuid })}\n`, { mode: 0o600 });
console.log("Workers Builds source, browser, and bundle validation passed");

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_BUN_VERSION = "1.3.14";
const EXPECTED_NODE_VERSION = "v24.18.0";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BROWSER_LIBRARY_PACKAGES = [
  "libatk1.0-0t64",
  "libatk-bridge2.0-0t64",
  "libxcomposite1",
  "libxdamage1",
  "libxfixes3",
  "libxi6",
  "libxrandr2",
  "libxkbcommon0",
  "libasound2t64",
  "libatspi2.0-0t64",
];
const BROWSER_LIBRARY_SONAMES = [
  "libatk-1.0.so.0",
  "libatk-bridge-2.0.so.0",
  "libXcomposite.so.1",
  "libXdamage.so.1",
  "libXfixes.so.3",
  "libXi.so.6",
  "libXrandr.so.2",
  "libxkbcommon.so.0",
  "libasound.so.2",
  "libatspi.so.0",
];

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function run(command, args, cwd = ROOT, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function prepareLinuxBrowserLibraries() {
  if (process.platform !== "linux") return null;

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "site-studio-browser-libs-"));
  const aptLists = resolve(temporaryRoot, "apt/lists");
  const aptCache = resolve(temporaryRoot, "apt/cache");
  const aptArchives = resolve(aptCache, "archives");
  const downloads = resolve(temporaryRoot, "downloads");
  const extracted = resolve(temporaryRoot, "root");

  try {
    for (const path of [resolve(aptLists, "partial"), resolve(aptArchives, "partial"), downloads, extracted]) {
      mkdirSync(path, { recursive: true });
    }
    const aptOptions = [
      "-o",
      `Dir::State::lists=${aptLists}`,
      "-o",
      `Dir::Cache=${aptCache}`,
      "-o",
      `Dir::Cache::archives=${aptArchives}`,
      "-o",
      `APT::Sandbox::User=${runText("id", ["-un"])}`,
    ];
    run("apt-get", [...aptOptions, "update"]);
    run("apt-get", [...aptOptions, "download", ...BROWSER_LIBRARY_PACKAGES], downloads);

    const packages = readdirSync(downloads)
      .filter((file) => file.endsWith(".deb"))
      .sort();
    if (packages.length !== BROWSER_LIBRARY_PACKAGES.length) {
      throw new Error(`Expected ${BROWSER_LIBRARY_PACKAGES.length} browser library packages, found ${packages.length}`);
    }
    for (const file of packages) run("dpkg-deb", ["--extract", resolve(downloads, file), extracted]);

    const libraryPath = resolve(extracted, "usr/lib/x86_64-linux-gnu");
    for (const soname of BROWSER_LIBRARY_SONAMES) {
      if (!existsSync(resolve(libraryPath, soname))) throw new Error(`Browser library package did not provide ${soname}`);
    }
    return { libraryPath, temporaryRoot };
  } catch (error) {
    rmSync(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
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
  const lanes = [
    runLane("dependency audit", "bun", ["audit", "--audit-level=high"]),
    runLane("repository lint", "bun", ["run", "lint"]),
    runLane("app checks", "bun", ["run", "--cwd", "packages/app", "check"]),
    runLane("frontend checks", "bun", ["run", "--cwd", "packages/frontend", "check"]),
    runLane("Chromium install", "bun", ["run", "e2e:install"]),
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
  if (runText("node", ["--version"]) !== EXPECTED_NODE_VERSION) {
    throw new Error(`Workers Builds must use Node ${EXPECTED_NODE_VERSION.slice(1)}`);
  }
}

verifyWorkersBuildEnvironment();
run("bun", ["install", "--frozen-lockfile"]);
await runQualityLanes();

run("bun", ["run", "--cwd", "packages/frontend", "build"]);
const browserLibraries = prepareLinuxBrowserLibraries();
try {
  const browserEnvironment = browserLibraries
    ? {
        ...process.env,
        LD_LIBRARY_PATH: [browserLibraries.libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
      }
    : process.env;
  run("bun", ["scripts/local-browser-e2e.ts"], ROOT, browserEnvironment);
} finally {
  if (browserLibraries) rmSync(browserLibraries.temporaryRoot, { force: true, recursive: true });
}

run("bun", ["run", "--cwd", "packages/app", "predeploy"]);
run(resolve(ROOT, "packages/app/node_modules/.bin/wrangler"), [
  "deploy",
  "--dry-run",
  "--config",
  "packages/app/wrangler.jsonc",
  "--outdir",
  ".wrangler-dry-run/app",
]);

console.log("Workers Builds source, browser, and bundle validation passed");

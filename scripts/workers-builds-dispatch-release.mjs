import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_PATH = resolve(ROOT, ".workers-builds/passed.json");
const MAIN_REF = "refs/heads/main";
const MAIN_REMOTE = "https://github.com/CUNY-AI-Lab/site-studio.git";
const DISPATCH_URL =
  "https://api.github.com/repos/CUNY-AI-Lab/site-studio/actions/workflows/ci.yml/dispatches";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function runText(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return result.stdout.trim();
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${description} was not valid JSON`, { cause: error });
  }
}

function currentMainSha() {
  const output = runText("git", ["ls-remote", "--exit-code", MAIN_REMOTE, MAIN_REF]);
  const [sha, ref, extra] = output.split(/\s+/);
  if (!SHA_PATTERN.test(sha) || ref !== MAIN_REF || extra !== undefined) {
    throw new Error("Could not resolve exactly one origin main commit");
  }
  return sha;
}

function verifyPassedGate() {
  if (requiredEnvironment("WORKERS_CI") !== "1") throw new Error("WORKERS_CI must be 1");
  if (requiredEnvironment("WORKERS_CI_BRANCH") !== "main") {
    throw new Error("Workers Builds production must run only for main");
  }
  const buildSha = requiredEnvironment("WORKERS_CI_COMMIT_SHA");
  const buildUuid = requiredEnvironment("WORKERS_CI_BUILD_UUID");
  if (!SHA_PATTERN.test(buildSha)) throw new Error("WORKERS_CI_COMMIT_SHA must be a full lowercase commit SHA");
  if (!UUID_PATTERN.test(buildUuid)) throw new Error("WORKERS_CI_BUILD_UUID must be a lowercase UUID");
  if (runText("git", ["rev-parse", "HEAD"]) !== buildSha) {
    throw new Error("WORKERS_CI_COMMIT_SHA does not match the checked-out commit");
  }

  const gate = parseJson(readFileSync(GATE_PATH, "utf8"), "Workers Builds gate marker");
  if (gate.buildSha !== buildSha || gate.buildUuid !== buildUuid) {
    throw new Error("Workers Builds gate marker does not match this build and commit");
  }
  const mainSha = currentMainSha();
  if (mainSha !== buildSha) {
    throw new Error(`main advanced to ${mainSha}; refusing to dispatch stale commit ${buildSha}`);
  }
  return { buildSha, buildUuid };
}

const dryRun = process.argv.length === 3 && process.argv[2] === "--dry-run";
if (!dryRun && process.argv.length !== 2) throw new Error("Unexpected command-line arguments");

const { buildSha, buildUuid } = verifyPassedGate();
const payload = {
  ref: "main",
  inputs: { release_sha: buildSha, workers_build_uuid: buildUuid },
};

if (dryRun) {
  console.log(`Workers Builds release dispatch is ready for ${buildSha} (${buildUuid})`);
} else {
  const token = requiredEnvironment("GITHUB_RELEASE_TOKEN");
  const response = await fetch(DISPATCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`GitHub workflow dispatch failed with status ${response.status}: ${detail}`);
  }
  console.log(`Dispatched exact main commit ${buildSha} to the serialized GitHub release receiver`);
}

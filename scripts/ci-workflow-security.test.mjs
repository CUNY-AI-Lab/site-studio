import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

test("CI protects action and package credentials in one validation job", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /^permissions:\n  contents: read\n  packages: read$/m);
  assert.doesNotMatch(workflow, /^\s{4}env:/m, "jobs must not have shared environments");
  assert.doesNotMatch(workflow, /uses:\s+\S+@v\d+/);
  assert.match(workflow, /^  verify:\n/m);
  const jobs = workflow.split(/^jobs:\n/m)[1] ?? "";
  assert.deepEqual(
    jobs.match(/^  [a-z][a-z-]*:\n/gm),
    ["  verify:\n", "  deploy:\n"],
    "CI should keep one validation job and one serialized production deploy job",
  );

  const validationJob = workflow.split(/^  deploy:\n/m)[0] ?? "";
  const repositoryCheckBlocks = validationJob.match(
    /      - run: bun run check/g,
  ) ?? [];
  assert.equal(
    repositoryCheckBlocks.length,
    1,
    "CI must run the authoritative repository check",
  );

  for (const action of [
    "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  ]) {
    assert.equal(
      validationJob.split(action).length - 1,
      1,
      `${action} must appear once in the validation job`,
    );
  }

  assert.equal(
    validationJob.split("persist-credentials: false").length - 1,
    1,
    "checkout must disable credential persistence",
  );

  const installBlocks = workflow.match(
    /      - name: Install dependencies\n        run: bun install --frozen-lockfile\n        env:\n          NODE_AUTH_TOKEN: \$\{\{ github\.token \}\}/g,
  ) ?? [];
  assert.equal(
    installBlocks.length,
    2,
    "validation and deploy jobs must scope the token to frozen installs",
  );
  assert.equal(
    workflow.split("NODE_AUTH_TOKEN:").length - 1,
    installBlocks.length,
    "the package token must not appear outside install steps",
  );
  assert.doesNotMatch(workflow, /CAIL_PACKAGES_TOKEN/);

  const deployJob = workflow.split(/^  deploy:\n/m)[1] ?? "";
  assert.match(deployJob, /^    needs: verify$/m);
  assert.match(deployJob, /^    permissions:\n      contents: read\n      packages: read$/m);
  assert.match(deployJob, /^      group: site-studio-production$/m);
  assert.match(deployJob, /versions list --name site-studio-app --json/);
  assert.match(deployJob, /deployments list --name site-studio-app --json/);
  assert.ok(deployJob.includes("workers/message"));
  assert.match(deployJob, /versions view "\$version_id" --name site-studio-app --json/);
  assert.match(deployJob, /\.versions\[0\]\.version_id == \$id and \.versions\[0\]\.percentage == 100/);
  assert.match(deployJob, /select\(\.annotations\["workers\/message"\] == \$message\)/);
  assert.match(deployJob, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.equal(validationJob.split("CLOUDFLARE_API_TOKEN:").length - 1, 0);
  assert.equal(deployJob.split("CLOUDFLARE_API_TOKEN:").length - 1, 3);
  assert.match(deployJob, /probe_auth_envelope\(\) \{/);
  assert.match(
    deployJob,
    /probe_auth_envelope "\$API_URL" "\$worker_body" "\$worker_headers" \\\n\s+&& probe_auth_envelope "\$DOORWAY_API_URL" "\$doorway_body" "\$doorway_headers"/,
    "readiness must require exact direct-worker and Doorway auth envelopes",
  );
  assert.match(
    deployJob,
    /if ! jq -e --arg id "\$EXPECTED_VERSION_ID"[\s\S]*?sleep 2\n\s+continue\n\s+fi/,
    "stale health must keep polling instead of failing the job",
  );
});

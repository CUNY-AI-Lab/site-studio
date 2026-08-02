import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("publisher route configuration", () => {
  // The public hostname's zone (cuny.qzz.io) lives in the legacy personal
  // Cloudflare account, and Workers routes cannot cross accounts. This config
  // now targets the CUNY AI Lab account, so it must declare NO zone routes:
  // deploying a route for a zone outside the account would fail, and the
  // legacy personal publisher keeps serving tools.cuny.qzz.io/sites/* and
  // /u/* until the zone (or its routing) is migrated in an explicit,
  // separately approved cutover.
  it("declares no zone routes while the public zone lives in another account", () => {
    const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../wrangler.jsonc");
    const jsonc = readFileSync(configPath, "utf8");
    const config = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, "")) as {
      routes?: Array<{ pattern?: string }>;
      workers_dev?: boolean;
    };

    expect(config.routes).toBeUndefined();
    // Without zone routes the worker must still be reachable for verification.
    expect(config.workers_dev).toBe(true);
  });
});

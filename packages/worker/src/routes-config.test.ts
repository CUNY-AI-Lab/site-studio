import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("publisher route configuration", () => {
  it("routes both legacy and canonical published URLs", () => {
    const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../wrangler.jsonc");
    const jsonc = readFileSync(configPath, "utf8");
    const config = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, "")) as {
      routes?: Array<{ pattern?: string }>;
    };
    const patterns = config.routes?.map((route) => route.pattern);

    expect(patterns).toContain("tools.cuny.qzz.io/sites/*");
    expect(patterns).toContain("tools.cuny.qzz.io/u/*");
  });
});

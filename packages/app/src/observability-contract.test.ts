import { describe, expect, it } from "vitest";
import {
  CAIL_LOG_ENVIRONMENTS,
  parseCailLogEnvironment,
} from "./lib/observability/contract";
import { createHealthRouter } from "./routes/health";
import type { Env } from "./types";

describe("observability contract", () => {
  it("accepts only the exact cail-log environment vocabulary", () => {
    expect(CAIL_LOG_ENVIRONMENTS).toEqual([
      "production",
      "staging",
      "development",
      "test",
    ]);
    expect(CAIL_LOG_ENVIRONMENTS.every((value) => parseCailLogEnvironment(value) === value)).toBe(true);
    for (const value of [undefined, null, "", " production", "production ", "PRODUCTION", "qa"]) {
      expect(parseCailLogEnvironment(value)).toBeUndefined();
    }
  });

  it("returns a stable, no-store app liveness response with null local metadata", async () => {
    const response = await createHealthRouter().request(
      "https://app.example/api/health",
      {},
      // SAFETY: Health liveness only reads the optional logging environment.
      { CAIL_LOG_ENV: "test" } as Env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      schema_version: "cail.health.v1",
      status: "ok",
      check: "liveness",
      marker: "site-studio-app:alive:v1",
      product_id: "site-studio",
      service: {
        name: "site-studio-app",
        version: "0.1.0",
      },
      version_id: null,
      version_tag: null,
    });
  });

  it("returns exact canonical Cloudflare version metadata when present", async () => {
    const response = await createHealthRouter().request(
      "https://app.example/api/health",
      {},
      // SAFETY: Version metadata fixture matches Cloudflare's binding shape.
      {
        CAIL_LOG_ENV: "test",
        CF_VERSION_METADATA: {
          id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
          tag: "0123456789abcdef0123456789abcdef01234567",
          timestamp: "2026-08-07T12:00:00.000Z",
        },
      } as Env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version_id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
      version_tag: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("nulls non-canonical version metadata", async () => {
    const response = await createHealthRouter().request(
      "https://app.example/api/health",
      {},
      // SAFETY: Invalid metadata fixture is deliberately passed through the Env boundary.
      {
        CAIL_LOG_ENV: "test",
        CF_VERSION_METADATA: {
          id: "095F00A7-23A7-43B7-A227-E4C97CAB5F22",
          tag: "release-2026-08-07",
          timestamp: "2026-08-07T12:00:00.000Z",
        },
      } as Env,
    );
    expect(await response.json()).toMatchObject({
      version_id: null,
      version_tag: null,
    });
  });

});

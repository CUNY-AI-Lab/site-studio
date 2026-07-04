import { describe, it, expect } from "vitest";
import {
  CAIL_APP_SLUG,
  DEFAULT_CAIL_MODEL,
  buildProxyBaseUrl,
  buildProxyHeaders,
  createCailModel,
  resolveModelId,
} from "./model";

describe("buildProxyBaseUrl", () => {
  it("appends the OpenAI-compatible AI Gateway path", () => {
    expect(buildProxyBaseUrl("https://cail.example/proxy")).toBe(
      "https://cail.example/proxy/v1/compat"
    );
  });

  it("normalizes a trailing slash so the path is not doubled", () => {
    expect(buildProxyBaseUrl("https://cail.example/proxy/")).toBe(
      "https://cail.example/proxy/v1/compat"
    );
  });
});

describe("buildProxyHeaders", () => {
  it("always sends the X-CAIL-App spend-attribution slug", () => {
    const headers = buildProxyHeaders(null);
    expect(headers["X-CAIL-App"]).toBe(CAIL_APP_SLUG);
    expect(CAIL_APP_SLUG).toBe("site-studio");
  });

  it("forwards the caller identity JWT when present", () => {
    const headers = buildProxyHeaders("jwt-token");
    expect(headers["X-CAIL-Identity-JWT"]).toBe("jwt-token");
    expect(headers["X-CAIL-App"]).toBe("site-studio");
  });

  it("omits the identity header when there is no JWT (proxy fails closed)", () => {
    const headers = buildProxyHeaders(null);
    expect(headers).not.toHaveProperty("X-CAIL-Identity-JWT");
  });

  it("never carries a provider Authorization header", () => {
    const headers = buildProxyHeaders("jwt-token");
    expect(headers).not.toHaveProperty("Authorization");
  });
});

describe("resolveModelId", () => {
  it("uses CAIL_MODEL when set", () => {
    expect(resolveModelId({ CAIL_MODEL: "some/model" })).toBe("some/model");
  });

  it("falls back to the default model", () => {
    expect(resolveModelId({})).toBe(DEFAULT_CAIL_MODEL);
  });
});

describe("createCailModel", () => {
  it("throws when CAIL_API_BASE is not configured (no key fallback)", () => {
    expect(() => createCailModel({}, "jwt")).toThrow(/CAIL_API_BASE/);
  });

  it("builds a language model bound to the proxy compat path", () => {
    const model = createCailModel(
      { CAIL_API_BASE: "https://cail.example/proxy", CAIL_MODEL: "anthropic/claude-sonnet-4.6" },
      "jwt-token"
    );
    // createOpenAICompatible returns a model object (not the bare string branch
    // of the LanguageModel union); assert on its metadata.
    expect(typeof model).toBe("object");
    const meta = model as { modelId: string; provider: string };
    expect(meta.modelId).toBe("anthropic/claude-sonnet-4.6");
    expect(meta.provider).toContain("cail");
  });
});

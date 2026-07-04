import { describe, it, expect } from "vitest";
import { generateText } from "ai";
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

  it("defaults to a Workers AI catalog id (CAIL policy: Cloudflare models only)", () => {
    expect(DEFAULT_CAIL_MODEL).toMatch(/^@cf\//);
  });
});

describe("createCailModel", () => {
  it("throws when CAIL_API_BASE is not configured (no key fallback)", () => {
    expect(() => createCailModel({}, "jwt")).toThrow(/CAIL_API_BASE/);
  });

  it("builds a language model bound to the proxy compat path", () => {
    const model = createCailModel(
      { CAIL_API_BASE: "https://cail.example/proxy", CAIL_MODEL: "@cf/openai/gpt-oss-120b" },
      "jwt-token"
    );
    // createOpenAICompatible returns a model object (not the bare string branch
    // of the LanguageModel union); assert on its metadata.
    expect(typeof model).toBe("object");
    const meta = model as { modelId: string; provider: string };
    expect(meta.modelId).toBe("@cf/openai/gpt-oss-120b");
    expect(meta.provider).toContain("cail");
  });
});

/**
 * Wire-level pin for the CAIL one-credential contract (docs/INTEGRATION.md,
 * commit 9a46de3): a model-proxy request must send exactly ONE credential. On
 * the browser/JWT path that is X-CAIL-Identity-JWT and there must be NO
 * Authorization header — the proxy is JWT-first/strict. We assert on the
 * CAPTURED OUTBOUND HEADERS a real request emits, so an SDK upgrade that starts
 * stamping a dummy `Authorization: Bearer` (some OpenAI-compatible SDKs do when
 * given an apiKey) fails this test instead of silently breaking the proxy.
 */
describe("createCailModel wire contract", () => {
  /** Minimal valid OpenAI-style chat-completions body — enough for doGenerate. */
  const chatCompletionResponse = () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "@cf/openai/gpt-oss-120b",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  /**
   * Build a fetch stub that records the outbound headers as a case-insensitive
   * `Headers` object, then returns a canned successful completion.
   */
  function makeCaptureFetch(): { fetch: typeof fetch; captured: () => Headers } {
    let seen: Headers | undefined;
    const stub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      // The provider-utils POST path calls fetch(url, init) with init.headers as
      // a plain object; wrap it in Headers for robust case-insensitive lookup.
      seen = new Headers((init?.headers ?? {}) as HeadersInit);
      return chatCompletionResponse();
    }) as typeof fetch;
    return { fetch: stub, captured: () => seen ?? new Headers() };
  }

  it("JWT path: sends X-CAIL-Identity-JWT and X-CAIL-App, never Authorization", async () => {
    const { fetch: stub, captured } = makeCaptureFetch();
    const model = createCailModel(
      { CAIL_API_BASE: "https://cail.example/proxy", CAIL_MODEL: "@cf/openai/gpt-oss-120b" },
      "jwt-token",
      stub
    );

    await generateText({ model, prompt: "hi" });

    const headers = captured();
    // (a) no provider Authorization header on the JWT path
    expect(headers.has("authorization")).toBe(false);
    // (b) the caller identity travels in X-CAIL-Identity-JWT
    expect(headers.get("x-cail-identity-jwt")).toBe("jwt-token");
    // (c) spend attribution slug is always present
    expect(headers.get("x-cail-app")).toBe("site-studio");
  });

  it("anonymous path: no Authorization and no identity JWT, but X-CAIL-App still present", async () => {
    const { fetch: stub, captured } = makeCaptureFetch();
    const model = createCailModel(
      { CAIL_API_BASE: "https://cail.example/proxy", CAIL_MODEL: "@cf/openai/gpt-oss-120b" },
      null,
      stub
    );

    await generateText({ model, prompt: "hi" });

    const headers = captured();
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-cail-identity-jwt")).toBe(false);
    expect(headers.get("x-cail-app")).toBe("site-studio");
  });
});

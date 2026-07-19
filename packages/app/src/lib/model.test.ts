import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { CailError } from "@cuny-ai-lab/cail-client";
import { cailErrorEnvelope, cailErrorResponse, quotaExceededEnvelope } from "@cuny-ai-lab/cail-client/testing";
import {
  CAIL_APP_SLUG,
  DEFAULT_CAIL_MODEL,
  assertCailJwtFresh,
  createCailModel,
  resolveModelId,
} from "./model";

describe("model-call JWT expiry guard", () => {
  const token = (exp: number) => `header.${btoa(JSON.stringify({ exp })).replace(/=/g, "")}.signature`;

  it("fails before an outbound model call when the connection JWT is expiring", () => {
    expect(() => assertCailJwtFresh(token(100), 90_000, 15)).toThrow("identity expired");
  });

  it("accepts a token with enough lifetime for the next gateway call", () => {
    expect(() => assertCailJwtFresh(token(120), 90_000, 15)).not.toThrow();
  });
});

describe("CAIL_APP_SLUG", () => {
  it("is the stable spend-attribution slug for this tool", () => {
    expect(CAIL_APP_SLUG).toBe("site-studio");
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

  it("throws when the caller has no identity JWT (gateway is JWT-first/strict)", () => {
    expect(() =>
      createCailModel({ CAIL_API_BASE: "https://cail.example/proxy" }, null)
    ).toThrow(/identity JWT/i);
  });

  it("builds a language model bound to the gateway chat endpoint", () => {
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

/** The adapter throws gateway-declared non-retryable errors before SDK retry logic. */
describe("gateway quota errors at the adapter boundary", () => {
  it("propagates the thrown CailError verbatim without retrying", async () => {
    const verbatim = "You have used your hourly AI quota. It resets on the hour.";
    let calls = 0;
    const upstream = (async () => {
      calls += 1;
      return cailErrorResponse(
        429,
        quotaExceededEnvelope({ message: verbatim, retryAfterSeconds: 1800 }),
        {
          "retry-after": "1800",
          "x-request-id": "req-site-quota-1",
          "x-should-retry": "false",
        }
      );
    }) as typeof fetch;
    const model = createCailModel({ CAIL_API_BASE: "https://cail.example" }, "jwt", upstream);

    let thrown: unknown;
    try {
      await generateText({ model, prompt: "hi" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CailError);
    const cailError = thrown as CailError;
    expect(cailError.code).toBe("quota_exceeded");
    expect(cailError.status).toBe(429);
    expect(cailError.message).toBe(verbatim);
    expect(cailError.extras.retry_after_seconds).toBe(1800);
    expect(cailError.extras.retry_after).toBe("1800");
    expect(cailError.extras.request_id).toBe("req-site-quota-1");
    expect(cailError.extras.should_retry).toBe(false);
    expect(calls).toBe(1);
  });

  it("throws a gateway-declared non-retryable authentication error without retrying", async () => {
    let calls = 0;
    const upstream = (async () => {
      calls += 1;
      return cailErrorResponse(
        401,
        cailErrorEnvelope({
          message: "Sign in to use CAIL models.",
          type: "authentication_error",
          code: "authentication_required",
          cail: { login_url: "/login" },
        }),
        {
          "x-request-id": "req-site-auth-1",
          "x-should-retry": "false",
        }
      );
    }) as typeof fetch;
    const model = createCailModel({ CAIL_API_BASE: "https://cail.example" }, "jwt", upstream);

    const thrown = await generateText({ model, prompt: "hi" }).catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      name: "CailError",
      message: "Sign in to use CAIL models.",
      status: 401,
      code: "authentication_required",
      extras: expect.objectContaining({
        request_id: "req-site-auth-1",
        should_retry: false,
      }),
    });
    expect(calls).toBe(1);
  });

  it("permits plaintext only for an explicit loopback development gateway", () => {
    expect(() => createCailModel({ CAIL_API_BASE: "http://localhost:8787" }, "jwt"))
      .not.toThrow();
    expect(() => createCailModel({ CAIL_API_BASE: "http://gateway.example" }, "jwt"))
      .toThrow(/HTTPS|loopback/i);
  });
});

/**
 * Wire-level pin for the CAIL one-credential contract: a model-proxy request
 * must send exactly ONE credential. On the browser/JWT path that is
 * X-CAIL-Identity-JWT and there must be NO Authorization header — the gateway
 * is JWT-first/strict. The AI SDK is handed a dummy apiKey (it refuses to run
 * without one), so the cail-client chatFetch adapter MUST strip the resulting
 * `Authorization: Bearer cail-proxy` before the request reaches the wire. We
 * assert on the CAPTURED OUTBOUND REQUEST at the underlying fetch (the
 * adapter's test seam), so a regression in either the SDK or the adapter
 * fails this test instead of silently breaking the gateway.
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
   * Build a fetch stub that records the outbound URL and headers (as a
   * case-insensitive `Headers` object), then returns a canned completion.
   */
  function makeCaptureFetch(): {
    fetch: typeof fetch;
    captured: () => { url: string; headers: Headers };
  } {
    let seen: { url: string; headers: Headers } | undefined;
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // cail-client calls fetchImpl(url, init) with init.headers as a plain
      // record; wrap it in Headers for robust case-insensitive lookup.
      seen = {
        url: String(input),
        headers: new Headers((init?.headers ?? {}) as HeadersInit),
      };
      return chatCompletionResponse();
    }) as typeof fetch;
    return {
      fetch: stub,
      captured: () => seen ?? { url: "", headers: new Headers() },
    };
  }

  it("sends X-CAIL-Identity-JWT and X-CAIL-App to /v1/chat/completions, never Authorization", async () => {
    const { fetch: stub, captured } = makeCaptureFetch();
    const model = createCailModel(
      { CAIL_API_BASE: "https://cail.example/proxy", CAIL_MODEL: "@cf/openai/gpt-oss-120b" },
      "jwt-token",
      stub
    );

    await generateText({ model, prompt: "hi" });

    const { url, headers } = captured();
    // (a) the new gateway contract: the OpenAI-compatible chat endpoint
    expect(url).toBe("https://cail.example/proxy/v1/chat/completions");
    // (b) the adapter stripped the SDK's dummy bearer — no Authorization on
    //     the JWT path
    expect(headers.has("authorization")).toBe(false);
    // (c) the caller identity travels in X-CAIL-Identity-JWT
    expect(headers.get("x-cail-identity-jwt")).toBe("jwt-token");
    // (d) spend attribution slug is always present
    expect(headers.get("x-cail-app")).toBe("site-studio");
  });
});

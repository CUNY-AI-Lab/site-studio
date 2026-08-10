import { describe, it, expect } from "vitest";
import { generateText, isLoopFinished, streamText, tool } from "ai";
import { z } from "zod";
import { extractCailError } from "@cuny-ai-lab/cail-client";
import { cailErrorEnvelope, cailErrorResponse, quotaExceededEnvelope } from "@cuny-ai-lab/cail-client/testing";
import {
  CAIL_APP_SLUG,
  DEFAULT_CAIL_MODEL,
  assertCailJwtFresh,
  canonicalCailApiBase,
  createCailAuthorityFetch,
  createCailModel,
  resolveModelId,
} from "./model";

const VALID_REQUEST_ID = "019f8bdc-342a-76e1-ba71-005d69808f86";

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
    expect(resolveModelId({ CAIL_MODEL: "@cf/some/model" })).toBe("@cf/some/model");
  });

  it("rejects a non-Cloudflare model override", () => {
    expect(() => resolveModelId({ CAIL_MODEL: "some/model" }))
      .toThrow("CAIL_MODEL must be a Cloudflare Workers AI model id");
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
  it("preserves the typed CAIL envelope through the direct provider without retrying", async () => {
    const verbatim = "You have used your hourly AI quota. It resets on the hour.";
    let calls = 0;
    const upstream = (async () => {
      calls += 1;
      return cailErrorResponse(
        429,
        quotaExceededEnvelope({ message: verbatim, retryAfterSeconds: 1800 }),
        {
          "retry-after": "1800",
          "x-request-id": VALID_REQUEST_ID,
          "x-should-retry": "false",
        }
      );
    }) as typeof fetch;
    const model = createCailModel({ CAIL_API_BASE: "https://cail.example" }, "jwt", upstream);

    let thrown: unknown;
    try {
      await generateText({ model, prompt: "hi", maxRetries: 0 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ name: "AI_APICallError", statusCode: 429 });
    const cailError = extractCailError(thrown);
    expect(cailError).not.toBeNull();
    if (!cailError) throw new Error("expected a typed CAIL error");
    expect(cailError.code).toBe("quota_exceeded");
    expect(cailError.status).toBe(429);
    expect(cailError.message).toBe(verbatim);
    expect(cailError.extras.retry_after_seconds).toBe(1800);
    expect(cailError.extras.retry_after).toBe("1800");
    // The direct provider keeps the response headers available to the CAIL
    // extractor, which promotes valid UUID request ids into typed extras.
    expect(cailError.extras.request_id).toBe(VALID_REQUEST_ID);
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

    const thrown = await generateText({ model, prompt: "hi", maxRetries: 0 }).catch((error: unknown) => error);

    expect(thrown).toMatchObject({ name: "AI_APICallError" });
    expect(extractCailError(thrown)).toMatchObject({
      message: "Sign in to use CAIL models.",
      status: 401,
      code: "authentication_required",
      extras: expect.objectContaining({
        login_url: "/login",
        should_retry: false,
      }),
    });
    // A malformed synthetic request-id header is intentionally ignored.
    expect(extractCailError(thrown)?.extras).not.toHaveProperty("request_id");
    expect(calls).toBe(1);
  });

  it("permits plaintext only for an explicit loopback development gateway", () => {
    expect(() => createCailModel({ CAIL_API_BASE: "http://localhost:8787" }, "jwt"))
      .not.toThrow();
    expect(() => createCailModel({ CAIL_API_BASE: "http://gateway.example" }, "jwt"))
      .toThrow(/HTTPS|loopback/i);
  });

  it("rejects unsafe gateway bases before any provider request", () => {
    for (const base of [
      "http://gateway.example",
      "https://user:password@gateway.example",
      "https://gateway.example?token=secret",
      "https://gateway.example#fragment",
      " https://gateway.example",
      "https://gateway.example ",
      "https://gateway.example/path with spaces",
      "https://gateway.example/\u0000",
      "not-a-url",
    ]) {
      expect(() => canonicalCailApiBase(base)).toThrow(/CAIL_API_BASE/);
    }
    expect(canonicalCailApiBase("https://gateway.example///")).toBe("https://gateway.example");
  });
});

/**
 * Wire-level pins for the direct OpenAI-compatible contract. The final fetch
 * seam owns the bearer and app headers and strips per-call authority.
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

  it("continues after a streamed tool call until the model returns text", async () => {
    let calls = 0;
    const requestBodies: Array<Record<string, unknown>> = [];
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      const response = calls === 1
        ? {
            id: "chatcmpl-tool-call",
            object: "chat.completion.chunk",
            created: 0,
            model: "@cf/openai/gpt-oss-120b",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  id: "call_lookup",
                  type: "function",
                  function: {
                    name: "lookup",
                    arguments: '{"query":"status"}',
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
          }
        : {
            id: "chatcmpl-tool-result",
            object: "chat.completion.chunk",
            created: 0,
            model: "@cf/openai/gpt-oss-120b",
            choices: [{
              index: 0,
              delta: { content: "The status is ready." },
              finish_reason: "stop",
            }],
          };
      return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const model = createCailModel(
      { CAIL_API_BASE: "https://cail.example", CAIL_MODEL: "@cf/openai/gpt-oss-120b" },
      "jwt",
      upstream,
    );

    const result = streamText({
      model,
      messages: [{ role: "user", content: "Check the status." }],
      tools: {
        lookup: tool({
          description: "Look up a status.",
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => ({ query, status: "ready" }),
        }),
      },
      stopWhen: isLoopFinished(),
      maxRetries: 0,
    });
    const chunks = [];
    for await (const chunk of result.fullStream) {
      chunks.push(chunk);
    }

    expect(calls).toBe(2);
    expect(chunks.some((chunk) => chunk.type === "tool-result")).toBe(true);
    expect(await result.text).toBe("The status is ready.");
    expect(JSON.stringify(requestBodies[1])).toContain('"role":"tool"');
    expect(JSON.stringify(requestBodies[1])).toContain("call_lookup");
  });

  it("sends one verified bearer and X-CAIL-App to /v1/chat/completions", async () => {
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
    expect(headers.get("authorization")).toBe("Bearer jwt-token");
    expect(headers.get("x-cail-identity-jwt")).toBeNull();
    expect(headers.get("x-cail-app")).toBe("site-studio");
    expect(captured().headers.get("cookie")).toBeNull();
  });

  it("strips hostile authority/routing headers on buffered and streaming calls", async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown>; init: RequestInit }> = [];
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(input), headers, body, init: init ?? {} });
      if (body.stream === true) {
        return new Response(
          'data: {"id":"chatcmpl-stream","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
            "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return chatCompletionResponse();
    }) as typeof fetch;
    const model = createCailModel({ CAIL_API_BASE: "https://cail.example" }, "verified-jwt", stub);
    const hostileHeaders = {
      Authorization: "Bearer attacker",
      Cookie: "session=attacker",
      "X-CAIL-App": "attacker-app",
      "X-CAIL-Identity-JWT": "attacker-jwt",
      "X-CAIL-Request-Id": "attacker-request",
      "cf-aig-provider": "attacker-provider",
      "cf-aig-cache-ttl": "9999",
      "x-openwebui-model": "attacker-model",
      "x-provider-key": "attacker-key",
      "Content-Type": "text/plain",
      Accept: "text/plain",
    };

    await generateText({ model, prompt: "hello", headers: hostileHeaders, maxRetries: 0 });
    const streamed = streamText({ model, prompt: "hello", headers: hostileHeaders, maxRetries: 0 });
    for await (const _part of streamed.textStream) {
      // Consume the stream so the provider performs its actual fetch.
    }

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://cail.example/v1/chat/completions");
      expect(call.headers.get("authorization")).toBe("Bearer verified-jwt");
      expect(call.headers.get("x-cail-app")).toBe("site-studio");
      expect(call.headers.get("x-cail-identity-jwt")).toBeNull();
      expect(call.headers.get("x-cail-request-id")).toBeNull();
      expect(call.headers.get("cookie")).toBeNull();
      expect(call.headers.get("cf-aig-provider")).toBeNull();
      expect(call.headers.get("cf-aig-cache-ttl")).toBeNull();
      expect(call.headers.get("x-openwebui-model")).toBeNull();
      expect(call.headers.get("x-provider-key")).toBeNull();
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("accept")).toBe("text/plain");
      expect(call.init.credentials).toBe("omit");
      expect(call.init.redirect).toBe("manual");
    }
  });

  it.each([302, 429, 503])("makes exactly one attempt for a %s gateway response", async (status) => {
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "upstream failure" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const model = createCailModel({ CAIL_API_BASE: "https://cail.example" }, "jwt", stub);
    await generateText({ model, prompt: "hello", maxRetries: 0 }).catch(() => undefined);
    expect(calls).toBe(1);
  });

  it("makes exactly one attempt when the gateway connection is ambiguous", async () => {
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      throw new TypeError("connection reset");
    }) as typeof fetch;
    const model = createCailModel({ CAIL_API_BASE: "https://cail.example" }, "jwt", stub);
    await generateText({ model, prompt: "hello", maxRetries: 0 }).catch(() => undefined);
    expect(calls).toBe(1);
  });

  it("checks JWT freshness immediately before a billed request", async () => {
    const expired = `header.${btoa(JSON.stringify({ exp: 1 })).replace(/=/g, "")}.signature`;
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      return chatCompletionResponse();
    }) as typeof fetch;
    const model = createCailModel({ CAIL_API_BASE: "https://cail.example" }, expired, stub);
    await generateText({ model, prompt: "hello", maxRetries: 0 }).catch(() => undefined);
    expect(calls).toBe(0);
  });

  it("sanitizes authority headers owned by a Request input as well as init", async () => {
    let captured: Headers | undefined;
    const authorityFetch = createCailAuthorityFetch("verified-jwt", (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      captured = new Headers(init?.headers);
      return chatCompletionResponse();
    }) as typeof fetch);
    const request = new Request("https://cail.example/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer attacker",
        Cookie: "session=attacker",
        "X-CAIL-Identity-JWT": "attacker-jwt",
        "X-Provider-Key": "attacker-key",
      },
      body: "{}",
    });

    await authorityFetch(request);
    expect(captured?.get("authorization")).toBe("Bearer verified-jwt");
    expect(captured?.get("x-cail-app")).toBe("site-studio");
    expect(captured?.get("cookie")).toBeNull();
    expect(captured?.get("x-cail-identity-jwt")).toBeNull();
    expect(captured?.get("x-provider-key")).toBeNull();
  });
});

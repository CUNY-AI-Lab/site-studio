import { describe, it, expect } from "vitest";
import { cailErrorResponse, quotaExceededEnvelope } from "@cuny-ai-lab/cail-client/testing";
import {
  DEFAULT_CAIL_IMAGE_MODEL,
  DEFAULT_CAIL_IMAGE_CLASSIFIER,
  GENERATED_IMAGE_REJECTED_MESSAGE,
  IMAGE_MODERATION_INSTRUCTION,
  clampDimension,
  generateImage,
  resolveImageClassifierId,
  resolveImageModelId,
  runGenerateImageFlow,
  screenImage,
  type CailImageEnv,
  type GenerateImageFlowDeps
} from "./image-generation";

const BASE = "https://cail.example/proxy";
const env: CailImageEnv = { CAIL_API_BASE: BASE };

/** A minimal valid PNG (signature + a byte) so sniffImageType-style checks pass. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PNG_BASE64 = btoa(String.fromCharCode(...PNG_BYTES));

function expiredJwt(): string {
  return `header.${btoa(JSON.stringify({ exp: 1 })).replaceAll("=", "")}.signature`;
}

type Captured = { url: string; init: RequestInit; headers: Headers };
type CaptureFetch = {
  fetch: typeof fetch;
  captured: () => Captured;
  calls: () => number;
};
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ModerationPart = { type: "image_url"; image_url: { url: string } } | { type: string; text?: string };
type ModerationBody = {
  model: string;
  input: { prompt: string; width: number; height: number };
  messages: Array<{ content: string | ModerationPart[] }>;
  response_format: JsonValue;
};

/** Fetch stub that records the outbound request and returns a canned response. */
function captureFetch(response: () => Response): CaptureFetch {
  let seen: Captured | undefined;
  let callCount = 0;
  // SAFETY: The stub implements the Fetch API call signature and returns real
  // Response objects for this provider-boundary test.
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1;
    seen = {
      url: String(input),
      init: init ?? {},
      headers: new Headers(init?.headers)
    };
    return response();
  }) as typeof fetch;
  return {
    fetch: stub,
    captured: () => seen ?? { url: "", init: {}, headers: new Headers() },
    calls: () => callCount
  };
}

function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("model id policy (CAIL: Cloudflare models only)", () => {
  it("image-generation default is a @cf/ Workers AI id", () => {
    expect(DEFAULT_CAIL_IMAGE_MODEL).toMatch(/^@cf\//);
  });

  it("moderation classifier default is a @cf/ Workers AI id", () => {
    expect(DEFAULT_CAIL_IMAGE_CLASSIFIER).toMatch(/^@cf\//);
  });

  it("resolvers honor env overrides and fall back to the defaults", () => {
    expect(resolveImageModelId({})).toBe(DEFAULT_CAIL_IMAGE_MODEL);
    expect(resolveImageModelId({ CAIL_IMAGE_MODEL: "@cf/other/model" })).toBe("@cf/other/model");
    expect(resolveImageClassifierId({})).toBe(DEFAULT_CAIL_IMAGE_CLASSIFIER);
    expect(resolveImageClassifierId({ CAIL_IMAGE_CLASSIFIER: "@cf/other/vlm" })).toBe("@cf/other/vlm");
  });

  it("rejects non-Cloudflare generator and classifier overrides", () => {
    expect(() => resolveImageModelId({ CAIL_IMAGE_MODEL: "openai/image" }))
      .toThrow("CAIL_IMAGE_MODEL must be a Cloudflare Workers AI model id");
    expect(() => resolveImageClassifierId({ CAIL_IMAGE_CLASSIFIER: "openai/vision" }))
      .toThrow("CAIL_IMAGE_CLASSIFIER must be a Cloudflare Workers AI model id");
  });
});

describe("clampDimension", () => {
  it("defaults missing / non-finite input to 1024", () => {
    expect(clampDimension(undefined)).toBe(1024);
    expect(clampDimension(Number.NaN)).toBe(1024);
    expect(clampDimension(Infinity)).toBe(1024);
  });

  it("rounds to the nearest multiple of 64", () => {
    expect(clampDimension(700)).toBe(704); // 700 → 704
    expect(clampDimension(1000)).toBe(1024);
  });

  it("clamps to Flux's supported [256, 1920] range", () => {
    expect(clampDimension(10)).toBe(256);
    expect(clampDimension(256)).toBe(256);
    expect(clampDimension(1920)).toBe(1920);
    expect(clampDimension(99999)).toBe(1920);
  });
});

describe("generateImage wire contract", () => {
  it("hits /v1/run with {model, input} and one bearer credential", async () => {
    const { fetch: stub, captured } = captureFetch(() => json({ image: PNG_BASE64 }));

    const result = await generateImage(env, "jwt-token", { prompt: "a quiet library" }, stub);
    expect(result.ok).toBe(true);

    const cap = captured();
    expect(cap.url).toBe(`${BASE}/v1/run`);
    // Spend attribution is server-owned; callers do not send purpose metadata.
    expect(cap.headers.get("x-cail-app")).toBe("site-studio");
    expect(cap.headers.get("authorization")).toBe("Bearer jwt-token");
    expect(cap.headers.get("x-cail-identity-jwt")).toBeNull();
    expect(cap.headers.get("x-cail-metadata")).toBeNull();
    expect(cap.init.credentials).toBe("omit");
    expect(cap.init.redirect).toBe("error");

    // Cloudflare's native {model, input} body.
    // SAFETY: The moderation adapter emits this documented request body shape.
    const body = JSON.parse(String(cap.init.body)) as ModerationBody;
    expect(body.model).toBe(DEFAULT_CAIL_IMAGE_MODEL);
    expect(body.input.prompt).toBe("a quiet library");
    expect(body.input.width).toBe(1024);
    expect(body.input.height).toBe(1024);
  });

  it("refuses the anonymous path without any request (gateway is JWT-first/strict)", async () => {
    const { fetch: stub, captured } = captureFetch(() => json({ image: PNG_BASE64 }));
    const result = await generateImage(env, null, { prompt: "x" }, stub);
    expect(result.ok).toBe(false);
    // No request left the tool.
    expect(captured().url).toBe("");
  });

  it("stops before generation when the captured WebSocket identity has expired", async () => {
    const { fetch: stub, calls } = captureFetch(() => json({ image: PNG_BASE64 }));
    await expect(generateImage(env, expiredJwt(), { prompt: "x" }, stub)).rejects.toThrow("identity expired");
    expect(calls()).toBe(0);
  });

  it("clamps requested dimensions in the request input", async () => {
    const { fetch: stub, captured } = captureFetch(() => json({ image: PNG_BASE64 }));
    await generateImage(env, "jwt", { prompt: "x", width: 700, height: 99999 }, stub);
    const body = JSON.parse(String(captured().init.body));
    expect(body.input.width).toBe(704);
    expect(body.input.height).toBe(1920);
  });

  it("base64-decodes the unwrapped native result into bytes", async () => {
    const { fetch: stub } = captureFetch(() => json({ image: PNG_BASE64 }));
    const result = await generateImage(env, "jwt", { prompt: "x" }, stub);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.bytes)).toEqual(Array.from(PNG_BYTES));
      expect(result.contentType).toBe("image/png");
    }
  });

  it("rejects a provider image larger than the interactive 10MB image cap", async () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.set(PNG_BYTES);
    const encoded = Buffer.from(oversized).toString("base64");
    const { fetch: stub } = captureFetch(() => json({ image: encoded }));
    const result = await generateImage(env, "jwt", { prompt: "x" }, stub);
    expect(result).toEqual({
      ok: false,
      message: "Image generation returned an image larger than 10MB"
    });
  });

  it("errors when the response still carries Cloudflare's wrapped envelope (contract: /v1/run is unwrapped)", async () => {
    const { fetch: stub } = captureFetch(() => json({ success: true, result: { image: PNG_BASE64 }, errors: [] }));
    const result = await generateImage(env, "jwt", { prompt: "x" }, stub);
    expect(result.ok).toBe(false);
  });

  it("passes the CAIL envelope message through verbatim (429 quota_exceeded)", async () => {
    const { fetch: stub } = captureFetch(
      () => cailErrorResponse(
        429,
        quotaExceededEnvelope({ message: "Monthly quota exceeded.", retryAfterSeconds: 1800 }),
        {
          "retry-after": "1800",
          "x-request-id": "req-site-image-1",
          "x-should-retry": "false",
        }
      )
    );
    const result = await generateImage(env, "jwt", { prompt: "x" }, stub);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Monthly quota exceeded.");
    }
  });

  it("does not retry an uncertain image-generation 5xx", async () => {
    const { fetch: stub, calls } = captureFetch(
      () => new Response("upstream error", { status: 503 })
    );

    const result = await generateImage(env, "jwt", { prompt: "x" }, stub);

    expect(result.ok).toBe(false);
    expect(calls()).toBe(1);
  });

  it("fails when CAIL_API_BASE is unset", async () => {
    const result = await generateImage({}, "jwt", { prompt: "x" });
    expect(result.ok).toBe(false);
  });
});

describe("screenImage moderation gate (fail closed)", () => {

  it("stops before moderation when the captured WebSocket identity has expired", async () => {
    const { fetch: stub, calls } = captureFetch(() => json({ choices: [] }));
    await expect(screenImage(env, expiredJwt(), PNG_BYTES, stub)).rejects.toThrow("identity expired");
    expect(calls()).toBe(0);
  });
  it("uses the official AI SDK JSON path with one bearer and no caller metadata", async () => {
    const { fetch: stub, captured } = captureFetch(() =>
      json({
        id: "chatcmpl-moderation",
        object: "chat.completion",
        created: 0,
        model: DEFAULT_CAIL_IMAGE_CLASSIFIER,
        choices: [{
          index: 0,
          message: { role: "assistant", content: '{"allowed": true, "reason": "ok"}' },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );

    const result = await screenImage(env, "jwt-token", PNG_BYTES, stub);
    expect(result.allowed).toBe(true);

    const cap = captured();
    expect(cap.url).toBe(`${BASE}/v1/chat/completions`);
    expect(cap.headers.get("x-cail-app")).toBe("site-studio");
    expect(cap.headers.get("authorization")).toBe("Bearer jwt-token");
    expect(cap.headers.get("x-cail-identity-jwt")).toBeNull();
    expect(cap.headers.get("x-cail-metadata")).toBeNull();
    expect(cap.init.credentials).toBe("omit");
    expect(cap.init.redirect).toBe("manual");

    // The image travels as a data-URI image_url content part, plus the strict
    // system instruction.
    const body = JSON.parse(String(cap.init.body));
    expect(body.model).toBe(DEFAULT_CAIL_IMAGE_CLASSIFIER);
    expect(body.messages[0].content).toBe(IMAGE_MODERATION_INSTRUCTION);
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: {
          type: "object",
          properties: {
            allowed: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["allowed"],
          additionalProperties: false,
        },
      },
    });
    const parts = body.messages[1]?.content;
    if (!Array.isArray(parts)) throw new Error("expected image content parts");
    // SAFETY: The moderation request schema marks image_url parts with a nested URL.
    const imagePart = parts.find((p) => p.type === "image_url") as
      | { image_url: { url: string } }
      | undefined;
    expect(imagePart?.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("allows only on an explicit {\"allowed\": true}", async () => {
    const { fetch: stub } = captureFetch(() =>
      json({
        id: "chatcmpl-moderation",
        choices: [{ message: { role: "assistant", content: '{"allowed": true}' }, finish_reason: "stop" }],
      })
    );
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(true);
  });

  it("rejects an explicit {\"allowed\": false}", async () => {
    const { fetch: stub } = captureFetch(() =>
      json({
        id: "chatcmpl-moderation",
        choices: [{ message: { role: "assistant", content: '{"allowed": false, "reason": "nsfw"}' }, finish_reason: "stop" }],
      })
    );
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(false);
  });

  it("fails closed on a classifier 500", async () => {
    const { fetch: stub, calls } = captureFetch(() => new Response("upstream error", { status: 500 }));
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(false);
    expect(calls()).toBe(1);
  });

  it.each([429, 503])("fails closed on a classifier %s with one attempt", async (status) => {
    const { fetch: stub, calls } = captureFetch(() => new Response("upstream error", { status }));
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(false);
    expect(calls()).toBe(1);
  });

  it("fails closed on a gibberish (non-JSON) answer", async () => {
    const { fetch: stub } = captureFetch(() =>
      json({
        id: "chatcmpl-moderation",
        choices: [{ message: { role: "assistant", content: "sure looks fine to me!" }, finish_reason: "stop" }],
      })
    );
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(false);
  });

  it("fails closed on a network throw with one attempt", async () => {
    let calls = 0;
    // SAFETY: This deliberate failure stub implements the Fetch API signature.
    const stub = (async () => {
      calls += 1;
      throw new Error("network down");
    }) as typeof fetch;
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(false);
    expect(calls).toBe(1);
  });

  it("fails closed when CAIL_API_BASE is unset", async () => {
    expect((await screenImage({}, "jwt", PNG_BYTES)).allowed).toBe(false);
  });

  it("fails closed on the anonymous path without any request", async () => {
    const { fetch: stub, captured } = captureFetch(() =>
      json({ choices: [{ message: { content: '{"allowed": true}' } }] })
    );
    expect((await screenImage(env, null, PNG_BYTES, stub)).allowed).toBe(false);
    expect(captured().url).toBe("");
  });

  it("fails closed when JSON is embedded in surrounding prose", async () => {
    const { fetch: stub } = captureFetch(() =>
      json({
        id: "chatcmpl-moderation",
        choices: [{ message: { role: "assistant", content: 'Here is my verdict: {"allowed": true}' }, finish_reason: "stop" }],
      })
    );
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(false);
  });
});

/**
 * Truthy-but-not-boolean verdicts must NOT admit an image: the gate requires
 * explicit boolean `allowed === true` (verifier follow-up — pin it).
 */
describe("screenImage strict-boolean verdicts", () => {
  it.each([
    ['{"allowed":"true","reason":"string true"}', "string 'true'"],
    ['{"allowed":1,"reason":"numeric one"}', "numeric 1"]
  ])("rejects a truthy non-boolean verdict %s", async (body) => {
    const { fetch: stub } = captureFetch(() =>
      json({
        id: "chatcmpl-moderation",
        choices: [{ message: { role: "assistant", content: body }, finish_reason: "stop" }],
      })
    );
    const result = await screenImage(env, "jwt", PNG_BYTES, stub);
    expect(result.allowed).toBe(false);
  });
});

/**
 * Integration tests on the extracted generate_image orchestration: `save` must
 * be unreachable unless generation succeeded, the bytes sniff as an image, and
 * the gate explicitly allowed — including when the gate THROWS.
 */
describe("runGenerateImageFlow ordering", () => {
  const WEBP_BYTES = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x00
  ]);

  function trackedDeps(overrides: Partial<GenerateImageFlowDeps> = {}) {
    const calls = { screen: 0, saveIfAbsent: 0 };
    const deps: GenerateImageFlowDeps = {
      generate: async () => ({ ok: true, bytes: PNG_BYTES, contentType: "image/png" }),
      screen: async () => {
        calls.screen += 1;
        return { allowed: true };
      },
      // Default: the atomic write always wins (key was free).
      saveIfAbsent: async () => {
        calls.saveIfAbsent += 1;
        return true;
      },
      ...overrides
    };
    return { deps, calls };
  }

  it("rejected verdict: saveIfAbsent is never called; calm copy returned", async () => {
    const { deps, calls } = trackedDeps({ screen: async () => ({ allowed: false, reason: "nope" }) });
    const result = await runGenerateImageFlow("photo.png", deps);
    expect(result).toEqual({ ok: false, message: GENERATED_IMAGE_REJECTED_MESSAGE });
    expect(calls.saveIfAbsent).toBe(0);
  });

  it("throwing screen: treated as rejection, saveIfAbsent never called", async () => {
    const { deps, calls } = trackedDeps({
      screen: async () => {
        throw new Error("classifier exploded");
      }
    });
    const result = await runGenerateImageFlow(undefined, deps);
    expect(result).toEqual({ ok: false, message: GENERATED_IMAGE_REJECTED_MESSAGE });
    expect(calls.saveIfAbsent).toBe(0);
  });

  it("failed generation: screen and saveIfAbsent never called; message passed through", async () => {
    const { deps, calls } = trackedDeps({
      generate: async () => ({ ok: false, message: '{"error":"quota_exceeded","message":"Budget hit."}' })
    });
    const result = await runGenerateImageFlow(undefined, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("quota_exceeded");
    }
    expect(calls.screen).toBe(0);
    expect(calls.saveIfAbsent).toBe(0);
  });

  it("non-image bytes: screen and saveIfAbsent never called", async () => {
    const { deps, calls } = trackedDeps({
      generate: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]), contentType: "image/png" })
    });
    const result = await runGenerateImageFlow(undefined, deps);
    expect(result.ok).toBe(false);
    expect(calls.screen).toBe(0);
    expect(calls.saveIfAbsent).toBe(0);
  });

  it("allowed: saves exactly once under images/ with the requested stem", async () => {
    const saved: Array<{ path: string; bytes: Uint8Array }> = [];
    const { deps, calls } = trackedDeps({
      saveIfAbsent: async (path, bytes) => {
        saved.push({ path, bytes });
        return true;
      }
    });
    const result = await runGenerateImageFlow("Head shot!.png", deps);
    expect(result).toMatchObject({ ok: true, path: "images/Head_shot.png" });
    expect(saved).toHaveLength(1);
    expect(saved[0].path).toBe("images/Head_shot.png");
    expect(calls.screen).toBe(1);
  });

  it("collision: advances the suffix when the atomic write loses the race", async () => {
    let attempts = 0;
    const { deps } = trackedDeps({
      saveIfAbsent: async () => {
        attempts += 1;
        return attempts !== 1; // first candidate already taken, second free
      }
    });
    const result = await runGenerateImageFlow("logo.png", deps);
    expect(result).toMatchObject({ ok: true, path: "images/logo_1.png" });
  });

  it("extension follows the sniffed bytes (webp in, .webp out)", async () => {
    const { deps } = trackedDeps({
      generate: async () => ({ ok: true, bytes: WEBP_BYTES, contentType: "image/webp" })
    });
    const result = await runGenerateImageFlow("banner.png", deps);
    expect(result).toMatchObject({ ok: true, path: "images/banner.webp" });
  });

  it("errors cleanly when every candidate name loses the race (bounded retries)", async () => {
    const { deps } = trackedDeps({ saveIfAbsent: async () => false });
    const result = await runGenerateImageFlow("logo.png", deps);
    expect(result.ok).toBe(false);
  });

  // SS-5 race: two concurrent generations for the same name against a shared,
  // first-write-wins store. The atomic saveIfAbsent guarantees one gets
  // images/logo.png and the other advances to images/logo_1.png — no clobber.
  it("SS-5 race: two concurrent same-name saves never clobber (distinct paths)", async () => {
    const store = new Map<string, Uint8Array>();
    const saveIfAbsent = async (path: string, bytes: Uint8Array) => {
      if (store.has(path)) return false; // first-write-wins
      store.set(path, bytes);
      return true;
    };
    const bytesA = new Uint8Array(PNG_BYTES);
    const bytesB = new Uint8Array(PNG_BYTES);
    bytesB[bytesB.length - 1] ^= 0xff; // make the payloads distinguishable

    const depsA: GenerateImageFlowDeps = {
      generate: async () => ({ ok: true, bytes: bytesA, contentType: "image/png" }),
      screen: async () => ({ allowed: true }),
      saveIfAbsent
    };
    const depsB: GenerateImageFlowDeps = {
      generate: async () => ({ ok: true, bytes: bytesB, contentType: "image/png" }),
      screen: async () => ({ allowed: true }),
      saveIfAbsent
    };

    const [resA, resB] = await Promise.all([
      runGenerateImageFlow("logo.png", depsA),
      runGenerateImageFlow("logo.png", depsB)
    ]);

    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    const paths = [resA, resB].map((r) => (r.ok ? r.path : "")).sort();
    expect(paths).toEqual(["images/logo.png", "images/logo_1.png"]);
    // Two files exist and neither overwrote the other.
    expect(store.size).toBe(2);
    expect(store.get("images/logo.png")).toBeDefined();
    expect(store.get("images/logo_1.png")).toBeDefined();
  });
});

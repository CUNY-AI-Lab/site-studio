import { describe, it, expect } from "vitest";
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

type Captured = { url: string; init: RequestInit; headers: Headers };

/** Fetch stub that records the outbound request and returns a canned response. */
function captureFetch(response: () => Response): {
  fetch: typeof fetch;
  captured: () => Captured;
} {
  let seen: Captured | undefined;
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = {
      url: String(input),
      init: init ?? {},
      headers: new Headers((init?.headers ?? {}) as HeadersInit)
    };
    return response();
  }) as typeof fetch;
  return { fetch: stub, captured: () => seen ?? { url: "", init: {}, headers: new Headers() } };
}

function json(body: unknown, status = 200): Response {
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

  it("clamps to [64, 2048]", () => {
    expect(clampDimension(10)).toBe(64);
    expect(clampDimension(99999)).toBe(2048);
  });
});

describe("generateImage wire contract", () => {
  it("hits /v1/run with {model, input}, the image-generation purpose, and one credential", async () => {
    const { fetch: stub, captured } = captureFetch(() => json({ image: PNG_BASE64 }));

    const result = await generateImage(env, "jwt-token", { prompt: "a quiet library" }, stub);
    expect(result.ok).toBe(true);

    const cap = captured();
    expect(cap.url).toBe(`${BASE}/v1/run`);
    // spend attribution slug + per-purpose metadata
    expect(cap.headers.get("x-cail-app")).toBe("site-studio");
    expect(cap.headers.get("x-cail-identity-jwt")).toBe("jwt-token");
    expect(JSON.parse(cap.headers.get("x-cail-metadata") || "{}")).toEqual({
      purpose: "image-generation"
    });
    // one-credential contract: never an Authorization header
    expect(cap.headers.has("authorization")).toBe(false);

    // Cloudflare's native {model, input} body.
    const body = JSON.parse(String(cap.init.body));
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

  it("clamps requested dimensions in the request input", async () => {
    const { fetch: stub, captured } = captureFetch(() => json({ image: PNG_BASE64 }));
    await generateImage(env, "jwt", { prompt: "x", width: 700, height: 99999 }, stub);
    const body = JSON.parse(String(captured().init.body));
    expect(body.input.width).toBe(704);
    expect(body.input.height).toBe(2048);
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

  it("errors when the response still carries Cloudflare's wrapped envelope (contract: /v1/run is unwrapped)", async () => {
    const { fetch: stub } = captureFetch(() => json({ success: true, result: { image: PNG_BASE64 }, errors: [] }));
    const result = await generateImage(env, "jwt", { prompt: "x" }, stub);
    expect(result.ok).toBe(false);
  });

  it("passes the CAIL envelope message through verbatim (429 quota_exceeded)", async () => {
    const envelope = JSON.stringify({ error: "quota_exceeded", message: "Monthly quota exceeded." });
    const { fetch: stub } = captureFetch(
      () => new Response(envelope, { status: 429, headers: { "content-type": "application/json" } })
    );
    const result = await generateImage(env, "jwt", { prompt: "x" }, stub);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Monthly quota exceeded.");
    }
  });

  it("fails when CAIL_API_BASE is unset", async () => {
    const result = await generateImage({}, "jwt", { prompt: "x" });
    expect(result.ok).toBe(false);
  });
});

describe("screenImage moderation gate (fail closed)", () => {
  it("hits /v1/chat/completions with the image-moderation purpose and one credential", async () => {
    const { fetch: stub, captured } = captureFetch(() =>
      json({ choices: [{ message: { content: '{"allowed": true, "reason": "ok"}' } }] })
    );

    const result = await screenImage(env, "jwt-token", PNG_BYTES, stub);
    expect(result.allowed).toBe(true);

    const cap = captured();
    expect(cap.url).toBe(`${BASE}/v1/chat/completions`);
    expect(cap.headers.get("x-cail-app")).toBe("site-studio");
    expect(cap.headers.get("x-cail-identity-jwt")).toBe("jwt-token");
    expect(JSON.parse(cap.headers.get("x-cail-metadata") || "{}")).toEqual({
      purpose: "image-moderation"
    });
    expect(cap.headers.has("authorization")).toBe(false);

    // The image travels as a data-URI image_url content part, plus the strict
    // system instruction.
    const body = JSON.parse(String(cap.init.body));
    expect(body.model).toBe(DEFAULT_CAIL_IMAGE_CLASSIFIER);
    expect(body.messages[0].content).toBe(IMAGE_MODERATION_INSTRUCTION);
    const parts = body.messages[1].content as Array<Record<string, unknown>>;
    const imagePart = parts.find((p) => p.type === "image_url") as
      | { image_url: { url: string } }
      | undefined;
    expect(imagePart?.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("allows only on an explicit {\"allowed\": true}", async () => {
    const { fetch: stub } = captureFetch(() =>
      json({ choices: [{ message: { content: '{"allowed": true}' } }] })
    );
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(true);
  });

  it("rejects an explicit {\"allowed\": false}", async () => {
    const { fetch: stub } = captureFetch(() =>
      json({ choices: [{ message: { content: '{"allowed": false, "reason": "nsfw"}' } }] })
    );
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(false);
  });

  it("fails closed on a classifier 500", async () => {
    const { fetch: stub } = captureFetch(() => new Response("upstream error", { status: 500 }));
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(false);
  });

  it("fails closed on a gibberish (non-JSON) answer", async () => {
    const { fetch: stub } = captureFetch(() =>
      json({ choices: [{ message: { content: "sure looks fine to me!" } }] })
    );
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(false);
  });

  it("fails closed on a network throw", async () => {
    const stub = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(false);
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

  it("parses JSON embedded in surrounding prose", async () => {
    const { fetch: stub } = captureFetch(() =>
      json({ choices: [{ message: { content: 'Here is my verdict: {"allowed": true, "reason": "academic"}' } }] })
    );
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(true);
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
      json({ choices: [{ message: { role: "assistant", content: body } }] })
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

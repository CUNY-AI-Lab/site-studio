import { describe, it, expect } from "vitest";
import {
  DEFAULT_CAIL_IMAGE_MODEL,
  DEFAULT_CAIL_IMAGE_CLASSIFIER,
  IMAGE_MODERATION_INSTRUCTION,
  clampDimension,
  generateImage,
  resolveImageClassifierId,
  resolveImageModelId,
  screenImage,
  type CailImageEnv
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
  it("hits /v1/workers-ai/{model} with the image-generation purpose and one credential", async () => {
    const { fetch: stub, captured } = captureFetch(() => json({ result: { image: PNG_BASE64 } }));

    const result = await generateImage(env, "jwt-token", { prompt: "a quiet library" }, stub);
    expect(result.ok).toBe(true);

    const cap = captured();
    expect(cap.url).toBe(`${BASE}/v1/workers-ai/${DEFAULT_CAIL_IMAGE_MODEL}`);
    // spend attribution slug + per-purpose metadata
    expect(cap.headers.get("x-cail-app")).toBe("site-studio");
    expect(cap.headers.get("x-cail-identity-jwt")).toBe("jwt-token");
    expect(JSON.parse(cap.headers.get("x-cail-metadata") || "{}")).toEqual({
      purpose: "image-generation"
    });
    // one-credential contract: never an Authorization header
    expect(cap.headers.has("authorization")).toBe(false);

    const body = JSON.parse(String(cap.init.body));
    expect(body.prompt).toBe("a quiet library");
    expect(body.width).toBe(1024);
    expect(body.height).toBe(1024);
  });

  it("omits the identity header on the anonymous path but keeps X-CAIL-App", async () => {
    const { fetch: stub, captured } = captureFetch(() => json({ result: { image: PNG_BASE64 } }));
    await generateImage(env, null, { prompt: "x" }, stub);
    const cap = captured();
    expect(cap.headers.has("x-cail-identity-jwt")).toBe(false);
    expect(cap.headers.get("x-cail-app")).toBe("site-studio");
    expect(cap.headers.has("authorization")).toBe(false);
  });

  it("clamps requested dimensions in the request body", async () => {
    const { fetch: stub, captured } = captureFetch(() => json({ result: { image: PNG_BASE64 } }));
    await generateImage(env, "jwt", { prompt: "x", width: 700, height: 99999 }, stub);
    const body = JSON.parse(String(captured().init.body));
    expect(body.width).toBe(704);
    expect(body.height).toBe(2048);
  });

  it("base64-decodes the returned image into bytes", async () => {
    const { fetch: stub } = captureFetch(() => json({ result: { image: PNG_BASE64 } }));
    const result = await generateImage(env, "jwt", { prompt: "x" }, stub);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.bytes)).toEqual(Array.from(PNG_BYTES));
      expect(result.contentType).toBe("image/png");
    }
  });

  it("passes the CAIL error envelope through unmodified (429 quota_exceeded)", async () => {
    const envelope = JSON.stringify({ error: { code: "quota_exceeded", message: "Monthly quota exceeded." } });
    const { fetch: stub } = captureFetch(
      () => new Response(envelope, { status: 429, headers: { "content-type": "application/json" } })
    );
    const result = await generateImage(env, "jwt", { prompt: "x" }, stub);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(envelope);
    }
  });

  it("fails when CAIL_API_BASE is unset", async () => {
    const result = await generateImage({}, "jwt", { prompt: "x" });
    expect(result.ok).toBe(false);
  });
});

describe("screenImage moderation gate (fail closed)", () => {
  it("hits /v1/compat/chat/completions with the image-moderation purpose and one credential", async () => {
    const { fetch: stub, captured } = captureFetch(() =>
      json({ choices: [{ message: { content: '{"allowed": true, "reason": "ok"}' } }] })
    );

    const result = await screenImage(env, "jwt-token", PNG_BYTES, stub);
    expect(result.allowed).toBe(true);

    const cap = captured();
    expect(cap.url).toBe(`${BASE}/v1/compat/chat/completions`);
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

  it("parses JSON embedded in surrounding prose", async () => {
    const { fetch: stub } = captureFetch(() =>
      json({ choices: [{ message: { content: 'Here is my verdict: {"allowed": true, "reason": "academic"}' } }] })
    );
    expect((await screenImage(env, "jwt", PNG_BYTES, stub)).allowed).toBe(true);
  });
});

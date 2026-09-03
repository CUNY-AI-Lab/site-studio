import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_CAIL_IMAGE_CLASSIFIER } from "./image-generation";
import {
  inspectImage,
  type ImageInspectionOptions,
} from "./image-inspection";

const BASE = "https://cail.example/proxy";
const env = { CAIL_API_BASE: BASE };
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (character) => character.charCodeAt(0));
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const inspectionBodySchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    content: z.union([
      z.string(),
      z.array(z.object({
        type: z.string(),
        text: z.string().optional(),
        image_url: z.object({ url: z.string() }).optional(),
      })),
    ]),
  })),
});

function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureFetch(response: () => Response) {
  let request: { url: string; init: RequestInit } | undefined;
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    request = { url: String(input), init: init ?? {} };
    return response();
  };
  return {
    fetchImpl,
    request: () => request,
    calls: () => calls,
  };
}

function options(fetchImpl: typeof fetch, abortSignal?: AbortSignal): ImageInspectionOptions {
  return { sessionId: "project-1", fetchImpl, abortSignal };
}

describe("inspectImage", () => {
  it("sends actual image bytes through the configured vision model and returns text", async () => {
    const capture = captureFetch(() => json({
      id: "chatcmpl-inspect",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "A blue academic poster beside a wooden desk." },
        finish_reason: "stop",
      }],
    }));

    const result = await inspectImage(
      { ...env, CAIL_IMAGE_CLASSIFIER: DEFAULT_CAIL_IMAGE_CLASSIFIER },
      "jwt-token",
      PNG_BYTES,
      options(capture.fetchImpl),
    );

    expect(result).toEqual({
      ok: true,
      observation: "A blue academic poster beside a wooden desk.",
      contentType: "image/png",
    });
    const request = capture.request();
    expect(request?.url).toBe(`${BASE}/v1/chat/completions`);
    expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer jwt-token");
    expect(new Headers(request?.init.headers).get("x-cail-session-id")).toBe("project-1");
    const parsedBody = inspectionBodySchema.safeParse(JSON.parse(String(request?.init.body)));
    expect(parsedBody.success).toBe(true);
    if (!parsedBody.success) throw new Error(parsedBody.error.message);
    const body = parsedBody.data;
    expect(body.model).toBe(DEFAULT_CAIL_IMAGE_CLASSIFIER);
    const content = body.messages[1]?.content;
    if (!Array.isArray(content)) throw new Error("expected image content parts");
    expect(content).toEqual(expect.arrayContaining([
      { type: "text", text: "Describe this image for the site builder." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
    ]));
  });

  it("rejects invalid and oversized bytes before making a model request", async () => {
    const capture = captureFetch(() => json({}));
    const invalid = await inspectImage(env, "jwt-token", new Uint8Array([1, 2, 3]), options(capture.fetchImpl));
    expect(invalid).toEqual({ ok: false, message: "That file is not a supported image." });

    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.set(PNG_BYTES);
    const tooLarge = await inspectImage(env, "jwt-token", oversized, options(capture.fetchImpl));
    expect(tooLarge).toEqual({ ok: false, message: "Images must be 10MB or smaller." });
    expect(capture.calls()).toBe(0);
  });

  it("passes the active abort signal to a pending request and does not hide cancellation", async () => {
    const controller = new AbortController();
    let calls = 0;
    let seenSignal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      seenSignal = init?.signal ?? undefined;
      started();
      const signal = init?.signal;
      if (!signal) throw new Error("Expected request cancellation signal");
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const inspecting = inspectImage(env, "jwt-token", PNG_BYTES, options(fetchImpl, controller.signal));
    await ready;
    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(inspecting).rejects.toThrow("Stopped");
    expect(seenSignal).toBe(controller.signal);
    expect(calls).toBe(1);
  });

  it("returns a sanitized failure for provider errors", async () => {
    const capture = captureFetch(() => new Response("private provider detail", { status: 500 }));
    const result = await inspectImage(env, "jwt-token", PNG_BYTES, options(capture.fetchImpl));
    expect(result).toEqual({ ok: false, message: "Image inspection failed. Try again in a moment." });
  });
});

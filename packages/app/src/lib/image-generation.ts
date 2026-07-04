/**
 * AI image generation + a REQUIRED moderation gate, both via the CAIL model
 * proxy (docs/INTEGRATION.md §1). Same one-credential contract as model.ts: a
 * proxy request carries exactly ONE credential — the caller's identity travels
 * in `X-CAIL-Identity-JWT` (via buildProxyHeaders) and there is NEVER an
 * `Authorization` header. The proxy authenticates on the JWT, attaches the real
 * provider credentials, and forwards to Workers AI.
 *
 * Unlike the chat path (which uses the OpenAI-compatible SDK at /v1/compat),
 * these call the proxy's pass-through /v1/* paths directly with `fetch`:
 *   - generation → the AI Gateway native workers-ai path
 *     `{CAIL_API_BASE}/v1/workers-ai/{model}`, which the proxy forwards verbatim.
 *   - moderation → the OpenAI-compatible `{CAIL_API_BASE}/v1/compat/chat/completions`
 *     so we can send a multimodal (image_url) message to a vision model.
 *
 * Per-purpose spend is stamped with `X-CAIL-Metadata` so image spend is
 * distinguishable from chat spend in CAIL analytics.
 */

import { buildProxyHeaders, type CailModelEnv } from "./model";

/**
 * Default image-generation model. CAIL policy (docs/INTEGRATION.md §1):
 * Cloudflare models only — must be a Workers AI catalog id (`@cf/...`).
 * Overridable via `CAIL_IMAGE_MODEL`, but the value must also be `@cf/`.
 *
 * FLUX.2 [klein] is Workers AI's current text-to-image default (fast, good
 * general quality). `@cf/black-forest-labs/flux-1-schnell` is the cheaper
 * budget alternative if image spend becomes a concern.
 */
export const DEFAULT_CAIL_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

/**
 * Default classifier for the moderation gate. Workers AI has NO dedicated NSFW
 * classifier (verified against the live catalog), so the gate is a vision-model
 * screen. CAIL policy applies here too: must be a `@cf/...` id. Overridable via
 * `CAIL_IMAGE_CLASSIFIER`. `@cf/meta/llama-3.2-11b-vision-instruct` is the
 * fallback vision model if this id is unavailable at launch.
 */
export const DEFAULT_CAIL_IMAGE_CLASSIFIER = "@cf/google/gemma-4-26b-a4b-it";

/**
 * The moderation gate's system instruction. Kept as an exported constant so the
 * wire tests can pin the exact text and reviewers can read it in one place.
 * Fail-closed parsing lives in `screenImage`; this only defines the contract we
 * ask the vision model to honor.
 */
export const IMAGE_MODERATION_INSTRUCTION =
  "You are a strict content-safety reviewer for a student's public academic website. " +
  "Decide if the image is appropriate to publish there. " +
  "Reject sexual content, graphic violence or gore, and hate symbols. " +
  "Allow ordinary academic, artistic, illustrative, and photographic content. " +
  'Answer with ONLY a JSON object of the form {"allowed": true|false, "reason": "<short>"} and nothing else.';

export interface CailImageEnv extends CailModelEnv {
  CAIL_IMAGE_MODEL?: string;
  CAIL_IMAGE_CLASSIFIER?: string;
}

/** Resolve the image-generation model id (configurable, must be `@cf/`). */
export function resolveImageModelId(env: CailImageEnv): string {
  return env.CAIL_IMAGE_MODEL || DEFAULT_CAIL_IMAGE_MODEL;
}

/** Resolve the moderation classifier id (configurable, must be `@cf/`). */
export function resolveImageClassifierId(env: CailImageEnv): string {
  return env.CAIL_IMAGE_CLASSIFIER || DEFAULT_CAIL_IMAGE_CLASSIFIER;
}

/** Bounds for generated image dimensions: multiples of 64, clamped to [64, 2048]. */
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 2048;
const DIMENSION_STEP = 64;
const DEFAULT_DIMENSION = 1024;

/**
 * Clamp a requested dimension to a sane, model-friendly value: a multiple of 64
 * within [64, 2048]. Non-finite or missing input falls back to 1024.
 */
export function clampDimension(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DIMENSION;
  }
  const rounded = Math.round(value / DIMENSION_STEP) * DIMENSION_STEP;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, rounded));
}

/** Base URL for the AI Gateway native workers-ai pass-through path. */
function workersAiUrl(apiBase: string, model: string): string {
  const trimmed = apiBase.replace(/\/+$/, "");
  return `${trimmed}/v1/workers-ai/${model}`;
}

/** Base URL for the OpenAI-compatible chat-completions path. */
function chatCompletionsUrl(apiBase: string): string {
  const trimmed = apiBase.replace(/\/+$/, "");
  return `${trimmed}/v1/compat/chat/completions`;
}

/**
 * Decode a base64 (or base64url) string into a Uint8Array. Uses `atob`, which
 * is available in both the Cloudflare Workers runtime and the Node vitest env.
 * Throws on invalid base64 (caught by the caller).
 */
function decodeBase64(data: string): Uint8Array {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Pull a base64 image payload out of the various shapes Workers AI returns. */
function extractBase64Image(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  // Workers AI wraps successful results in `{ result: {...} }`; some ids return
  // the fields at the top level. Check both.
  const result =
    record.result && typeof record.result === "object"
      ? (record.result as Record<string, unknown>)
      : record;

  const candidate =
    (typeof result.image === "string" && result.image) ||
    (typeof result.image_b64 === "string" && result.image_b64) ||
    (typeof (result as Record<string, unknown>).b64_json === "string" &&
      (result as Record<string, unknown>).b64_json);

  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export type GenerateImageResult =
  | { ok: true; bytes: Uint8Array; contentType: "image/png" }
  | { ok: false; message: string };

export interface GenerateImageInput {
  prompt: string;
  width?: number;
  height?: number;
}

/**
 * Generate an image via the CAIL proxy's workers-ai pass-through path.
 *
 * One-credential contract: buildProxyHeaders(jwt) only — no Authorization. Adds
 * `X-CAIL-Metadata` with purpose "image-generation" for spend attribution.
 *
 * On a proxy/provider error we pass the CAIL error envelope through unmodified
 * (per contract — do not reword proxy error messages).
 */
export async function generateImage(
  env: CailImageEnv,
  jwt: string | null,
  input: GenerateImageInput,
  fetchImpl: typeof fetch = fetch
): Promise<GenerateImageResult> {
  if (!env.CAIL_API_BASE) {
    return { ok: false, message: "CAIL_API_BASE is not configured" };
  }

  const model = resolveImageModelId(env);
  const width = clampDimension(input.width);
  const height = clampDimension(input.height);

  const response = await fetchImpl(workersAiUrl(env.CAIL_API_BASE, model), {
    method: "POST",
    headers: {
      ...buildProxyHeaders(jwt),
      "Content-Type": "application/json",
      "X-CAIL-Metadata": JSON.stringify({ purpose: "image-generation" })
    },
    body: JSON.stringify({ prompt: input.prompt, width, height })
  });

  if (!response.ok) {
    // Pass the CAIL error envelope through unmodified.
    const text = await response.text();
    return { ok: false, message: text || `Image generation failed (${response.status})` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, message: "Image generation returned a non-JSON response" };
  }

  const base64 = extractBase64Image(payload);
  if (!base64) {
    return { ok: false, message: "Image generation response did not contain an image" };
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64);
  } catch {
    return { ok: false, message: "Image generation returned an undecodable image payload" };
  }

  if (bytes.length === 0) {
    return { ok: false, message: "Image generation returned an empty image" };
  }

  return { ok: true, bytes, contentType: "image/png" };
}

export interface ScreenImageResult {
  allowed: boolean;
  reason?: string;
}

/** Encode bytes to a base64 string for a data URI (`btoa`, Workers + Node). */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Pull the assistant text out of an OpenAI-style chat-completions response. */
function extractAssistantText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const message = (choices[0] as Record<string, unknown>)?.message as
    | Record<string, unknown>
    | undefined;
  const content = message?.content;
  return typeof content === "string" ? content : null;
}

/**
 * Parse the classifier's answer defensively. Accepts a bare JSON object or JSON
 * embedded in surrounding prose. Returns null when no usable verdict is found.
 */
function parseModerationVerdict(text: string): ScreenImageResult | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.allowed !== "boolean") {
    return null;
  }
  return {
    allowed: record.allowed,
    reason: typeof record.reason === "string" ? record.reason : undefined
  };
}

/**
 * The REQUIRED moderation gate. Screens generated image bytes with a vision
 * model before they can be saved to a project.
 *
 * FAIL CLOSED: any classifier error, non-JSON answer, missing `allowed`, or a
 * value other than `allowed === true` results in `{ allowed: false }`. The gate
 * only opens when the classifier explicitly answers `{"allowed": true}`.
 *
 * Same one-credential contract + spend metadata as generation, purpose
 * "image-moderation".
 */
export async function screenImage(
  env: CailImageEnv,
  jwt: string | null,
  bytes: Uint8Array,
  fetchImpl: typeof fetch = fetch
): Promise<ScreenImageResult> {
  if (!env.CAIL_API_BASE) {
    return { allowed: false };
  }

  const model = resolveImageClassifierId(env);
  const dataUri = `data:image/png;base64,${encodeBase64(bytes)}`;

  let response: Response;
  try {
    response = await fetchImpl(chatCompletionsUrl(env.CAIL_API_BASE), {
      method: "POST",
      headers: {
        ...buildProxyHeaders(jwt),
        "Content-Type": "application/json",
        "X-CAIL-Metadata": JSON.stringify({ purpose: "image-moderation" })
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: IMAGE_MODERATION_INSTRUCTION },
          {
            role: "user",
            content: [
              { type: "text", text: "Is this image appropriate to publish? Answer with the JSON only." },
              { type: "image_url", image_url: { url: dataUri } }
            ]
          }
        ]
      })
    });
  } catch {
    return { allowed: false };
  }

  if (!response.ok) {
    return { allowed: false };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { allowed: false };
  }

  const text = extractAssistantText(payload);
  if (!text) {
    return { allowed: false };
  }

  const verdict = parseModerationVerdict(text);
  if (!verdict || verdict.allowed !== true) {
    return { allowed: false, reason: verdict?.reason };
  }

  return { allowed: true, reason: verdict.reason };
}

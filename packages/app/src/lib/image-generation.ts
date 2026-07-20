/**
 * AI image generation + a REQUIRED moderation gate, both via the CAIL gateway
 * through the shared `@cuny-ai-lab/cail-client` library. Same one-credential
 * contract as model.ts: the client sends the caller's identity in
 * `X-CAIL-Identity-JWT` and NEVER an `Authorization` header. The gateway
 * authenticates on the JWT, attaches the real provider credentials, and
 * forwards to Workers AI.
 *
 * Unlike the chat path (which adapts the client for the OpenAI-compatible AI
 * SDK), these call the client's model endpoints directly:
 *   - generation → `client.run({model, input})`, the gateway's native
 *     Cloudflare endpoint `POST {CAIL_API_BASE}/v1/run` (buffered; returns the
 *     UNWRAPPED native result — the image payload directly).
 *   - moderation → `client.chatCompletions(...)`, the OpenAI-compatible
 *     `POST {CAIL_API_BASE}/v1/chat/completions`, so we can send a multimodal
 *     (image_url) message to a vision model.
 *
 * The client still sends `options.metadata` (`X-CAIL-Metadata` on the wire),
 * but the current canonical gateway ignores caller metadata. It must not be
 * treated as authoritative per-purpose spend attribution.
 */

import { CailError, createCailClient, type CailClient } from "@cuny-ai-lab/cail-client";
import {
  assertCailJwtFresh,
  CAIL_APP_SLUG,
  resolveWorkersAiModelId,
  type CailModelEnv
} from "./model";
import { sniffImageType, type ImageType } from "./image-validation";
import { IMAGE_MAX_UPLOAD_BYTES } from "./constants";

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
 * screen. CAIL policy applies here too: must be a vision-capable id from the
 * gateway's curated catalog (models-policy.json). Overridable via
 * `CAIL_IMAGE_CLASSIFIER`. `@cf/meta/llama-4-scout-17b-16e-instruct` is the
 * catalog's other vision model if this id is unavailable.
 */
export const DEFAULT_CAIL_IMAGE_CLASSIFIER = "@cf/moonshotai/kimi-k2.6";

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
  return resolveWorkersAiModelId(
    env.CAIL_IMAGE_MODEL,
    DEFAULT_CAIL_IMAGE_MODEL,
    "CAIL_IMAGE_MODEL"
  );
}

/** Resolve the moderation classifier id (configurable, must be `@cf/`). */
export function resolveImageClassifierId(env: CailImageEnv): string {
  return resolveWorkersAiModelId(
    env.CAIL_IMAGE_CLASSIFIER,
    DEFAULT_CAIL_IMAGE_CLASSIFIER,
    "CAIL_IMAGE_CLASSIFIER"
  );
}

/** Flux 2 Klein dimensions: multiples of 64, clamped to [256, 1920]. */
const MIN_DIMENSION = 256;
const MAX_DIMENSION = 1920;
const DIMENSION_STEP = 64;
const DEFAULT_DIMENSION = 1024;

/**
 * Clamp a requested dimension to a sane, model-friendly value: a multiple of 64
 * within [256, 1920]. Non-finite or missing input falls back to 1024.
 */
export function clampDimension(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DIMENSION;
  }
  const rounded = Math.round(value / DIMENSION_STEP) * DIMENSION_STEP;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, rounded));
}

/** Build the shared CAIL client bound to this tool's spend-attribution slug. */
function cailClient(apiBase: string, fetchImpl: typeof fetch): CailClient {
  // Image generation and moderation are billed POSTs. Disable automatic
  // retries until the gateway can deduplicate execution, not only ledger rows.
  return createCailClient({
    baseUrl: apiBase,
    app: CAIL_APP_SLUG,
    fetchImpl,
    maxRetries: 0,
    allowInsecureLoopback: true,
  });
}

/**
 * Decode a base64 (or base64url) string into a Uint8Array. Uses `atob`, which
 * is available in both the Cloudflare Workers runtime and the Node vitest env.
 * Throws on invalid base64 (caught by the caller).
 */
function decodeBase64(data: string): Uint8Array {
  const normalized = data.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Pull a base64 image payload out of the native result `/v1/run` returns.
 * The gateway unwraps Cloudflare's `{success, result, errors}` envelope, so
 * the image fields arrive at the top level (`image` for flux; `image_b64` /
 * `b64_json` cover other Workers AI image ids).
 */
function extractBase64Image(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const result = payload as Record<string, unknown>;

  const candidate =
    (typeof result.image === "string" && result.image) ||
    (typeof result.image_b64 === "string" && result.image_b64) ||
    (typeof (result as Record<string, unknown>).b64_json === "string" &&
      (result as Record<string, unknown>).b64_json);

  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export type GenerateImageResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; message: string };

export interface GenerateImageInput {
  prompt: string;
  width?: number;
  height?: number;
}

/**
 * Generate an image via the gateway's native `/v1/run` endpoint.
 *
 * One-credential contract: `{kind: "jwt"}` only — the client guarantees no
 * `Authorization` header. Purpose metadata is advisory at the client only; the
 * current gateway ignores it.
 *
 * On a gateway/provider error the client throws a typed `CailError` whose
 * `message` is the CAIL error envelope's message verbatim; we pass it through
 * unmodified (per contract — do not reword gateway error messages).
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
  if (!jwt) {
    // The gateway is JWT-first/strict; without a verified identity the call
    // could only ever earn its authentication_required envelope.
    return { ok: false, message: "Image generation requires an authenticated caller" };
  }
  assertCailJwtFresh(jwt);

  const model = resolveImageModelId(env);
  const width = clampDimension(input.width);
  const height = clampDimension(input.height);

  let response: Response;
  try {
    response = await cailClient(env.CAIL_API_BASE, fetchImpl).run(
      { model, input: { prompt: input.prompt, width, height } },
      { kind: "jwt", token: jwt },
      { metadata: { purpose: "image-generation" } }
    );
  } catch (error) {
    if (error instanceof CailError) {
      // The envelope message, verbatim.
      return { ok: false, message: error.message };
    }
    return { ok: false, message: "Image generation failed" };
  }

  let payload: unknown;
  const maxEncodedBytes = Math.ceil(IMAGE_MAX_UPLOAD_BYTES / 3) * 4;
  const maxResponseBytes = maxEncodedBytes + 64 * 1024;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    return { ok: false, message: "Image generation returned an image larger than 10MB" };
  }
  try {
    const responseText = await readBoundedText(response, maxResponseBytes);
    if (responseText === null) {
      return { ok: false, message: "Image generation returned an image larger than 10MB" };
    }
    payload = JSON.parse(responseText);
  } catch {
    return { ok: false, message: "Image generation returned a non-JSON response" };
  }

  const base64 = extractBase64Image(payload);
  if (!base64) {
    return { ok: false, message: "Image generation response did not contain an image" };
  }
  if (base64.replace(/\s/g, "").length > maxEncodedBytes + 4) {
    return { ok: false, message: "Image generation returned an image larger than 10MB" };
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
  if (bytes.byteLength > IMAGE_MAX_UPLOAD_BYTES) {
    return { ok: false, message: "Image generation returned an image larger than 10MB" };
  }

  // Content type follows the actual bytes (flux returns png today, but don't
  // hardcode the assumption); unknown formats fall back to png and are caught
  // by the flow's sniff check anyway.
  const sniffed = sniffImageType(bytes);
  return { ok: true, bytes, contentType: sniffed ? `image/${sniffed}` : "image/png" };
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
  if (!env.CAIL_API_BASE || !jwt) {
    return { allowed: false };
  }
  assertCailJwtFresh(jwt);

  const model = resolveImageClassifierId(env);
  const imageType = sniffImageType(bytes);
  if (!imageType || bytes.byteLength > IMAGE_MAX_UPLOAD_BYTES) {
    return { allowed: false };
  }
  const mimeType = imageType === "jpeg" ? "image/jpeg" : `image/${imageType}`;
  const dataUri = `data:${mimeType};base64,${encodeBase64(bytes)}`;

  let response: Response;
  try {
    response = await cailClient(env.CAIL_API_BASE, fetchImpl).chatCompletions(
      {
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
      },
      { kind: "jwt", token: jwt },
      { metadata: { purpose: "image-moderation" } }
    );
  } catch {
    // FAIL CLOSED: CailError (any non-2xx) and network throws alike.
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

/** Calm, non-shaming rejection copy. The classifier's reason is never echoed. */
export const GENERATED_IMAGE_REJECTED_MESSAGE =
  "I couldn't use that image — it didn't pass the content check for published sites. Try rephrasing what you'd like.";

/** File extension for a sniffed image type (jpeg saves as .jpg). */
export function imageExtensionForType(type: ImageType): string {
  return type === "jpeg" ? "jpg" : type;
}

/**
 * Sanitize an optional user/model-suggested basename and give it the extension
 * matching the actual image bytes. Empty/degenerate input falls back to a
 * timestamped name.
 */
export function sanitizeGeneratedImageName(raw: string | undefined, type: ImageType): string {
  const base = (raw || "").split("/").pop()?.split("\\").pop() ?? "";
  const withoutExt = base.replace(/\.(png|jpe?g|gif|webp)$/i, "");
  const cleaned = withoutExt.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
  const stem = cleaned.length > 0 ? cleaned : `generated-${Date.now()}`;
  return `${stem}.${imageExtensionForType(type)}`;
}

export interface GenerateImageFlowDeps {
  /** Produce the image (already bound to env/jwt/input). */
  generate: () => Promise<GenerateImageResult>;
  /** The REQUIRED moderation gate (already bound to env/jwt). */
  screen: (bytes: Uint8Array) => Promise<ScreenImageResult>;
  /**
   * Collision-safe persist, project-scoped. Writes the image at `path` ONLY if
   * no file already exists there, returning `true` when this call performed the
   * write and `false` when the path was already taken. Called ONLY after the
   * gate allows. The atomic put-if-absent closes the read-check-write TOCTOU
   * that a separate `fileExists` probe + `save` left open: two concurrent
   * generations racing for `images/photo.png` no longer clobber each other —
   * the loser advances to `images/photo_1.png`.
   */
  saveIfAbsent: (path: string, bytes: Uint8Array) => Promise<boolean>;
}

export type GenerateImageFlowResult =
  | { ok: true; path: string; message: string }
  | { ok: false; message: string };

/**
 * The generate_image tool's orchestration, extracted so its ORDERING is
 * testable outside the Durable Object module (which Node's test loader cannot
 * import): generate → sniff → screen → only then save. `save` must be
 * unreachable on any rejected, failed, or throwing screen — the integration
 * tests pin exactly that property.
 */
export async function runGenerateImageFlow(
  filename: string | undefined,
  deps: GenerateImageFlowDeps
): Promise<GenerateImageFlowResult> {
  const generated = await deps.generate();
  if (!generated.ok) {
    // CAIL error envelope passed through unmodified.
    return { ok: false, message: generated.message };
  }

  // Sanity check the bytes really are an image before screening/saving.
  const sniffed = sniffImageType(generated.bytes);
  if (!sniffed) {
    return { ok: false, message: "The generator did not return a valid image. Try again in a moment." };
  }

  // The gate. screenImage itself fails closed, but the flow also treats a
  // throwing screen dependency as a rejection so the property survives
  // refactors of either side.
  let allowed = false;
  try {
    allowed = (await deps.screen(generated.bytes)).allowed === true;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    return { ok: false, message: GENERATED_IMAGE_REJECTED_MESSAGE };
  }

  // Collision-suffix within images/, mirroring the upload route. Extension
  // follows the sniffed bytes so the served content type is honest. The write
  // is atomic: we ATTEMPT saveIfAbsent at each candidate and only advance the
  // suffix when the conditional write loses the race, so two concurrent
  // generations can't clobber each other on the same name.
  const safeName = sanitizeGeneratedImageName(filename, sniffed);
  const ext = imageExtensionForType(sniffed);
  const stem = safeName.replace(new RegExp(`\\.${ext}$`, "i"), "");

  const MAX_SAVE_ATTEMPTS = 50;
  let path = "";
  let written = false;
  for (let counter = 0; counter < MAX_SAVE_ATTEMPTS; counter += 1) {
    const candidate = counter === 0 ? `images/${safeName}` : `images/${stem}_${counter}.${ext}`;
    if (await deps.saveIfAbsent(candidate, generated.bytes)) {
      path = candidate;
      written = true;
      break;
    }
  }

  if (!written) {
    return { ok: false, message: "Couldn't find a free filename to save the image. Try a different name." };
  }

  return {
    ok: true,
    path,
    message: `Saved a generated image to ${path}. Agree on descriptive alt text before or right after inserting it.`
  };
}

/**
 * Model access via the CAIL gateway, through the shared
 * `@cuny-ai-lab/cail-client` library.
 *
 * Site Studio holds NO provider API keys. Every chat call goes to the CAIL
 * gateway's OpenAI-compatible endpoint at
 * `POST {CAIL_API_BASE}/v1/chat/completions`. The gateway authenticates the
 * caller, stamps per-user spend metadata keyed to the CAIL subject, attaches
 * the real provider credentials, and forwards upstream. A tool that bypasses
 * the gateway has no model access.
 *
 * The shared client owns the wire contract: the caller's `X-CAIL-Identity-JWT`
 * (the browser session's verified identity, minted by the SSO gate) plus the
 * stable `X-CAIL-App` slug travel on every call, and exactly ONE credential
 * reaches the wire — the client's `chatFetch` adapter strips the AI SDK's
 * dummy `Authorization` bearer before the request leaves.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { createCailClient } from "@cuny-ai-lab/cail-client";

/** Stable spend-attribution slug for this tool. */
export const CAIL_APP_SLUG = "site-studio";

/**
 * Default model id. CAIL policy (decided 2026-07-04):
 * Cloudflare models only — every model reference is a Workers AI catalog id
 * (`@cf/...`); no OpenAI/Anthropic/OpenRouter ids. Overridable via `CAIL_MODEL`,
 * but the configured value must also be a Workers AI id.
 *
 * GLM-5.2 is Workers AI's flagship agentic-coding model (262k context,
 * function calling, cached-input pricing) — chosen because the codemode loop
 * is code generation against typed project APIs. `@cf/openai/gpt-oss-120b`
 * is the cheaper general-reasoning alternative if spend becomes a concern.
 */
export const DEFAULT_CAIL_MODEL = "@cf/zai-org/glm-5.2";

export interface CailModelEnv {
  CAIL_API_BASE?: string;
  CAIL_MODEL?: string;
}

/**
 * Resolve the configured model id.
 */
export function resolveModelId(env: CailModelEnv): string {
  return env.CAIL_MODEL || DEFAULT_CAIL_MODEL;
}

/**
 * Build an AI-SDK language model bound to the CAIL gateway for the given
 * caller.
 *
 * One-credential contract (CAIL backbone rule): a gateway request carries
 * exactly ONE credential. On the browser/JWT path that is
 * `X-CAIL-Identity-JWT`, and there must be NO `Authorization` header — the
 * gateway is JWT-first/strict. The cail-client `chatFetch` adapter enforces
 * this: the `apiKey` handed to the SDK below is a dummy the adapter strips
 * before the request reaches the wire (pinned by the wire test in
 * model.test.ts). Non-2xx responses keep raw fetch semantics, so gateway
 * error envelopes (authentication_required / upstream errors / …) surface to
 * the AI SDK unmodified — with ONE library-owned carve-out: a 429
 * `quota_exceeded` envelope makes `chatFetch` THROW the parsed `CailError`
 * (verbatim message, `extras.retry_after_seconds`) instead of returning the
 * Response, so the AI SDK never retries a budget-window 429 and the quota
 * envelope reaches error surfacing intact (pinned in model.test.ts;
 * surfaced to the user by lib/model-stream-error.ts).
 *
 * Throws when `CAIL_API_BASE` is unset — the placeholder is filled in at
 * launch (cail-gateway docs/LAUNCH_CHECKLIST.md); there is no local fallback
 * because there are no provider keys to fall back to. Throws when the caller
 * has no identity JWT: the client library requires a credential, and a
 * JWT-less request could only ever earn the gateway's
 * `authentication_required` envelope.
 *
 * `fetchImpl` is an optional test seam for capturing the outbound request.
 */
export function createCailModel(
  env: CailModelEnv,
  identityJwt: string | null,
  fetchImpl?: typeof fetch
): LanguageModel {
  if (!env.CAIL_API_BASE) {
    throw new Error("CAIL_API_BASE is not configured");
  }
  if (!identityJwt) {
    throw new Error("CAIL identity JWT is missing — model access requires an authenticated caller");
  }

  const baseUrl = env.CAIL_API_BASE.replace(/\/+$/, "");
  const client = createCailClient({ baseUrl, app: CAIL_APP_SLUG, fetchImpl });

  const provider = createOpenAICompatible({
    name: "cail",
    baseURL: `${baseUrl}/v1`,
    // Dummy — the chatFetch adapter strips it and sends X-CAIL-Identity-JWT
    // instead (one-credential contract).
    apiKey: "cail-proxy",
    fetch: client.chatFetch({ kind: "jwt", token: identityJwt }) as typeof fetch,
  });

  return provider(resolveModelId(env));
}

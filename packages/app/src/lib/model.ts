/**
 * Model access via the CAIL model proxy (docs/INTEGRATION.md §1).
 *
 * Site Studio holds NO provider API keys. Every model call goes to the CAIL
 * model proxy at `{CAIL_API_BASE}/v1/compat/chat/completions` (Cloudflare AI
 * Gateway's OpenAI-compatible path). The proxy authenticates the caller, stamps
 * per-user spend metadata keyed to the CAIL subject, attaches the real provider
 * credentials, and forwards to the provider. A tool that bypasses the proxy has
 * no model access.
 *
 * We forward the caller's `X-CAIL-Identity-JWT` (the browser session's verified
 * identity, minted by the SSO gate) plus a stable `X-CAIL-App` slug so per-app
 * spend shows up in analytics.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/** Stable spend-attribution slug for this tool (docs/INTEGRATION.md §5). */
export const CAIL_APP_SLUG = "site-studio";

/**
 * Default model id. CAIL policy (decided 2026-07-04, docs/INTEGRATION.md §1):
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

/** Normalize a base URL to `{CAIL_API_BASE}/v1/compat` (no trailing slash). */
export function buildProxyBaseUrl(apiBase: string): string {
  const trimmed = apiBase.replace(/\/+$/, "");
  return `${trimmed}/v1/compat`;
}

/**
 * Headers forwarded to the proxy on every model call. The proxy authenticates
 * on `X-CAIL-Identity-JWT` and attributes spend on `X-CAIL-App`. When no JWT is
 * available the header is omitted; the proxy then answers with its own CAIL
 * error envelope (authentication_required / quota_exceeded / …) which we pass
 * through to the client unmodified.
 */
export function buildProxyHeaders(identityJwt: string | null): Record<string, string> {
  const headers: Record<string, string> = { "X-CAIL-App": CAIL_APP_SLUG };
  if (identityJwt) {
    headers["X-CAIL-Identity-JWT"] = identityJwt;
  }
  return headers;
}

/**
 * Resolve the configured model id (configurable per docs/INTEGRATION.md §5).
 */
export function resolveModelId(env: CailModelEnv): string {
  return env.CAIL_MODEL || DEFAULT_CAIL_MODEL;
}

/**
 * Build an AI-SDK language model bound to the CAIL proxy for the given caller.
 *
 * Throws when `CAIL_API_BASE` is unset — the placeholder is filled in at launch
 * (cail-gateway docs/LAUNCH_CHECKLIST.md); there is no local fallback because
 * there are no provider keys to fall back to.
 */
export function createCailModel(
  env: CailModelEnv,
  identityJwt: string | null
): LanguageModel {
  if (!env.CAIL_API_BASE) {
    throw new Error("CAIL_API_BASE is not configured");
  }

  const provider = createOpenAICompatible({
    name: "cail",
    baseURL: buildProxyBaseUrl(env.CAIL_API_BASE),
    // No apiKey: the proxy scrubs caller credentials and attaches the real
    // provider key itself. Identity travels in X-CAIL-Identity-JWT instead.
    headers: buildProxyHeaders(identityJwt),
  });

  return provider(resolveModelId(env));
}

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
import { APICallError } from "@ai-sdk/provider";
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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

/**
 * Mark the CAIL proxy's hard hourly quota response as non-retryable while
 * leaving every other response untouched for the AI SDK's normal policy.
 */
export function createQuotaAwareFetch(fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchImpl(input, init);
    if (response.status !== 429) {
      return response;
    }

    const responseBody = await response.clone().text();
    if (!/quota_exceeded/i.test(responseBody)) {
      return response;
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    throw new APICallError({
      message: "Too Many Requests",
      url: requestUrl(input),
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders,
      responseBody,
      isRetryable: false
    });
  }) as typeof fetch;
}

/**
 * Build an AI-SDK language model bound to the CAIL proxy for the given caller.
 *
 * One-credential contract (docs/INTEGRATION.md, CAIL backbone rule): a
 * model-proxy request carries exactly ONE credential. On the browser/JWT path
 * that is `X-CAIL-Identity-JWT`, and there must be NO `Authorization` header —
 * the proxy is JWT-first/strict. We pass no apiKey, and the OpenAI-compatible
 * SDK only emits `Authorization` when an apiKey is truthy, so we stay compliant
 * by construction (pinned by the wire test in model.test.ts).
 *
 * Throws when `CAIL_API_BASE` is unset — the placeholder is filled in at launch
 * (cail-gateway docs/LAUNCH_CHECKLIST.md); there is no local fallback because
 * there are no provider keys to fall back to.
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

  const fetch = createQuotaAwareFetch(fetchImpl ?? globalThis.fetch);

  const provider = createOpenAICompatible({
    name: "cail",
    baseURL: buildProxyBaseUrl(env.CAIL_API_BASE),
    // No apiKey: the proxy scrubs caller credentials and attaches the real
    // provider key itself. Identity travels in X-CAIL-Identity-JWT instead.
    headers: buildProxyHeaders(identityJwt),
    fetch,
  });

  return provider(resolveModelId(env));
}

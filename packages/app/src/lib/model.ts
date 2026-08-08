import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

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

export interface CailModelOptions {
  /** Enable provider JSON-schema output only for a proven model path. */
  supportsStructuredOutputs?: boolean;
}

const WORKERS_AI_MODEL_ID_RE = /^@cf\/[a-z0-9][a-z0-9._/-]*$/i;

export function resolveWorkersAiModelId(
  configured: string | undefined,
  fallback: string,
  variableName: string
): string {
  const value = configured ?? fallback;
  if (value.trim() !== value || !WORKERS_AI_MODEL_ID_RE.test(value)) {
    throw new Error(`${variableName} must be a Cloudflare Workers AI model id beginning with @cf/`);
  }
  return value;
}

export function assertCailJwtFresh(token: string, nowMs = Date.now(), minimumTtlSeconds = 15): void {
  const payload = token.split(".")[1];
  if (!payload) return;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
    ) as { exp?: unknown };
    if (typeof decoded.exp === "number" && decoded.exp * 1000 <= nowMs + minimumTtlSeconds * 1000) {
      throw new Error("CAIL identity expired during this turn. Reconnect and retry.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("identity expired")) throw error;
    // The request boundary owns JWT verification. This check only enforces the
    // expiry on that already-verified token before each outbound model POST.
  }
}

/**
 * Validate the public gateway base before a provider can construct a request.
 * The only plaintext exception is the exact loopback opt-in used by local
 * Worker development; deployment values must be HTTPS and cannot carry
 * credentials, query parameters, fragments, whitespace, or controls.
 */
export function canonicalCailApiBase(apiBase: string): string {
  if (apiBase.trim() !== apiBase || /[\u0000-\u001f\u007f\s\\]/.test(apiBase)) {
    throw new Error("CAIL_API_BASE must be a trimmed absolute HTTPS URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    throw new Error("CAIL_API_BASE must be a trimmed absolute HTTPS URL.");
  }

  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    apiBase.includes("?") ||
    apiBase.includes("#")
  ) {
    throw new Error("CAIL_API_BASE must not contain credentials, a query, or a fragment.");
  }

  const loopback =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error(
      "CAIL_API_BASE must use HTTPS; HTTP is allowed only for an exact loopback host.",
    );
  }

  return apiBase.replace(/\/+$/, "");
}

const SAFE_GATEWAY_HEADERS = [
  "accept",
  "user-agent",
  "traceparent",
  "tracestate",
] as const;

/**
 * Keep provider and caller authority out of the final model request. The AI
 * SDK merges per-call headers after provider defaults, so this is the last
 * trust boundary before a billed request leaves the Worker.
 */
export function createCailAuthorityFetch(
  identityJwt: string,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    assertCailJwtFresh(identityJwt);

    // AI SDK normally passes a URL plus init, but the Web Fetch contract also
    // permits a Request carrying its own hostile headers. Normalize both
    // sources before the allowlist so the final seam has one view of caller
    // input and does not accidentally forward Request-owned authority.
    const sourceRequest = input instanceof Request ? new Request(input, init) : undefined;
    const sdkHeaders = sourceRequest
      ? new Headers(sourceRequest.headers)
      : new Headers(init?.headers);
    const safeHeaders = new Headers();
    for (const name of SAFE_GATEWAY_HEADERS) {
      const value = sdkHeaders.get(name);
      if (value !== null) safeHeaders.set(name, value);
    }

    // Every billed CAIL chat request is JSON. Do not let a per-call header
    // change the body interpretation at the gateway boundary.
    safeHeaders.set("content-type", "application/json");
    safeHeaders.set("authorization", `Bearer ${identityJwt}`);
    safeHeaders.set("x-cail-app", CAIL_APP_SLUG);

    return fetchImpl(sourceRequest ?? input, {
      ...init,
      headers: safeHeaders,
      credentials: "omit",
      redirect: "error",
    });
  }) as typeof fetch;
}

/**
 * Resolve the configured model id.
 */
export function resolveModelId(env: CailModelEnv): string {
  return resolveWorkersAiModelId(env.CAIL_MODEL, DEFAULT_CAIL_MODEL, "CAIL_MODEL");
}

/**
 * Build an AI-SDK language model bound to the CAIL gateway for the given
 * caller. The verified Doorway JWT is the ordinary bearer credential used by
 * the OpenAI-compatible provider. The final fetch seam strips any per-call
 * authority/routing headers and stamps the server-owned bearer and app slug.
 *
 * Throws when `CAIL_API_BASE` is unset. The checked-in value is not a live
 * deployment attestation, and there is no local fallback because there are no
 * provider keys to fall back to. Throws when the caller
 * has no identity JWT: the client library requires a credential, and a
 * JWT-less request could only ever earn the gateway's
 * `authentication_required` envelope.
 *
 * `fetchImpl` is an optional test seam for capturing the outbound request.
 */
export function createCailModel(
  env: CailModelEnv,
  identityJwt: string | null,
  fetchImpl?: typeof fetch,
  options: CailModelOptions = {},
): LanguageModel {
  if (!env.CAIL_API_BASE) {
    throw new Error("CAIL_API_BASE is not configured");
  }
  if (!identityJwt) {
    throw new Error("CAIL identity JWT is missing — model access requires an authenticated caller");
  }

  const baseUrl = canonicalCailApiBase(env.CAIL_API_BASE);
  const gatewayFetch = createCailAuthorityFetch(identityJwt, fetchImpl);

  const provider = createOpenAICompatible({
    name: "cail",
    baseURL: `${baseUrl}/v1`,
    apiKey: identityJwt,
    supportsStructuredOutputs: options.supportsStructuredOutputs ?? false,
    fetch: gatewayFetch,
  });

  return provider(resolveModelId(env));
}

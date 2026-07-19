import { extractCailError } from "@cuny-ai-lab/cail-client";

function retryAfterValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const headers = value as Record<string, unknown> & { get?: (name: string) => string | null };
  if (typeof headers.get === "function") {
    const found = headers.get("retry-after");
    if (found) {
      return found;
    }
  }

  for (const [name, headerValue] of Object.entries(headers)) {
    if (name.toLowerCase() === "retry-after" && (typeof headerValue === "string" || typeof headerValue === "number")) {
      return String(headerValue);
    }
  }

  return undefined;
}

function retryAfterSeconds(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const seconds = (value as Record<string, unknown>).retry_after_seconds;
  if (typeof seconds === "number" || typeof seconds === "string") {
    return String(seconds);
  }
  return undefined;
}

function genericQuotaMessage(retryAfter: string | undefined): string {
  return "You've reached your AI usage limit for now."
    + (retryAfter
      ? ` Try again in about ${retryAfter} seconds.`
      : " Please try again shortly.");
}

export function describeModelStreamError(error: unknown): { message: string; quota: boolean } {
  // The shared cail-client helper owns the extraction: it digs the typed CAIL
  // envelope (or a thrown/wrapped CailError) out of AI-SDK wrappers —
  // RetryError errors[]/lastError, APICallError.responseBody JSON strings,
  // nested cause/error/data layers. Its `message` is the gateway envelope's
  // message VERBATIM — safe to show the user as-is.
  const cail = extractCailError(error);
  if (cail?.code === "quota_exceeded") {
    if (cail.message.trim().length > 0) {
      return { quota: true, message: cail.message };
    }
    // Envelope present but empty message: fall back to the retry hint the
    // envelope (or the live CailError's extras) carried.
    return {
      quota: true,
      message: genericQuotaMessage(retryAfterSeconds(cail.extras))
    };
  }

  // No typed envelope found. Site Studio's own defensive heuristic: a bare
  // 429 (statusCode/status) or "quota_exceeded" text anywhere in the wrapper
  // layers still reads as quota exhaustion, with Retry-After header wording
  // when available. This deliberately stays local — the shared helper never
  // sniffs statuses or message text.
  const layers: unknown[] = [error];
  const seen = new Set<object>();
  let quota = false;
  let retryAfter: string | undefined;

  while (layers.length > 0) {
    const layer = layers.shift();
    if (typeof layer === "string") {
      quota ||= /quota_exceeded/i.test(layer);
      continue;
    }
    if (!layer || typeof layer !== "object" || seen.has(layer)) {
      continue;
    }
    seen.add(layer);

    const record = layer as Record<string, unknown>;
    quota ||= record.statusCode === 429 || record.status === 429;

    for (const value of [record.responseBody, record.data, record.message]) {
      if (typeof value === "string" && /quota_exceeded/i.test(value)) {
        quota = true;
      }
    }

    retryAfter ||= retryAfterValue(record.responseHeaders) || retryAfterValue(record.headers);

    for (const nested of [record.cause, record.error, record.data, record.lastError, record.responseBody]) {
      if (nested !== undefined) {
        layers.push(nested);
      }
    }

    if (Array.isArray(record.errors)) {
      layers.push(...record.errors);
    }
  }

  if (quota) {
    return { quota: true, message: genericQuotaMessage(retryAfter) };
  }

  return {
    quota: false,
    message: "Site Studio hit an internal error while streaming this response."
  };
}

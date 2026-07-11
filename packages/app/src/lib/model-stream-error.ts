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

export function describeModelStreamError(error: unknown): { message: string; quota: boolean } {
  const layers: unknown[] = [error];
  const seen = new Set<object>();
  let quota = false;
  let retryAfter: string | undefined;
  let verbatimQuotaMessage: string | undefined;

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
    quota ||= record.statusCode === 429;

    // cail-client's chatFetch throws the parsed CailError on a 429
    // quota_exceeded envelope (before any wrapper sees the Response). Its
    // `message` is the gateway envelope's message VERBATIM — safe to show
    // the user as-is. Match on the envelope `code` shape (not `instanceof
    // CailError`) so a wrapped or structured-cloned copy — e.g. inside an
    // AI SDK RetryError's `errors` array — still counts.
    if (record.code === "quota_exceeded") {
      quota = true;
      if (typeof record.message === "string" && record.message.trim().length > 0) {
        verbatimQuotaMessage ||= record.message;
      }
      const extras = record.extras;
      if (extras && typeof extras === "object") {
        const seconds = (extras as Record<string, unknown>).retry_after_seconds;
        if (typeof seconds === "number" || typeof seconds === "string") {
          retryAfter ||= String(seconds);
        }
      }
    }

    for (const value of [record.responseBody, record.data, record.message]) {
      if (typeof value === "string" && /quota_exceeded/i.test(value)) {
        quota = true;
      }
    }

    retryAfter ||= retryAfterValue(record.responseHeaders) || retryAfterValue(record.headers);

    for (const nested of [record.cause, record.error, record.data, record.lastError]) {
      if (nested !== undefined) {
        layers.push(nested);
      }
    }

    if (Array.isArray(record.errors)) {
      layers.push(...record.errors);
    }
  }

  if (quota) {
    return {
      quota: true,
      message: verbatimQuotaMessage
        ?? ("You've reached your AI usage limit for now."
          + (retryAfter
            ? ` Try again in about ${retryAfter} seconds.`
            : " Please try again shortly."))
    };
  }

  return {
    quota: false,
    message: "Site Studio hit an internal error while streaming this response."
  };
}

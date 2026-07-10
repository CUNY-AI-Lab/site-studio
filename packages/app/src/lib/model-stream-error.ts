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
      message: "You've reached your AI usage limit for now."
        + (retryAfter
          ? ` Try again in about ${retryAfter} seconds.`
          : " Please try again shortly.")
    };
  }

  return {
    quota: false,
    message: "Site Studio hit an internal error while streaming this response."
  };
}

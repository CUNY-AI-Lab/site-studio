import { extractCailError } from "@cuny-ai-lab/cail-client";

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

/**
 * Describe only typed CAIL quota envelopes as quota. A bare provider 429 or
 * message text is not enough: provider rate limits and transient upstream
 * errors are not CAIL budget decisions and must not be mislabeled to users or
 * action accounting.
 */
export function describeModelStreamError(error: unknown): { message: string; quota: boolean } {
  const cail = extractCailError(error);
  if (cail?.code === "quota_exceeded") {
    if (cail.message.trim().length > 0) {
      return { quota: true, message: cail.message };
    }
    return {
      quota: true,
      message: genericQuotaMessage(retryAfterSeconds(cail.extras)),
    };
  }

  return {
    quota: false,
    message: "Site Studio hit an internal error while streaming this response.",
  };
}

import { extractCailError, type CailError } from "@cuny-ai-lab/cail-client";
import { z } from "zod";

const retryAfterSchema = z.object({
  retry_after_seconds: z.union([z.number(), z.string()]).optional(),
});

export type DescribedModelStreamError = Readonly<{
  message: string;
  quota: boolean;
}>;

function retryAfterSeconds(value: CailError["extras"]): string | undefined {
  const parsed = retryAfterSchema.safeParse(value);
  if (!parsed.success || parsed.data.retry_after_seconds === undefined) {
    return undefined;
  }
  return String(parsed.data.retry_after_seconds);
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
export function describeModelStreamError(
  error: Parameters<typeof extractCailError>[0],
): DescribedModelStreamError {
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
    message: "The response stopped partway. Send your message again.",
  };
}

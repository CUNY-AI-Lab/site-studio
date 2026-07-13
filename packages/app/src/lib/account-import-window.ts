import { z } from "zod";
import type { Env } from "../types";

export const MAX_ACCOUNT_IMPORT_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const isoInstantSchema = z.iso.datetime({ offset: true });

export type AccountImportWindowState = "not_started" | "open" | "expired";

export interface AccountImportWindow {
  switchedAt: string;
  importUntil: string;
  switchedAtMs: number;
  importUntilMs: number;
  state: AccountImportWindowState;
}

export type AccountImportConfigurationErrorCode =
  | "account_import_config_missing"
  | "account_import_switched_at_invalid"
  | "account_import_until_invalid"
  | "account_import_range_invalid"
  | "account_import_duration_exceeded";

export class AccountImportConfigurationError extends Error {
  readonly code: AccountImportConfigurationErrorCode;

  constructor(code: AccountImportConfigurationErrorCode) {
    super(code);
    this.name = "AccountImportConfigurationError";
    this.code = code;
  }
}

/**
 * Parse the temporary legacy-account import window. Both bounds must be ISO
 * 8601 instants with an explicit UTC offset. The upper bound is exclusive.
 */
export function resolveAccountImportWindow(
  env: Pick<Env, "CAIL_SSO_SWITCHED_AT" | "CAIL_ACCOUNT_IMPORT_UNTIL">,
  nowMs = Date.now()
): AccountImportWindow {
  const switchedAt = env.CAIL_SSO_SWITCHED_AT;
  const importUntil = env.CAIL_ACCOUNT_IMPORT_UNTIL;

  if (!switchedAt || !importUntil) {
    throw new AccountImportConfigurationError("account_import_config_missing");
  }
  if (!isoInstantSchema.safeParse(switchedAt).success) {
    throw new AccountImportConfigurationError("account_import_switched_at_invalid");
  }
  if (!isoInstantSchema.safeParse(importUntil).success) {
    throw new AccountImportConfigurationError("account_import_until_invalid");
  }

  const switchedAtMs = Date.parse(switchedAt);
  const importUntilMs = Date.parse(importUntil);
  if (importUntilMs < switchedAtMs) {
    throw new AccountImportConfigurationError("account_import_range_invalid");
  }
  if (importUntilMs - switchedAtMs > MAX_ACCOUNT_IMPORT_DURATION_MS) {
    throw new AccountImportConfigurationError("account_import_duration_exceeded");
  }

  const state: AccountImportWindowState =
    nowMs < switchedAtMs ? "not_started" : nowMs < importUntilMs ? "open" : "expired";

  return { switchedAt, importUntil, switchedAtMs, importUntilMs, state };
}

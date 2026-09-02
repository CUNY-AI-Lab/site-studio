import type {
  CailOutcome,
  CailTerminalReason,
} from "@cuny-ai-lab/cail-log";
import { z } from "zod";

export const ACTION_ATTEMPT_SCHEMA_VERSION = "site-studio.action-attempt.v1" as const;
export const ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION =
  "site-studio.action-attempt-admin.v1" as const;
export const ACTION_ATTEMPT_RETENTION_HOURS = 48 as const;

export type SiteStudioActionKind = "build" | "publish";
export const SITE_STUDIO_ACTION_ROUTES = Object.freeze({
  build: "/api/agents/site-builder/{project_id}",
  publish: "/api/projects/{id}/publish",
} as const satisfies Readonly<Record<SiteStudioActionKind, string>>);

export type ActionAttemptAdmission = Readonly<{
  actionId: string;
  action: SiteStudioActionKind;
  route: string;
  admittedAt: string;
}>;

export type ActionAttemptTerminal = Readonly<{
  actionId: string;
  outcome: CailOutcome;
  reason: CailTerminalReason;
  terminalAt: string;
  durationMs: number;
  errorType?: string;
}>;

export type DurableActionAttempt = Readonly<{
  schemaVersion: typeof ACTION_ATTEMPT_SCHEMA_VERSION;
  actionId: string;
  action: SiteStudioActionKind;
  route: string;
  admittedAt: string;
  terminalAt?: string;
  outcome?: CailOutcome;
  reason?: CailTerminalReason;
  durationMs?: number;
  errorType?: string;
}>;

export type ActionAttemptAdminRead = Readonly<{
  schemaVersion: typeof ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION;
  authoritative: true;
  retentionHours: typeof ACTION_ATTEMPT_RETENTION_HOURS;
  attempts: readonly DurableActionAttempt[];
}>;

export type ActionAttemptRecorder = Readonly<{
  admit(admission: ActionAttemptAdmission): void;
  terminal(terminal: ActionAttemptTerminal): void;
}>;

const ACTION_TERMINAL_REASONS_BY_OUTCOME = Object.freeze({
  ok: Object.freeze(["completed"]),
  client_error: Object.freeze(["client_error"]),
  error: Object.freeze(["application_failure", "upstream_failure"]),
  denied: Object.freeze(["denied", "quota_blocked", "rate_limited"]),
  cancelled: Object.freeze(["cancelled"]),
  timeout: Object.freeze(["timeout"]),
  outcome_unknown: Object.freeze(["unknown"]),
} as const satisfies Readonly<Record<CailOutcome, readonly CailTerminalReason[]>>);

const ACTION_TERMINAL_ERROR_TYPE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ACTION_ATTEMPT_TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });
const ACTION_TERMINAL_FACTS_SCHEMA = z.object({
  terminalAt: ACTION_ATTEMPT_TIMESTAMP_SCHEMA,
  durationMs: z.number().finite().nonnegative(),
  outcome: z.string(),
  reason: z.string(),
  errorType: z.string().regex(ACTION_TERMINAL_ERROR_TYPE_RE).optional(),
});

type ActionAttemptTerminalFacts = Readonly<Omit<ActionAttemptTerminal, "actionId">>;

/** Accept only the ISO datetime form written by the action lifecycle. */
export function isActionAttemptTimestamp(value: string): boolean {
  return ACTION_ATTEMPT_TIMESTAMP_SCHEMA.safeParse(value).success;
}

/** Validate the terminal fields that do not depend on a durable admission. */
export function isActionAttemptTerminalWellFormed(
  terminal: ActionAttemptTerminalFacts,
): boolean {
  return ACTION_TERMINAL_FACTS_SCHEMA.safeParse(terminal).success;
}

/** Validate a terminal against the admission whose duration it closes. */
export function isActionAttemptTerminalConsistent(
  terminal: ActionAttemptTerminalFacts & Readonly<{ admittedAt: string }>,
): boolean {
  if (
    !isActionAttemptTerminalWellFormed(terminal)
    || !isActionAttemptTimestamp(terminal.admittedAt)
  ) return false;
  const admittedAt = Date.parse(terminal.admittedAt);
  const terminalAt = Date.parse(terminal.terminalAt);
  const compatibleReasons = Object.hasOwn(
    ACTION_TERMINAL_REASONS_BY_OUTCOME,
    terminal.outcome,
  )
    ? ACTION_TERMINAL_REASONS_BY_OUTCOME[terminal.outcome]
    : undefined;
  return Number.isFinite(admittedAt)
    && terminalAt >= admittedAt
    && terminal.durationMs === terminalAt - admittedAt
    && compatibleReasons?.some((reason) => reason === terminal.reason) === true
    && (terminal.outcome !== "ok" || terminal.errorType === undefined);
}

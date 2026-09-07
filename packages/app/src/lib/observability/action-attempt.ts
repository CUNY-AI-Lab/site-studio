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

export type ActionReliabilitySummary = Readonly<{
  action: SiteStudioActionKind;
  eligibleAdmissions: number;
  successfulActions: number;
  coveredActions: number;
  successBasisPoints: number | null;
  coverageBasisPoints: number | null;
}>;

function basisPoints(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator * 10_000) / denominator);
}

/** Compute the exact SLI only from the authoritative durable admin read. */
export function summarizeDurableActionReliability(options: Readonly<{
  read: ActionAttemptAdminRead;
  action: SiteStudioActionKind;
  windowStartMs: number;
  windowEndMs: number;
  terminalGraceMinutes: number;
}>): ActionReliabilitySummary {
  if (
    options.read.schemaVersion !== ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION
    || options.read.authoritative !== true
    || !Number.isFinite(options.windowStartMs)
    || !Number.isFinite(options.windowEndMs)
    || options.windowEndMs <= options.windowStartMs
    || !Number.isFinite(options.terminalGraceMinutes)
    || options.terminalGraceMinutes < 0
  ) {
    throw new TypeError("invalid durable action reliability input");
  }
  const eligibilityEnd = options.windowEndMs - options.terminalGraceMinutes * 60_000;
  const seen = new Set<string>();
  const eligible: DurableActionAttempt[] = [];
  for (const attempt of options.read.attempts) {
    if (attempt.schemaVersion !== ACTION_ATTEMPT_SCHEMA_VERSION) {
      throw new TypeError("unsupported durable action attempt schema");
    }
    if (seen.has(attempt.actionId)) {
      throw new TypeError("duplicate durable action attempt id");
    }
    seen.add(attempt.actionId);
    if (attempt.route !== SITE_STUDIO_ACTION_ROUTES[attempt.action]) {
      throw new TypeError("durable action route is not recognized");
    }
    if (!isActionAttemptTimestamp(attempt.admittedAt)) {
      throw new TypeError("durable action admission time is invalid");
    }
    const admittedAt = Date.parse(attempt.admittedAt);
    if (
      attempt.action === options.action
      && admittedAt >= options.windowStartMs
      && admittedAt <= eligibilityEnd
    ) {
      eligible.push(attempt);
    }
  }

  let successfulActions = 0;
  let coveredActions = 0;
  for (const attempt of eligible) {
    const terminalFields = [
      attempt.terminalAt,
      attempt.outcome,
      attempt.reason,
      attempt.durationMs,
    ];
    const present = terminalFields.filter((value) => value !== undefined).length;
    if (
      (present === 0 && attempt.errorType !== undefined)
      || (present !== 0 && present !== terminalFields.length)
    ) {
      throw new TypeError("durable action terminal must be atomic");
    }
    if (present === terminalFields.length) {
      if (!isActionAttemptTerminalConsistent({
        admittedAt: attempt.admittedAt,
        terminalAt: attempt.terminalAt!,
        outcome: attempt.outcome!,
        reason: attempt.reason!,
        durationMs: attempt.durationMs!,
        errorType: attempt.errorType,
      })) {
        throw new TypeError("durable action terminal is contradictory");
      }
      coveredActions += 1;
      if (attempt.outcome === "ok") successfulActions += 1;
    }
  }
  return {
    action: options.action,
    eligibleAdmissions: eligible.length,
    successfulActions,
    coveredActions,
    successBasisPoints: basisPoints(successfulActions, eligible.length),
    coverageBasisPoints: basisPoints(coveredActions, eligible.length),
  };
}

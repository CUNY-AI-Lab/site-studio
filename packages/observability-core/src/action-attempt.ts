import type {
  CailOutcome,
  CailTerminalReason,
} from "@cuny-ai-lab/cail-log";

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
    const admittedAt = Date.parse(attempt.admittedAt);
    if (!Number.isFinite(admittedAt)) {
      throw new TypeError("durable action admission time is invalid");
    }
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
    if (present !== 0 && present !== terminalFields.length) {
      throw new TypeError("durable action terminal must be atomic");
    }
    if (present === terminalFields.length) {
      const terminalAt = Date.parse(attempt.terminalAt!);
      const admittedAt = Date.parse(attempt.admittedAt);
      const compatibleReason = {
        ok: new Set<CailTerminalReason>(["completed"]),
        client_error: new Set<CailTerminalReason>(["client_error"]),
        error: new Set<CailTerminalReason>(["application_failure", "upstream_failure"]),
        denied: new Set<CailTerminalReason>(["denied", "quota_blocked", "rate_limited"]),
        cancelled: new Set<CailTerminalReason>(["cancelled"]),
        timeout: new Set<CailTerminalReason>(["timeout"]),
        outcome_unknown: new Set<CailTerminalReason>(["unknown"]),
      } satisfies Readonly<Record<CailOutcome, ReadonlySet<CailTerminalReason>>>;
      if (
        !Number.isFinite(terminalAt)
        || terminalAt < admittedAt
        || attempt.durationMs !== terminalAt - admittedAt
        || !compatibleReason[attempt.outcome!].has(attempt.reason!)
        || (attempt.outcome === "ok" && attempt.errorType !== undefined)
      ) {
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

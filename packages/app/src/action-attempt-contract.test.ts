import { describe, expect, it } from "vitest";
import {
  ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION,
  ACTION_ATTEMPT_RETENTION_HOURS,
  ACTION_ATTEMPT_SCHEMA_VERSION,
  isActionAttemptTerminalConsistent,
  summarizeDurableActionReliability,
  type ActionAttemptAdminRead,
  type DurableActionAttempt,
} from "../../observability-core/src/action-attempt";

const HOUR = 3_600_000;
const end = Date.parse("2026-07-13T12:00:00.000Z");

function attempt(
  actionId: string,
  action: "build" | "publish",
  admittedAtMs: number,
  outcome?: "ok" | "error",
): DurableActionAttempt {
  const route = action === "build"
    ? "/api/agents/site-builder/{project_id}"
    : "/api/projects/{id}/publish";
  if (!outcome) {
    return {
      schemaVersion: ACTION_ATTEMPT_SCHEMA_VERSION,
      actionId,
      action,
      route,
      admittedAt: new Date(admittedAtMs).toISOString(),
    };
  }
  const terminalAtMs = admittedAtMs + 1_000;
  if (outcome === "error") {
    return {
      schemaVersion: ACTION_ATTEMPT_SCHEMA_VERSION,
      actionId,
      action,
      route,
      admittedAt: new Date(admittedAtMs).toISOString(),
      terminalAt: new Date(terminalAtMs).toISOString(),
      outcome,
      reason: "application_failure",
      durationMs: 1_000,
      errorType: "application_failure",
    };
  }
  return {
    schemaVersion: ACTION_ATTEMPT_SCHEMA_VERSION,
    actionId,
    action,
    route,
    admittedAt: new Date(admittedAtMs).toISOString(),
    terminalAt: new Date(terminalAtMs).toISOString(),
    outcome,
    reason: "completed",
    durationMs: 1_000,
  };
}

function read(attempts: readonly DurableActionAttempt[]): ActionAttemptAdminRead {
  return {
    schemaVersion: ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION,
    authoritative: true,
    retentionHours: ACTION_ATTEMPT_RETENTION_HOURS,
    attempts,
  };
}

describe("durable action reliability contract", () => {
  const admittedAt = "2026-07-13T10:00:00.000Z";
  const terminalAt = "2026-07-13T10:00:01.000Z";

  it.each([
    ["ok", "completed", undefined],
    ["client_error", "client_error", "invalid_request"],
    ["error", "application_failure", "application.failure"],
    ["error", "upstream_failure", "upstream-failure"],
    ["denied", "denied", "permission_denied"],
    ["denied", "quota_blocked", "quota.blocked"],
    ["denied", "rate_limited", "rate-limited"],
    ["cancelled", "cancelled", "cancelled"],
    ["timeout", "timeout", "timeout"],
    ["outcome_unknown", "unknown", "unknown"],
  ] as const)("accepts the exact terminal pair %s/%s", (outcome, reason, errorType) => {
    expect(isActionAttemptTerminalConsistent({
      admittedAt,
      terminalAt,
      durationMs: 1_000,
      outcome,
      reason,
      errorType,
    })).toBe(true);
  });

  it.each([
    ["ok", "upstream_failure"],
    ["error", "completed"],
    ["denied", "timeout"],
    ["outcome_unknown", "application_failure"],
  ] as const)("rejects the contradictory terminal pair %s/%s", (outcome, reason) => {
    expect(isActionAttemptTerminalConsistent({
      admittedAt,
      terminalAt,
      durationMs: 1_000,
      outcome,
      reason,
    })).toBe(false);
  });

  it("rejects bad timestamps, duration drift, and invalid error types", () => {
    const valid = {
      admittedAt,
      terminalAt,
      durationMs: 1_000,
      outcome: "error" as const,
      reason: "application_failure" as const,
      errorType: "application_failure",
    };
    expect(isActionAttemptTerminalConsistent({ ...valid, admittedAt: "not-a-time" })).toBe(false);
    expect(isActionAttemptTerminalConsistent({ ...valid, terminalAt: "not-a-time" })).toBe(false);
    expect(isActionAttemptTerminalConsistent({ ...valid, terminalAt: admittedAt })).toBe(false);
    expect(isActionAttemptTerminalConsistent({ ...valid, durationMs: Number.NaN })).toBe(false);
    expect(isActionAttemptTerminalConsistent({ ...valid, durationMs: -1 })).toBe(false);
    expect(isActionAttemptTerminalConsistent({ ...valid, durationMs: 999 })).toBe(false);
    expect(isActionAttemptTerminalConsistent({ ...valid, errorType: "" })).toBe(false);
    expect(isActionAttemptTerminalConsistent({ ...valid, errorType: "Uppercase" })).toBe(false);
    expect(isActionAttemptTerminalConsistent({ ...valid, errorType: "x".repeat(65) })).toBe(false);
    for (const errorType of [null, true, false, 123, ["x"], Symbol("x")]) {
      // @ts-expect-error Deliberate malformed RPC/row fixture for runtime validation.
      expect(isActionAttemptTerminalConsistent({ ...valid, errorType })).toBe(false);
    }
    // @ts-expect-error Deliberate malformed RPC/row fixture for runtime validation.
    expect(isActionAttemptTerminalConsistent({ ...valid, terminalAt: new Date(terminalAt) })).toBe(false);
    // @ts-expect-error Deliberate malformed RPC/row fixture for runtime validation.
    expect(isActionAttemptTerminalConsistent({ ...valid, admittedAt: 0 })).toBe(false);
    expect(isActionAttemptTerminalConsistent({
      ...valid,
      outcome: "ok",
      reason: "completed",
      errorType: "unexpected",
    })).toBe(false);
  });

  it("accepts an immediate terminal with an exact zero duration", () => {
    expect(isActionAttemptTerminalConsistent({
      admittedAt,
      terminalAt: admittedAt,
      durationMs: 0,
      outcome: "cancelled",
      reason: "cancelled",
    })).toBe(true);
  });

  it("keeps build and publish denominators separate and excludes the terminal grace tail", () => {
    const result = summarizeDurableActionReliability({
      read: read([
        attempt("build-ok", "build", end - 2 * HOUR, "ok"),
        attempt("build-error", "build", end - 90 * 60_000, "error"),
        attempt("build-missing", "build", end - HOUR),
        attempt("build-in-grace", "build", end - 5 * 60_000, "ok"),
        attempt("publish-ok", "publish", end - HOUR, "ok"),
      ]),
      action: "build",
      windowStartMs: end - 24 * HOUR,
      windowEndMs: end,
      terminalGraceMinutes: 15,
    });
    expect(result).toEqual({
      action: "build",
      eligibleAdmissions: 3,
      successfulActions: 1,
      coveredActions: 2,
      successBasisPoints: 3_333,
      coverageBasisPoints: 6_667,
    });
  });

  it("rejects duplicate IDs, route drift, and partial or contradictory terminals", () => {
    const valid = attempt("same", "publish", end - HOUR, "ok");
    const base = {
      action: "publish" as const,
      windowStartMs: end - 24 * HOUR,
      windowEndMs: end,
      terminalGraceMinutes: 15,
    };
    expect(() => summarizeDurableActionReliability({ ...base, read: read([valid, valid]) }))
      .toThrow("duplicate durable action attempt id");
    expect(() => summarizeDurableActionReliability({
      ...base,
      read: read([{ ...valid, route: "/unclassified" }]),
    })).toThrow("durable action route is not recognized");
    expect(() => summarizeDurableActionReliability({
      ...base,
      read: read([{ ...valid, admittedAt: "2026-07-13" }]),
    })).toThrow("durable action admission time is invalid");
    const malformedAdmission: DurableActionAttempt = {
      ...valid,
      // @ts-expect-error Deliberate corrupt-row fixture for runtime validation.
      admittedAt: 0,
    };
    expect(() => summarizeDurableActionReliability({
      ...base,
      read: read([malformedAdmission]),
    })).toThrow("durable action admission time is invalid");
    expect(() => summarizeDurableActionReliability({
      ...base,
      read: read([{ ...valid, outcome: undefined }]),
    })).toThrow("durable action terminal must be atomic");
    expect(() => summarizeDurableActionReliability({
      ...base,
      read: read([{
        ...valid,
        terminalAt: undefined,
        outcome: undefined,
        reason: undefined,
        durationMs: undefined,
        errorType: "orphan_error",
      }]),
    })).toThrow("durable action terminal must be atomic");
    expect(() => summarizeDurableActionReliability({
      ...base,
      read: read([{ ...valid, durationMs: 999 }]),
    })).toThrow("durable action terminal is contradictory");
    expect(() => summarizeDurableActionReliability({
      ...base,
      read: read([{ ...valid, errorType: "Uppercase" }]),
    })).toThrow("durable action terminal is contradictory");
    const malformedOutcome: DurableActionAttempt = {
      ...valid,
      // @ts-expect-error Deliberate corrupt-row fixture for runtime validation.
      outcome: "__proto__",
    };
    expect(() => summarizeDurableActionReliability({
      ...base,
      read: read([malformedOutcome]),
    })).toThrow("durable action terminal is contradictory");
  });
});

import { describe, expect, it } from "vitest";
import {
  ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION,
  ACTION_ATTEMPT_RETENTION_HOURS,
  ACTION_ATTEMPT_SCHEMA_VERSION,
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
      read: read([{ ...valid, outcome: undefined }]),
    })).toThrow("durable action terminal must be atomic");
    expect(() => summarizeDurableActionReliability({
      ...base,
      read: read([{ ...valid, durationMs: 999 }]),
    })).toThrow("durable action terminal is contradictory");
  });
});

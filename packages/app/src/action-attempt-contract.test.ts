import { describe, expect, it } from "vitest";
import {
  isActionAttemptTerminalConsistent,
} from "./lib/observability/action-attempt";

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

});

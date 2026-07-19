import { describe, it, expect } from "vitest";
import { TEST_SUBJECTS } from "@cuny-ai-lab/cail-identity/testing";
import {
  decideClaim,
  decideMarkComplete,
  type ClaimRecord
} from "./migration-claim";

const FIXED = () => "2026-07-04T00:00:00.000Z";

describe("decideClaim (SS-3 pure decision)", () => {
  const SUBJECT = TEST_SUBJECTS.alice;
  const OTHER = TEST_SUBJECTS.bob;

  it("no record → GRANT (fresh), stores a pending record for the subject", () => {
    const { decision, newRecord } = decideClaim(null, SUBJECT, FIXED);
    expect(decision).toEqual({ granted: true, resume: false, claimedBy: null });
    expect(newRecord).toEqual({
      subject: SUBJECT,
      status: "pending",
      startedAt: "2026-07-04T00:00:00.000Z"
    });
  });

  it("treats undefined the same as a missing record (fresh grant)", () => {
    const { decision } = decideClaim(undefined, SUBJECT, FIXED);
    expect(decision.granted).toBe(true);
    expect(decision.resume).toBe(false);
  });

  it("same subject → GRANT + resume, and never rewrites the record", () => {
    const existing: ClaimRecord = {
      subject: SUBJECT,
      status: "pending",
      startedAt: "2026-01-01T00:00:00.000Z"
    };
    const { decision, newRecord } = decideClaim(existing, SUBJECT, FIXED);
    expect(decision).toEqual({ granted: true, resume: true, claimedBy: SUBJECT });
    // Resume must not disturb the stored record (preserve startedAt/status).
    expect(newRecord).toBeNull();
  });

  it("same subject on a COMPLETE record still resumes (idempotent), no rewrite", () => {
    const existing: ClaimRecord = {
      subject: SUBJECT,
      status: "complete",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z"
    };
    const { decision, newRecord } = decideClaim(existing, SUBJECT, FIXED);
    expect(decision.granted).toBe(true);
    expect(newRecord).toBeNull();
  });

  it("different subject → REFUSE, reports claimedBy, never mutates the record", () => {
    const existing: ClaimRecord = {
      subject: OTHER,
      status: "pending",
      startedAt: "2026-01-01T00:00:00.000Z"
    };
    const { decision, newRecord } = decideClaim(existing, SUBJECT, FIXED);
    expect(decision).toEqual({ granted: false, resume: false, claimedBy: OTHER });
    expect(newRecord).toBeNull();
  });
});

describe("decideMarkComplete", () => {
  const SUBJECT = TEST_SUBJECTS.alice;

  it("flips the owning subject's pending record to complete with a timestamp", () => {
    const record: ClaimRecord = {
      subject: SUBJECT,
      status: "pending",
      startedAt: "2026-01-01T00:00:00.000Z"
    };
    const updated = decideMarkComplete(record, SUBJECT, FIXED);
    expect(updated).toEqual({
      subject: SUBJECT,
      status: "complete",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-07-04T00:00:00.000Z"
    });
  });

  it("is a no-op (null) when the record is missing", () => {
    expect(decideMarkComplete(null, SUBJECT, FIXED)).toBeNull();
  });

  it("is a no-op (null) when a different subject tries to complete", () => {
    const record: ClaimRecord = {
      subject: TEST_SUBJECTS.carol,
      status: "pending",
      startedAt: "2026-01-01T00:00:00.000Z"
    };
    expect(decideMarkComplete(record, SUBJECT, FIXED)).toBeNull();
  });

  it("is a no-op (null) when already complete", () => {
    const record: ClaimRecord = {
      subject: SUBJECT,
      status: "complete",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z"
    };
    expect(decideMarkComplete(record, SUBJECT, FIXED)).toBeNull();
  });
});

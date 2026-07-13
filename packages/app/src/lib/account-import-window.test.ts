import { describe, expect, it } from "vitest";
import {
  AccountImportConfigurationError,
  MAX_ACCOUNT_IMPORT_DURATION_MS,
  resolveAccountImportWindow,
} from "./account-import-window";

const START = "2026-07-13T12:00:00.000Z";

function expectConfigError(
  env: Parameters<typeof resolveAccountImportWindow>[0],
  code: AccountImportConfigurationError["code"]
): void {
  try {
    resolveAccountImportWindow(env);
    throw new Error("Expected configuration error");
  } catch (error) {
    expect(error).toBeInstanceOf(AccountImportConfigurationError);
    expect((error as AccountImportConfigurationError).code).toBe(code);
  }
}

describe("resolveAccountImportWindow", () => {
  it("accepts ISO instants with explicit offsets and classifies the half-open window", () => {
    const env = {
      CAIL_SSO_SWITCHED_AT: "2026-07-13T08:00:00-04:00",
      CAIL_ACCOUNT_IMPORT_UNTIL: "2026-07-20T12:00:00.000Z",
    };

    expect(resolveAccountImportWindow(env, Date.parse(START)).state).toBe("open");
    expect(resolveAccountImportWindow(env, Date.parse("2026-07-13T11:59:59.999Z")).state).toBe(
      "not_started"
    );
    expect(resolveAccountImportWindow(env, Date.parse(env.CAIL_ACCOUNT_IMPORT_UNTIL)).state).toBe(
      "expired"
    );
  });

  it("accepts an exactly 30-day duration", () => {
    const end = new Date(Date.parse(START) + MAX_ACCOUNT_IMPORT_DURATION_MS).toISOString();
    expect(
      resolveAccountImportWindow(
        { CAIL_SSO_SWITCHED_AT: START, CAIL_ACCOUNT_IMPORT_UNTIL: end },
        Date.parse(START)
      ).state
    ).toBe("open");
  });

  it("rejects missing or non-instant bounds", () => {
    expectConfigError({}, "account_import_config_missing");
    expectConfigError(
      { CAIL_SSO_SWITCHED_AT: "2026-07-13", CAIL_ACCOUNT_IMPORT_UNTIL: START },
      "account_import_switched_at_invalid"
    );
    expectConfigError(
      { CAIL_SSO_SWITCHED_AT: START, CAIL_ACCOUNT_IMPORT_UNTIL: "2026-07-14T12:00:00" },
      "account_import_until_invalid"
    );
  });

  it("rejects an end before the start", () => {
    expectConfigError(
      {
        CAIL_SSO_SWITCHED_AT: START,
        CAIL_ACCOUNT_IMPORT_UNTIL: "2026-07-13T11:59:59.999Z",
      },
      "account_import_range_invalid"
    );
  });

  it("rejects a duration longer than 30 days", () => {
    const end = new Date(Date.parse(START) + MAX_ACCOUNT_IMPORT_DURATION_MS + 1).toISOString();
    expectConfigError(
      { CAIL_SSO_SWITCHED_AT: START, CAIL_ACCOUNT_IMPORT_UNTIL: end },
      "account_import_duration_exceeded"
    );
  });
});

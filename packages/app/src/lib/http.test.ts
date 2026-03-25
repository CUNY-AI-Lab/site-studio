import { describe, it, expect } from "vitest";
import { jsonError, jsonHeaders, binaryBody } from "./http";

describe("jsonError", () => {
  it("throws HTTPException with default status 400", () => {
    expect(() => jsonError("Bad request")).toThrow();
    try {
      jsonError("Bad request");
    } catch (error: any) {
      expect(error.status).toBe(400);
      expect(error.message).toBe("Bad request");
    }
  });

  it("throws HTTPException with custom status", () => {
    try {
      jsonError("Not found", 404);
    } catch (error: any) {
      expect(error.status).toBe(404);
      expect(error.message).toBe("Not found");
    }
  });

  it("return type is never (prevents code continuation)", () => {
    // This is a compile-time check - if jsonError doesn't return `never`,
    // TypeScript would error on unreachable code after it
    const fn = (): string => {
      jsonError("fail");
    };
    expect(() => fn()).toThrow();
  });
});

describe("jsonHeaders", () => {
  it("sets Content-Type to application/json by default", () => {
    const headers = jsonHeaders();
    expect(headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  it("does not overwrite existing Content-Type", () => {
    const headers = jsonHeaders({ "Content-Type": "text/plain" });
    expect(headers.get("Content-Type")).toBe("text/plain");
  });

  it("preserves extra headers", () => {
    const headers = jsonHeaders({ "X-Custom": "value" });
    expect(headers.get("X-Custom")).toBe("value");
    expect(headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });
});

describe("binaryBody", () => {
  it("returns a Blob from Uint8Array", () => {
    const data = new Uint8Array([1, 2, 3]);
    const blob = binaryBody(data);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(3);
  });

  it("returns empty Blob for empty input", () => {
    const blob = binaryBody(new Uint8Array([]));
    expect(blob.size).toBe(0);
  });
});

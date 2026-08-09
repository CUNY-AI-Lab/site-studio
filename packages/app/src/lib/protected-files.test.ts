import { describe, expect, it } from "vitest";
import { isProtectedServedPath } from "./protected-files";

describe("isProtectedServedPath", () => {
  it("protects bookkeeping files by final path segment", () => {
    expect(isProtectedServedPath(".metadata.json")).toBe(true);
    expect(isProtectedServedPath("foo/.metadata.json")).toBe(true);
    expect(isProtectedServedPath("/.thumbnail.png")).toBe(true);
  });

  it("allows ordinary files and similarly named path segments", () => {
    expect(isProtectedServedPath("")).toBe(false);
    expect(isProtectedServedPath("///")).toBe(false);
    expect(isProtectedServedPath("index.html")).toBe(false);
    expect(isProtectedServedPath(".well-known/security.txt")).toBe(false);
    expect(isProtectedServedPath("about/.well-known/x")).toBe(false);
  });
});

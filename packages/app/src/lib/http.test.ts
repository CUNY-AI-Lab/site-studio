import { describe, it, expect } from "vitest";
import { jsonError, jsonHeaders, binaryBody, readFormData } from "./http";

describe("jsonError", () => {
  it.each([undefined, 404] as const)("preserves the status and message for %s", (status) => {
    expect(() => jsonError("Request failed", status)).toThrowError(
      expect.objectContaining({ status: status ?? 400, message: "Request failed" })
    );
  });
});

describe("readFormData", () => {
  it("preserves the uploaded file name and bytes", async () => {
    const bytes = new Uint8Array([0, 17, 128, 255]);
    const body = new FormData();
    body.append("file", new File([bytes], "example.png"));
    const parsed = await readFormData(new Request("https://site-studio.test/upload", { method: "POST", body }));
    const file = parsed.get("file");
    if (!(file instanceof File)) throw new Error("Uploaded file is missing");
    expect(file.name).toBe("example.png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("returns a client error for malformed form framing", async () => {
    const request = new Request("https://site-studio.test/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=missing" },
      body: "invalid framing",
    });
    await expect(readFormData(request)).rejects.toMatchObject({ status: 400, message: "Invalid multipart form data" });
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
  it("preserves binary response bytes", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const blob = binaryBody(data);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
  });

  it("returns empty Blob for empty input", () => {
    const blob = binaryBody(new Uint8Array([]));
    expect(blob.size).toBe(0);
  });
});

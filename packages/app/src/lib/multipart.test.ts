import { describe, expect, it } from "vitest";
import { readBoundedFormData } from "./multipart";

function multipartRequest(body: string, contentLength?: string): Request {
  const headers = new Headers({ "content-type": "multipart/form-data; boundary=test" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("https://site-studio.test/upload", { method: "POST", headers, body });
}

describe("readBoundedFormData", () => {
  it("rejects actual streamed bytes when Content-Length understates the body", async () => {
    const request = multipartRequest("--test\r\ncontent-disposition: form-data; name=\"value\"\r\n\r\noversized\r\n--test--\r\n", "1");

    await expect(readBoundedFormData(request, 16, "too large")).rejects.toMatchObject({ status: 413 });
  });

  it("parses a valid multipart body below the absolute ceiling", async () => {
    const body = "--test\r\ncontent-disposition: form-data; name=\"value\"\r\n\r\nok\r\n--test--\r\n";
    const form = await readBoundedFormData(multipartRequest(body), body.length, "too large");

    expect(form.get("value")).toBe("ok");
  });

  it("reports malformed multipart framing as a client error", async () => {
    const request = multipartRequest("not multipart framing");
    await expect(readBoundedFormData(request, 100, "too large")).rejects.toMatchObject({ status: 400 });
  });
});

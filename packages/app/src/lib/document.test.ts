import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("unpdf", () => ({
  extractText: vi.fn(),
  getMeta: vi.fn()
}));

import { extractText, getMeta } from "unpdf";
import { extractDocumentText, supportsDocumentExtraction } from "./document";

describe("document extraction", () => {
  const mockedExtractText = vi.mocked(extractText);
  const mockedGetMeta = vi.mocked(getMeta);

  beforeEach(() => {
    mockedExtractText.mockReset();
    mockedGetMeta.mockReset();
  });

  it("marks PDFs as supported for extraction", () => {
    expect(supportsDocumentExtraction("paper.pdf")).toBe(true);
    expect(supportsDocumentExtraction("notes.md")).toBe(false);
  });

  it("extracts text and metadata from PDFs", async () => {
    mockedExtractText.mockResolvedValue({
      totalPages: 2,
      text: ["Abstract text", "Methods text"]
    } as never);
    mockedGetMeta.mockResolvedValue({
      info: {
        Title: "Research Paper",
        Author: "Ada Lovelace"
      },
      metadata: {}
    } as never);

    const result = await extractDocumentText("paper.pdf", new Uint8Array([1, 2, 3]));

    expect(result.pageCount).toBe(2);
    expect(result.title).toBe("Research Paper");
    expect(result.author).toBe("Ada Lovelace");
    expect(result.text).toContain("Page 1\nAbstract text");
    expect(result.text).toContain("Page 2\nMethods text");
    expect(result.warnings).toEqual([]);
  });

  it("warns when the PDF has no extractable text", async () => {
    mockedExtractText.mockResolvedValue({
      totalPages: 1,
      text: [""]
    } as never);
    mockedGetMeta.mockResolvedValue({
      info: {},
      metadata: {}
    } as never);

    const result = await extractDocumentText("scan.pdf", new Uint8Array([1, 2, 3]));

    expect(result.text).toContain("[no extractable text]");
    expect(result.warnings).toEqual([
      "No extractable text was found in the PDF. It may be scanned or image-based."
    ]);
  });

  it("rejects unsupported document types", async () => {
    await expect(
      extractDocumentText("document.docx", new Uint8Array([1, 2, 3]))
    ).rejects.toThrow("Only PDF files are supported right now.");
  });
});

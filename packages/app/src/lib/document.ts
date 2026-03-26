import { extractText, getMeta } from "unpdf";
import { getContentType } from "./path";

export type ExtractedDocumentText = {
  contentType: string;
  pageCount: number;
  text: string;
  title?: string;
  author?: string;
  warnings: string[];
};

function readMetadataString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatPdfPages(pages: string[]): { text: string; warnings: string[] } {
  const normalized = pages.map((page) => page.replace(/\u0000/g, "").trim());
  const warnings: string[] = [];
  const hasVisibleText = normalized.some((page) => page.length > 0);

  if (!hasVisibleText) {
    warnings.push("No extractable text was found in the PDF. It may be scanned or image-based.");
  }

  const text = normalized
    .map((page, index) => {
      const label = `Page ${index + 1}`;
      return page.length > 0 ? `${label}\n${page}` : `${label}\n[no extractable text]`;
    })
    .join("\n\n");

  return { text, warnings };
}

export function supportsDocumentExtraction(filePath: string): boolean {
  return getContentType(filePath) === "application/pdf";
}

export async function extractDocumentText(
  filePath: string,
  data: Uint8Array
): Promise<ExtractedDocumentText> {
  const contentType = getContentType(filePath);

  if (contentType !== "application/pdf") {
    throw new Error(`Document extraction is not supported for ${contentType}. Only PDF files are supported right now.`);
  }

  const [{ totalPages, text }, meta] = await Promise.all([
    extractText(data, { mergePages: false }),
    getMeta(data).catch(() => null)
  ]);

  const pages = Array.isArray(text) ? text : [text];
  const formatted = formatPdfPages(pages);
  const info = meta?.info as Record<string, unknown> | undefined;
  const metadata = meta?.metadata as Record<string, unknown> | undefined;

  return {
    contentType,
    pageCount: totalPages,
    text: formatted.text,
    title: readMetadataString(info?.Title) || readMetadataString(metadata?.Title),
    author: readMetadataString(info?.Author) || readMetadataString(metadata?.Author),
    warnings: formatted.warnings
  };
}

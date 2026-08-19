import { extractText, getMeta } from "unpdf";
import { z } from "zod";
import { getContentType } from "./path";

type PdfExtractionResult = { totalPages: number; text: string[] };
type PdfMetadata = {
  info: { Title?: string; Author?: string };
  metadata: { Title?: string; Author?: string };
};
export type DocumentExtractor = {
  extractText(data: Uint8Array, options: { mergePages: false }): Promise<PdfExtractionResult>;
  getMeta(data: Uint8Array): Promise<PdfMetadata>;
};

const pdfMetadataSchema = z.object({
  Title: z.string().optional(),
  Author: z.string().optional(),
});
const defaultDocumentExtractor: DocumentExtractor = {
  extractText: (data, options) => extractText(data, options),
  getMeta: async (data) => {
    const meta = await getMeta(data);
    const info = pdfMetadataSchema.safeParse(meta.info);
    const metadata = pdfMetadataSchema.safeParse(meta.metadata);
    return {
      info: info.success ? info.data : {},
      metadata: metadata.success ? metadata.data : {},
    };
  },
};

export type ExtractedDocumentText = {
  contentType: string;
  pageCount: number;
  text: string;
  title?: string;
  author?: string;
  warnings: string[];
};

function readMetadataString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type FormattedPdfPages = {
  text: string;
  warnings: string[];
};

function formatPdfPages(pages: string[]): FormattedPdfPages {
  const nullCharacter = String.fromCodePoint(0);
  const normalized = pages.map((page) => page.split(nullCharacter).join("").trim());
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
  data: Uint8Array,
  extractor: DocumentExtractor = defaultDocumentExtractor,
): Promise<ExtractedDocumentText> {
  const contentType = getContentType(filePath);

  if (contentType !== "application/pdf") {
    throw new Error(`Document extraction is not supported for ${contentType}. Only PDF files are supported right now.`);
  }

  const [{ totalPages, text }, meta] = await Promise.all([
    extractor.extractText(data, { mergePages: false }),
    extractor.getMeta(data).catch(() => null)
  ]);

  const pages = Array.isArray(text) ? text : [text];
  const formatted = formatPdfPages(pages);
  const info = pdfMetadataSchema.safeParse(meta?.info);
  const metadata = pdfMetadataSchema.safeParse(meta?.metadata);

  return {
    contentType,
    pageCount: totalPages,
    text: formatted.text,
    title: readMetadataString(info.success ? info.data.Title : undefined)
      || readMetadataString(metadata.success ? metadata.data.Title : undefined),
    author: readMetadataString(info.success ? info.data.Author : undefined)
      || readMetadataString(metadata.success ? metadata.data.Author : undefined),
    warnings: formatted.warnings
  };
}

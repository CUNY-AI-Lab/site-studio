import { describe, it, expect } from "vitest";
import {
  IMAGE_EXTENSIONS,
  imageTypeForExtension,
  isImageExtension,
  sniffImageType
} from "./image-validation";

/** Build a Uint8Array from a list of byte values, padded with zeros to `len`. */
function bytes(signature: number[], len = signature.length): Uint8Array {
  const arr = new Uint8Array(len);
  arr.set(signature);
  return arr;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF89A = Array.from("GIF89a", (c) => c.charCodeAt(0));
const GIF87A = Array.from("GIF87a", (c) => c.charCodeAt(0));
const WEBP = [
  ...Array.from("RIFF", (c) => c.charCodeAt(0)),
  0x00, 0x00, 0x00, 0x00,
  ...Array.from("WEBP", (c) => c.charCodeAt(0))
];

describe("sniffImageType", () => {
  it("detects png", () => {
    expect(sniffImageType(bytes(PNG, 16))).toBe("png");
  });

  it("detects jpeg", () => {
    expect(sniffImageType(bytes(JPEG, 16))).toBe("jpeg");
  });

  it("detects gif (both 87a and 89a)", () => {
    expect(sniffImageType(bytes(GIF87A, 16))).toBe("gif");
    expect(sniffImageType(bytes(GIF89A, 16))).toBe("gif");
  });

  it("detects webp via the RIFF/WEBP container", () => {
    expect(sniffImageType(bytes(WEBP, 32))).toBe("webp");
  });

  it("returns null for RIFF that is not WEBP (e.g. a WAV)", () => {
    const wav = [
      ...Array.from("RIFF", (c) => c.charCodeAt(0)),
      0x00, 0x00, 0x00, 0x00,
      ...Array.from("WAVE", (c) => c.charCodeAt(0))
    ];
    expect(sniffImageType(bytes(wav, 32))).toBeNull();
  });

  it("returns null for non-image bytes (e.g. HTML)", () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><html></html>");
    expect(sniffImageType(html)).toBeNull();
  });

  it("returns null for empty or too-short input without throwing", () => {
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("imageTypeForExtension", () => {
  it("maps jpg and jpeg to the jpeg family", () => {
    expect(imageTypeForExtension(".jpg")).toBe("jpeg");
    expect(imageTypeForExtension(".jpeg")).toBe("jpeg");
  });

  it("maps png/gif/webp to their own families", () => {
    expect(imageTypeForExtension(".png")).toBe("png");
    expect(imageTypeForExtension(".gif")).toBe("gif");
    expect(imageTypeForExtension(".webp")).toBe("webp");
  });

  it("returns null for non-image extensions", () => {
    expect(imageTypeForExtension(".pdf")).toBeNull();
    expect(imageTypeForExtension("")).toBeNull();
  });
});

describe("isImageExtension / IMAGE_EXTENSIONS", () => {
  it("recognizes every accepted image extension", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp"]) {
      expect(isImageExtension(ext)).toBe(true);
      expect(IMAGE_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it("rejects non-image extensions", () => {
    expect(isImageExtension(".pdf")).toBe(false);
    expect(isImageExtension(".txt")).toBe(false);
  });
});

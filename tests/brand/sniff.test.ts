// What a file really is, from its bytes (never its name or the type a client claims), and a font's family name.
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { fontFamilyName, sniffType } from "../../src/brand/sniff.js";
import { tinyFont } from "./helpers.js";

describe("sniffType", () => {
  it("recognises images by their first bytes", async () => {
    const mk = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } });
    expect(sniffType(await mk().png().toBuffer())).toBe("png");
    expect(sniffType(await mk().jpeg().toBuffer())).toBe("jpeg");
    expect(sniffType(await mk().webp().toBuffer())).toBe("webp");
  });
  it("recognises svg text, pdf and fonts, and refuses to guess", () => {
    expect(sniffType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("svg");
    expect(sniffType(Buffer.from("  <svg viewBox='0 0 1 1'></svg>"))).toBe("svg");
    expect(sniffType(Buffer.from("%PDF-1.7\n..."))).toBe("pdf");
    expect(sniffType(tinyFont("Acme", "ttf"))).toBe("ttf");
    expect(sniffType(tinyFont("Acme", "otf"))).toBe("otf");
    expect(sniffType(Buffer.from("wOFF....."))).toBe("woff");
    expect(sniffType(Buffer.from("wOF2....."))).toBe("woff2");
    expect(sniffType(Buffer.from("MZ\x90\0 an exe"))).toBe("unknown");
    expect(sniffType(Buffer.from("<html><script>alert(1)</script>"))).toBe("unknown");
    expect(sniffType(Buffer.alloc(0))).toBe("unknown");
  });
});

describe("fontFamilyName", () => {
  it("reads the family from the name table", () => {
    expect(fontFamilyName(tinyFont("Fraunces 9pt"))).toBe("Fraunces 9pt");
    expect(fontFamilyName(tinyFont("Inter", "otf"))).toBe("Inter");
  });
  it("is null for something that is not a font", () => {
    expect(fontFamilyName(Buffer.from("nope"))).toBeNull();
    expect(fontFamilyName(Buffer.alloc(0))).toBeNull();
  });
});

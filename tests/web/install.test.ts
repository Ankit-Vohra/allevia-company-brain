// The web app installs like an app (web/public/manifest.webmanifest, web/index.html): Allevia's name, the warm colours,
// standalone, real icons of the sizes it says, and the tags iOS reads for Add to Home Screen. No push notifications.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const web = (p: string) => new URL(`../../web/${p}`, import.meta.url);
const pngSize = (buf: Buffer) => ({ png: buf.subarray(1, 4).toString("ascii") === "PNG", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

describe("installable app", () => {
  const manifest = JSON.parse(readFileSync(web("public/manifest.webmanifest"), "utf8")) as Record<string, unknown> & { icons: Array<{ src: string; sizes: string; type: string }> };
  const html = readFileSync(web("index.html"), "utf8");

  it("has a manifest named Allevia, standalone, in the warm theme", () => {
    expect(manifest).toMatchObject({ name: "Allevia", short_name: "Allevia", start_url: "/", scope: "/", display: "standalone", background_color: "#f4eee3", theme_color: "#f4eee3" });
    expect(JSON.stringify(manifest)).not.toMatch(/gcm_sender_id|push/i);
  });

  it("lists icons that exist, as PNGs of the sizes it says", () => {
    expect(manifest.icons.map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
    for (const i of manifest.icons) {
      const s = pngSize(readFileSync(web(`public${i.src}`)));
      expect(s.png, i.src).toBe(true);
      expect(`${s.w}x${s.h}`).toBe(i.sizes);
    }
    expect(pngSize(readFileSync(web("public/apple-touch-icon.png")))).toEqual({ png: true, w: 180, h: 180 });
  });

  it("links the manifest and the iOS add-to-home-screen tags", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Allevia" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toContain('<meta name="theme-color" content="#f4eee3" />');
    expect(html).toContain("#2f2621"); // the night office's status bar
  });
});

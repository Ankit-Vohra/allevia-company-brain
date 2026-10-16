// The public address a platform fetches a picture from: signed, one file of one business, running out, and the same 404 for
// everything else.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { MEDIA_TTL_MS, publicAddressProblem, registerMediaRoute, signMediaUrl, verifyMediaToken } from "../../src/publish/media.js";
import { AssetStore } from "../../src/studio/store.js";
import { testGraph } from "../helpers/graph.js";

const KEY = "test-connector-key-0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-10-16T10:00:00Z");
const tokenOf = (url: string): string => url.split("/m/")[1]!;

let g: GraphHandle;
let cleanup: () => Promise<void>;
let dir: string;
let store: AssetStore;
let png: Buffer;

beforeAll(async () => {
  ({ g, cleanup } = await testGraph());
  dir = mkdtempSync(join(tmpdir(), "allevia-media-"));
  store = new AssetStore(dir);
  png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } } }).png().toBuffer();
  const key = store.put("cafe", "a".repeat(64), png, "png");
  await upsertNode(g, { type: "Asset", id: "asset:poster-1", name: "Poster", props: { kind: "poster", mime: "image/png", storageKey: key } }, NOW);
});
afterAll(async () => { await cleanup(); rmSync(dir, { recursive: true, force: true }); await closeAll(); });

const app = (over: { now?: number; key?: string } = {}) => {
  const a = new Hono();
  registerMediaRoute(a, async () => ({ key: over.key ?? KEY, store, openGraph: async () => g, now: () => over.now ?? NOW }));
  return a;
};

describe("signed media addresses", () => {
  const signer = { key: KEY, base: "https://allevia.example/", now: () => NOW };

  it("names one file of one business and runs out in an hour", () => {
    const url = signMediaUrl(signer, { tenant: "cafe", assetId: "asset:poster-1" });
    expect(url).toMatch(/^https:\/\/allevia\.example\/m\/[\w-]+\.[\w-]+$/);
    expect(verifyMediaToken(KEY, tokenOf(url), NOW)).toEqual({ tenant: "cafe", assetId: "asset:poster-1" });
    expect(verifyMediaToken(KEY, tokenOf(url), NOW + MEDIA_TTL_MS - 1)).not.toBeNull();
    expect(verifyMediaToken(KEY, tokenOf(url), NOW + MEDIA_TTL_MS + 1)).toBeNull();
  });

  it("cannot be changed, moved to another business, or opened with another key", () => {
    const tok = tokenOf(signMediaUrl(signer, { tenant: "cafe", assetId: "asset:poster-1" }));
    const [body, sig] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "media", t: "rival", a: "asset:poster-1", e: NOW + 1e9 })).toString("base64url");
    expect(verifyMediaToken(KEY, `${forged}.${sig}`, NOW)).toBeNull();
    expect(verifyMediaToken(KEY, `${body}.${sig!.slice(0, -2)}xx`, NOW)).toBeNull();
    expect(verifyMediaToken("another-connector-key-0123456789abcdef0123456789", tok, NOW)).toBeNull();
    expect(verifyMediaToken(KEY, "garbage", NOW)).toBeNull();
  });

  it("is not a sign-in link: those tokens do not open a file", () => {
    // the same signing key makes OAuth states and /c links; they carry another kind and never open media
    const oauthLike = signMediaUrl(signer, { tenant: "cafe", assetId: "x" }).replace(/m\/.*/, "");
    expect(oauthLike).toBe("https://allevia.example/");
    expect(verifyMediaToken(KEY, "e30.e30", NOW)).toBeNull();
  });

  it("says why a local address can't be used", () => {
    expect(publicAddressProblem("https://allevia.example")).toBeNull();
    expect(publicAddressProblem("http://203.0.113.7:8787")).toBeNull();
    for (const local of ["http://127.0.0.1:8787", "http://localhost:8787", "http://192.168.1.4", "http://10.0.0.2", "http://mac.local", "http://172.20.1.1"]) {
      expect(publicAddressProblem(local), local).toMatch(/can only be reached from inside its own network/);
    }
    expect(publicAddressProblem("nonsense")).toMatch(/isn't an address/);
  });
});

describe("GET /m/:token", () => {
  const signer = { key: KEY, base: "https://allevia.example", now: () => NOW };
  const get = (a: Hono, url: string) => a.request(`/m/${tokenOf(url)}`);

  it("serves the file with its own type", async () => {
    const r = await get(app(), signMediaUrl(signer, { tenant: "cafe", assetId: "asset:poster-1" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await r.arrayBuffer()).equals(png)).toBe(true);
  });

  it("serves a PNG as a JPEG when the platform only takes JPEG", async () => {
    const r = await get(app(), signMediaUrl(signer, { tenant: "cafe", assetId: "asset:poster-1", as: "jpeg" }));
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    const bytes = Buffer.from(await r.arrayBuffer());
    expect((await sharp(bytes).metadata()).format).toBe("jpeg");
  });

  it("answers 404, and only 404, to an expired address, another business's file, a missing asset and a forged token", async () => {
    const url = signMediaUrl(signer, { tenant: "cafe", assetId: "asset:poster-1" });
    expect((await get(app({ now: NOW + MEDIA_TTL_MS + 5 }), url)).status).toBe(404);
    expect((await get(app(), signMediaUrl(signer, { tenant: "rival", assetId: "asset:poster-1" }))).status).toBe(404); // rival's folder has no such file
    expect((await get(app(), signMediaUrl(signer, { tenant: "cafe", assetId: "asset:nope" }))).status).toBe(404);
    expect((await app().request("/m/not.valid")).status).toBe(404);
    expect((await get(app({ key: "x".repeat(40) }), url)).status).toBe(404);
  });
});

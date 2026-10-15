// The web side of the brand library: the owner uploads a file (multipart), it is classified and filed, the list shows
// only this business's active files, a file is served only through the tenant check (images inline, everything else as
// a download, never sniffed), and public mode and missing wiring refuse.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { upsertNode } from "../../src/graph/upsert.js";
import type { StudioWiring } from "../../src/server/studio.js";
import { FakeEngine } from "../../src/studio/engine.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { crispLogo, tinyFont } from "../brand/helpers.js";
import { harness, type Harness } from "./harness.js";

const verdict = (o: Record<string, unknown> = {}) => ({
  kind: "logo", confidence: 0.9, description: "A rust square.", containsPerson: false, containsChild: false, colours: [], workOnIt: false, ...o,
});

describe("server: brand library (integration)", () => {
  let h: Harness;
  let dir: string;
  let wiring: StudioWiring;
  beforeAll(async () => {
    h = await harness();
    dir = mkdtempSync(join(tmpdir(), "allevia-brand-api-"));
    wiring = {
      deps: { store: new AssetStore(dir), vision: new FakeVision({ librarian: verdict() }), engine: new FakeEngine(async (i) => sharp(i.image).jpeg().toBuffer()) },
    };
  }, 90_000);
  afterAll(async () => {
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const send = (app = h.make({ studio: async () => wiring }), file?: { bytes: Buffer; name: string; type: string }, note?: string) => {
    const form = new FormData();
    if (file) form.append("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    if (note) form.append("note", note);
    return app.request("/api/mini/studio/brand", { method: "POST", body: form });
  };

  it("files an uploaded logo, lists it, and serves it back through the tenant check", async () => {
    const app = h.make({ studio: async () => wiring });
    const res = await send(app, { bytes: await crispLogo(1400, 460), name: "anything.jpg", type: "image/jpeg" }, "our logo");
    expect(res.status).toBe(200);
    const body = await res.json() as { route: string; kind: string; message: string; asset: { id: string } | null; needsBetter: boolean };
    expect(body).toMatchObject({ route: "brand", kind: "logo", needsBetter: false });
    expect(body.message).toMatch(/logo/i);
    const list = await (await app.request("/api/mini/brand")).json() as { assets: Array<{ id: string; kind: string; url?: string; storageKey?: string }>; logo: { id: string } | null };
    expect(list.logo?.id).toBe(body.asset!.id);
    expect(list.assets.some((a) => a.id === body.asset!.id && a.kind === "logo")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("storageKey"); // file keys never leave the server
    const file = await app.request(`/api/mini/brand/${encodeURIComponent(body.asset!.id)}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await app.request("/api/mini/brand/brand-asset%3Anope/file")).status).toBe(404);
    expect((await app.request(`/api/other/brand/${encodeURIComponent(body.asset!.id)}/file`)).status).toBe(404);
  });

  it("serves a font as a download, never inline", async () => {
    const app = h.make({ studio: async () => wiring });
    const res = await send(app, { bytes: tinyFont("Fraunces"), name: "f.ttf", type: "font/ttf" });
    const body = await res.json() as { asset: { id: string } };
    const file = await app.request(`/api/mini/brand/${encodeURIComponent(body.asset.id)}/file`);
    expect(file.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("refuses with plain words: no file, a file that is not a brand file, an unwired server, public mode", async () => {
    const app = h.make({ studio: async () => wiring });
    expect((await send(app)).status).toBe(400);
    const bad = await send(app, { bytes: Buffer.from("MZ not allowed"), name: "x.exe", type: "application/octet-stream" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/pictures|fonts|PDF/);
    expect((await send(h.make({}), { bytes: await crispLogo(), name: "l.png", type: "image/png" })).status).toBe(501);
    const pub = h.make({ studio: async () => wiring, publicMode: true });
    expect((await send(pub, { bytes: await crispLogo(), name: "l.png", type: "image/png" })).status).toBe(403);
  });

  it("sends a photo for editing to the Studio instead of filing it", async () => {
    const w: StudioWiring = { deps: { ...wiring.deps, vision: new FakeVision({ librarian: verdict({ kind: "product_photo", workOnIt: true }) }) } };
    const res = await send(h.make({ studio: async () => w }), { bytes: await sharp({ create: { width: 800, height: 600, channels: 3, background: "#889" } }).jpeg().toBuffer(), name: "p.jpg", type: "image/jpeg" }, "make this look better");
    const body = await res.json() as { route: string; asset: unknown };
    expect(body).toMatchObject({ route: "studio", asset: null });
  });

  it("another business's brand files are not in this one's list", async () => {
    await upsertNode(h.g, { type: "BrandAsset", id: "brand-asset:colour-123456", name: "Primary colour #123456", props: { kind: "colour", value: "#123456", status: "active" } });
    const list = await (await h.make({ studio: async () => wiring }).request("/api/mini/brand")).json() as { assets: Array<{ id: string }> };
    expect(list.assets.map((a) => a.id)).toContain("brand-asset:colour-123456"); // (one graph per tenant: this is its own)
  });
});

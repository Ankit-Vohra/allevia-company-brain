// "Here's my logo" on Discord: a picture, an SVG, a font or a brand guide dropped in #studio or attached in #your-team is
// filed in the brand library (not run through the Studio as a photo), with a plain answer and a preview; a product photo
// still goes on to the Studio; the download rules still hold; and a hub business only ever files into its own graph.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { MessagePort, Outgoing, PostedPort, ThreadPort } from "../../src/discord/bot.js";
import { HubBot } from "../../src/discord/hub-bot.js";
import { StudioDiscord, StudioGate } from "../../src/discord/studio-bot.js";
import type { AttachmentRef, FetchFn } from "../../src/discord/attachments.js";
import { activeLogo, listBrandAssets } from "../../src/brand/library.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { FakeEngine } from "../../src/studio/engine.js";
import type { Ffmpeg } from "../../src/studio/video.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { testGraph } from "../helpers/graph.js";
import { snowflake } from "../helpers/hub-fakes.js";
import { crispLogo, svgLogo, tinyFont } from "../brand/helpers.js";
import { BIZ, DEV_ANSWER, facadePhoto, NOW, seedBrand, TARA_ANSWER } from "../studio/fixtures.js";

const CDN = "https://cdn.discordapp.com/attachments/1/2";
const text = (m: Outgoing): string => (typeof m === "string" ? m : m.content);
const verdict = (o: Record<string, unknown> = {}) => ({
  kind: "logo", confidence: 0.9, description: "A rust square with bars.", containsPerson: false, containsChild: false, colours: [], workOnIt: false, ...o,
});

class FakePosted implements PostedPort {
  id = snowflake();
  edits: Outgoing[] = [];
  constructor(public first: Outgoing) {}
  async edit(m: Outgoing) { this.edits.push(m); }
  get now(): Outgoing { return this.edits.at(-1) ?? this.first; }
}
class FakeThread implements ThreadPort {
  sent: FakePosted[] = [];
  constructor(public id: string, public name: string) {}
  async send(m: Outgoing) { const p = new FakePosted(m); this.sent.push(p); return p; }
  texts() { return this.sent.map((p) => text(p.now)); }
}

const file = (name: string, contentType: string): AttachmentRef => ({ url: `${CDN}/${name}`, name, size: 5000, contentType });
function message(content: string, files: AttachmentRef[]): MessagePort & { started: FakeThread[] } {
  const started: FakeThread[] = [];
  return {
    id: snowflake(), guildId: "g", channelId: "studio-channel", threadParentId: null, authorId: "u", authorIsBot: false, authorIsOwner: true, system: false,
    content, files, attachments: files.length, memberRoleIds: [], thread: () => null,
    async startThread(name) { const t = new FakeThread(snowflake(), name); started.push(t); return t; },
    async reply() {}, started,
  };
}

describe("brand files on Discord", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;
  let vision: FakeVision;
  let studio: StudioDiscord;
  const bodies = new Map<string, { type: string; body: Buffer }>();
  const fetched: string[] = [];

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await seedBrand(g);
    dir = mkdtempSync(join(tmpdir(), "allevia-brand-bot-"));
    store = new AssetStore(dir);
    let answer: unknown = verdict();
    vision = new FakeVision({ librarian: () => answer, "content-strategist": TARA_ANSWER, "fact-checker": (i: { images: Array<{ label: string }> }) => ({ variants: i.images.filter((x) => !["original", "frame"].includes(x.label)).map((x) => ({ label: x.label, sameBuilding: true, structuralChange: false, added: [], removed: [], note: "nothing added" })) }), "copy-editor": DEV_ANSWER });
    (globalThis as { __answer?: (a: unknown) => void }).__answer = (a) => { answer = a; };
    bodies.set("logo.jpg", { type: "image/jpeg", body: await sharp(await crispLogo(1400, 450)).flatten({ background: "#fff" }).jpeg().toBuffer() });
    bodies.set("logo.svg", { type: "image/svg+xml", body: Buffer.from(svgLogo()) });
    bodies.set("Fraunces.ttf", { type: "application/octet-stream", body: tinyFont("Fraunces") });
    bodies.set("guide.pdf", { type: "application/pdf", body: Buffer.from("%PDF-1.7\n%%EOF") });
    bodies.set("house.jpg", { type: "image/jpeg", body: await facadePhoto({ tilt: 3 }) });
    const fetchFn: FetchFn = async (url) => {
      fetched.push(url);
      const f = bodies.get(url.split("/").pop()!);
      return f ? new Response(new Uint8Array(f.body), { headers: { "content-type": f.type } }) : new Response("no", { status: 404 });
    };
    const ffmpeg: Ffmpeg = { available: async () => false, firstFrame: async () => null, stripMetadata: async (b) => b };
    studio = new StudioDiscord({
      tenant: "kestrel_oak", businessId: BIZ, graph: g, brandLibrary: true, gate: new StudioGate(), fetch: fetchFn, ffmpeg, workLogIntervalMs: 0, log: () => {},
      studio: { store, vision, engine: new FakeEngine(async (i) => sharp(i.image).jpeg().toBuffer()) }, now: (() => { let t = NOW; return () => (t += 1000); })(),
    });
  }, 60_000);
  afterAll(async () => {
    await cleanup();
    await closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const say = (a: unknown) => (globalThis as unknown as { __answer: (a: unknown) => void }).__answer(a);

  it("'here's my logo' in #studio files the logo, shows what was kept, and does not run the Studio on it", async () => {
    say(verdict({ kind: "logo" }));
    const m = message("here's my logo", [file("logo.jpg", "image/jpeg")]);
    expect(studio.hasMedia(m)).toBe(true);
    await studio.onMedia(m);
    const t = m.started[0]!;
    const said = t.texts().join("\n");
    expect(said).toMatch(/Got your logo/);
    expect(said).not.toMatch(/Miss Influencer looked|Work log/); // the Studio did not run
    const first = t.sent[0]!.first as Exclude<Outgoing, string>;
    expect(first.files).toHaveLength(1); // a preview of what was kept
    expect((await activeLogo(g))?.origin).toBe("upload");
    expect(vision.calls.map((c) => c.agent)).toEqual(["librarian"]);
  });

  it("an SVG, a font and a brand guide are filed whatever Discord calls them", async () => {
    say(verdict({ kind: "logo" }));
    const m = message("", [file("logo.svg", "image/svg+xml"), file("Fraunces.ttf", "application/octet-stream"), file("guide.pdf", "application/pdf")]);
    await studio.onMedia(m);
    const said = m.started[0]!.texts().join("\n");
    expect(said).toMatch(/Got your logo/);
    expect(said).toMatch(/Got your font, Fraunces/);
    expect(said).toMatch(/brand guide/i);
    const kinds = (await listBrandAssets(g)).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["logo", "font", "guide"]));
  });

  it("a product photo still goes to the Studio, and the library keeps nothing of it", async () => {
    say(verdict({ kind: "product_photo" }));
    const before = (await listBrandAssets(g, { kinds: ["product-photo"] })).length;
    const m = message("Harbour House from the street", [file("house.jpg", "image/jpeg")]);
    await studio.onMedia(m);
    expect(m.started[0]!.texts().join("\n")).toMatch(/Miss Influencer looked at your photo/);
    expect((await listBrandAssets(g, { kinds: ["product-photo"] })).length).toBe(before);
  });

  it("falls back to the Studio when the librarian cannot look (the model is busy)", async () => {
    say(() => { throw new Error("unused"); });
    const flaky = new StudioDiscord({
      tenant: "kestrel_oak", businessId: BIZ, graph: g, brandLibrary: true, gate: new StudioGate(), log: () => {}, workLogIntervalMs: 0,
      fetch: async () => new Response(new Uint8Array(bodies.get("house.jpg")!.body), { headers: { "content-type": "image/jpeg" } }),
      ffmpeg: { available: async () => false, firstFrame: async () => null, stripMetadata: async (b) => b },
      studio: { store, vision: new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": (i: { images: Array<{ label: string }> }) => ({ variants: i.images.filter((x) => !["original", "frame"].includes(x.label)).map((x) => ({ label: x.label, sameBuilding: true, structuralChange: false, added: [], removed: [], note: "ok" })) }), "copy-editor": DEV_ANSWER }), engine: new FakeEngine(async (i) => sharp(i.image).jpeg().toBuffer()) },
      now: (() => { let t = NOW + 10_000_000; return () => (t += 1000); })(),
    });
    const m = message("the front", [file("house.jpg", "image/jpeg")]);
    await flaky.onMedia(m);
    expect(m.started[0]!.texts().join("\n")).toMatch(/Miss Influencer looked at your photo/);
  });

  it("says why when a file is refused, and does not file a child's picture", async () => {
    say(verdict({ kind: "past_design", containsChild: true }));
    const before = (await listBrandAssets(g)).length;
    const m = message("our old flyer", [file("logo.jpg", "image/jpeg")]);
    await studio.onMedia(m);
    expect(m.started[0]!.texts().join("\n")).toMatch(/shows a child/);
    expect((await listBrandAssets(g)).length).toBe(before);
  });

  it("without the library switched on, a PDF is left alone as before", async () => {
    const plain = new StudioDiscord({
      tenant: "kestrel_oak", businessId: BIZ, graph: g, gate: new StudioGate(), log: () => {}, fetch: async () => new Response("x"),
      ffmpeg: { available: async () => false, firstFrame: async () => null, stripMetadata: async (b) => b }, studio: { store, vision, engine: new FakeEngine(async (i) => i.image) },
    });
    expect(plain.hasMedia(message("", [file("guide.pdf", "application/pdf")]))).toBe(false);
  });
});

// the hub: a business's #studio and #your-team reach only its own library (the same resolve() rule as photos)
describe("hub routing of brand files", () => {
  it("hands a file to the Studio of the channel's own business and no other", async () => {
    const seen: string[] = [];
    const mk = (slug: string): StudioDiscord => ({ hasMedia: () => true, onMedia: async () => { seen.push(slug); }, onReply: async () => {}, onButton: async () => true }) as unknown as StudioDiscord;
    const areas = new Map([["c-a", "alpha"], ["c-b", "beta"]]);
    const hub = new HubBot({
      guildId: "g", staffRoleId: "staff", log: () => {},
      store: {
        channel: async (_g: string, id: string) => (areas.has(id) ? { guildId: "g", slug: areas.get(id)!, kind: "studio" } : null),
        getArea: async (slug: string) => ({ slug, guildId: "g", roleId: `role-${slug}`, businessName: slug, channels: { studio: slug === "alpha" ? "c-a" : "c-b", "your-team": "x" }, status: "ready" }),
        getHub: async () => null,
      } as never,
      hub: {} as never, botFor: async () => ({}) as never, studioFor: async (a) => mk(a.slug),
    });
    const m = message("", [file("logo.svg", "image/svg+xml")]);
    await hub.onMessage({ ...m, channelId: "c-a", memberRoleIds: ["role-alpha"] });
    await hub.onMessage({ ...m, channelId: "c-b", memberRoleIds: ["role-alpha"] }); // alpha's member in beta's channel: ignored
    await hub.onMessage({ ...m, channelId: "c-b", memberRoleIds: ["role-beta"] });
    expect(seen).toEqual(["alpha", "beta"]);
  });
});

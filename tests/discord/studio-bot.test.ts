// The Studio on Discord, end to end on fake Discord ports: photos and videos dropped in #studio (or attached in #your-team)
// run the Studio flow in a thread, the options come back as image attachments with Approve / Change, an approval is the
// same decision as the web's, a text reply makes the next option, the download rules hold, and a business can only ever
// reach its own Studio. Fake vision, fake engine, fake fetch: no credits, no network.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AskInput, AskResult } from "../../src/agent/ask.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { AlleviaBot, type ButtonPort, type MessagePort, type Outgoing, type PostedPort, type ThreadPort } from "../../src/discord/bot.js";
import { HubBot } from "../../src/discord/hub-bot.js";
import { provisionCustomer, type ProvisionDeps } from "../../src/discord/hub-provision.js";
import { StudioDiscord, StudioGate, studioButtonId } from "../../src/discord/studio-bot.js";
import type { AreaRecord } from "../../src/discord/hub-types.js";
import type { AttachmentRef, FetchFn } from "../../src/discord/attachments.js";
import { FakeEngine } from "../../src/studio/engine.js";
import { loadStudioSettings } from "../../src/studio/settings.js";
import { loadLanguagePreference } from "../../src/agent/language.js";
import type { Ffmpeg } from "../../src/studio/video.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { FakeHub, MemoryHubStore, snowflake } from "../helpers/hub-fakes.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, DEV_ANSWER, facadePhoto, NOW, seedBrand, TARA_ANSWER } from "../studio/fixtures.js";

const CDN = "https://cdn.discordapp.com/attachments/1/2";
const text = (m: Outgoing): string => (typeof m === "string" ? m : m.content);
const ALL_OK = { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true };

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
  options() { return this.sent.filter((p) => typeof p.first !== "string" && p.first.files?.length); }
}

const A_NISHA = { variants: [
  { label: "A", sameBuilding: true, structuralChange: false, added: [], removed: [], note: "straightened; nothing added" },
  { label: "B", sameBuilding: true, structuralChange: false, added: [], removed: [], note: "relit; nothing added" },
] };

// Nisha passes whichever variants she is shown (the labels are on the images she is given)
const nishaFor = (input: { images: Array<{ label: string }> }) => ({
  variants: input.images.filter((i) => !["original", "frame"].includes(i.label)).map((i) => ({ label: i.label, sameBuilding: true, structuralChange: false, added: [], removed: [], note: "nothing added" })),
});

interface World {
  g: GraphHandle; cleanup: () => Promise<void>; dir: string; store: AssetStore; vision: FakeVision; studio: StudioDiscord;
  fetched: string[]; photo: Buffer; ffmpeg: { available: boolean; frame: Buffer | null };
}

async function world(slug: string, tilt = 5): Promise<World> {
  const { g, cleanup } = await testGraph();
  await seedBrand(g);
  const dir = mkdtempSync(join(tmpdir(), "allevia-studio-bot-"));
  const store = new AssetStore(dir);
  const photo = await facadePhoto({ tilt });
  const vision = new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": nishaFor, "copy-editor": DEV_ANSWER });
  const engine = new FakeEngine(async (input) => sharp(input.image).modulate({ brightness: 1.05 }).jpeg().toBuffer());
  const fetched: string[] = [];
  const w = { ffmpeg: { available: false, frame: null as Buffer | null } };
  const ffmpeg: Ffmpeg = { available: async () => w.ffmpeg.available, firstFrame: async () => w.ffmpeg.frame, stripMetadata: async (b) => Buffer.concat([b, Buffer.from("-clean")]) };
  const fetch: FetchFn = async (url) => {
    fetched.push(url);
    if (url.includes("/photo")) return new Response(new Uint8Array(photo), { headers: { "content-type": "image/jpeg" } });
    if (url.includes("/clip")) return new Response(new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(40, 9)])), { headers: { "content-type": "video/mp4" } });
    if (url.includes("/fake.png")) return new Response(new Uint8Array(Buffer.from("this is text, not a picture at all")), { headers: { "content-type": "image/png" } });
    return new Response("nope", { status: 404 });
  };
  const studio = new StudioDiscord({
    tenant: slug, businessId: BIZ, graph: g, studio: { store, vision, engine }, ffmpeg, gate: new StudioGate(), fetch,
    workLogIntervalMs: 0, now: (() => { let t = NOW; return () => (t += 1000); })(), log: () => {},
  });
  return { g, cleanup: async () => { await cleanup(); rmSync(dir, { recursive: true, force: true }); }, dir, store, vision, studio, fetched, photo, ffmpeg: w.ffmpeg };
}

const file = (name: string, o: Partial<AttachmentRef> = {}): AttachmentRef => ({ url: `${CDN}/${name}`, name, size: 5000, contentType: name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".png") ? "image/png" : "image/jpeg", ...o });

function message(content: string, files: AttachmentRef[], o: { thread?: FakeThread; parent?: string } = {}): MessagePort & { started: FakeThread[]; replies: string[] } {
  const started: FakeThread[] = [];
  const replies: string[] = [];
  return {
    id: snowflake(), guildId: "g", channelId: o.thread?.id ?? "studio-channel", threadParentId: o.thread ? (o.parent ?? "studio-channel") : null, authorId: "u", authorIsBot: false,
    authorIsOwner: true, system: false, content, files, attachments: files.length, memberRoleIds: [],
    thread: () => o.thread ?? null,
    async startThread(name) { const t = new FakeThread(snowflake(), name); started.push(t); return t; },
    async reply(m) { replies.push(text(m)); }, started, replies,
  };
}

function press(customId: string, o: Partial<ButtonPort> = {}): ButtonPort & { replies: Array<{ text: string; ephemeral: boolean }>; updates: Outgoing[] } {
  const b = {
    customId, guildId: "g", userId: "u", isOwner: true, replies: [] as Array<{ text: string; ephemeral: boolean }>, updates: [] as Outgoing[],
    async reply(t: string, opts?: { ephemeral?: boolean }) { b.replies.push({ text: t, ephemeral: !!opts?.ephemeral }); },
    async update(m: Outgoing) { b.updates.push(m); }, ...o,
  };
  return b as never;
}

describe("photos in the Studio on Discord", () => {
  let w: World;
  let thread: FakeThread;
  let approvalId: string;
  beforeAll(async () => { w = await world("kestrel_oak"); });
  afterAll(async () => { await w.cleanup(); await closeAll(); });

  it("a photo with a note opens a thread, runs the Studio, and posts each option as an image with a caption and buttons", async () => {
    const m = message("Harbour House from the street", [file("photo.jpg")]);
    await w.studio.onMedia(m);
    expect(w.fetched).toEqual([`${CDN}/photo.jpg`]);
    expect(m.started).toHaveLength(1);
    thread = m.started[0]!;
    expect(thread.name).toBe("Harbour House from the street");

    const [log, tara, ...rest] = thread.sent;
    expect(text(log!.first)).toMatch(/^\*\*Work log\*\*/);
    expect(log!.edits.length).toBeGreaterThan(0); // one message, edited as the team worked
    expect(text(tara!.first)).toMatch(/^Tara looked at your photo: it needs a little polish\./);
    expect(text(tara!.first)).not.toMatch(/blurred/); // a person is kept as they are unless the business asked for blurring
    expect(text(tara!.first)).not.toMatch(/verdict|overlay|asset|graph/i);

    const options = thread.options();
    expect(options).toHaveLength(2);
    for (const o of options) {
      const first = o.first as Exclude<Outgoing, string>;
      expect(first.files).toHaveLength(1);
      const meta = await sharp(first.files![0]!.data).metadata();
      expect({ format: meta.format, w: meta.width, h: meta.height }).toEqual({ format: "jpeg", w: 1080, h: 1350 });
      expect(first.content).toContain("Checked:");
      expect(first.content).toMatch(/> /); // the caption, quoted
      expect(first.content).not.toMatch(/like a promise|Book now/i); // Dev's voice check ran: no hard sell
      expect(first.buttons!.map((b) => b.label)).toEqual(["Approve", "Change"]);
    }
    const ids = (options[0]!.first as Exclude<Outgoing, string>).buttons!.map((b) => b.customId);
    approvalId = ids[0]!.replace(/^allevia:studio:approve:/, "").replace(/:A$/, "");
    expect(ids).toEqual([studioButtonId("approve", approvalId, "A"), studioButtonId("change", approvalId, "A")]);
    expect(ids.every((id) => id.length <= 100)).toBe(true); // Discord's custom_id limit
    expect(text(rest.at(-1)!.first)).toMatch(/Approving uses 1 Studio credit/);
  });

  it("what is stored has no EXIF or location, and the original is in the graph with the thread it lives in", async () => {
    const [a] = await w.g.roQuery<{ key: string; stripped: boolean; tid: string; media: string; approval: string }>(
      "MATCH (a:Asset) WHERE a.kind = 'original' AND a.mediaType = 'image' RETURN a.storageKey AS key, a.metadataStripped AS stripped, a.discordThreadId AS tid, a.mediaType AS media, a.approvalId AS approval LIMIT 1");
    expect(a).toMatchObject({ stripped: true, tid: thread.id, approval: approvalId });
    const stored = w.store.get("kestrel_oak", a!.key)!;
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect(JSON.stringify(await w.g.roQuery("MATCH (a:Asset) RETURN properties(a) AS p"))).not.toMatch(/GPS|51\/1|TestCam/);
    // nobody's Discord name or id was written anywhere
    expect(JSON.stringify(await w.g.roQuery("MATCH (n) RETURN properties(n) AS p LIMIT 500"))).not.toContain('"u"');
  });

  it("only the team can press, Change tells how to ask for a change, and Approve is the web's own decision", async () => {
    const stranger = press(studioButtonId("approve", approvalId, "A"), { isOwner: false });
    expect(await w.studio.onButton(stranger)).toBe(true);
    expect(stranger.replies[0]).toMatchObject({ ephemeral: true, text: expect.stringMatching(/Only people on this business's team/) });

    const change = press(studioButtonId("change", approvalId, "A"));
    await w.studio.onButton(change);
    expect(change.replies[0]!.text).toContain("make it warmer");
    expect(change.replies[0]!.ephemeral).toBe(true);
    expect(await w.studio.onButton(press("allevia:approve:approval:x"))).toBe(false); // not a Studio button: someone else's

    // a text reply makes the next option, with its own Approve button
    const reply = message("make it warmer", [], { thread });
    await w.studio.onReply(reply, thread);
    const made = thread.options().at(-1)!.first as Exclude<Outgoing, string>;
    expect(made.content).toContain("**Option C**: warmer");
    expect(made.content).toMatch(/our pick/);
    expect(made.buttons![0]!.customId).toBe(studioButtonId("approve", approvalId, "C"));
    expect(made.files).toHaveLength(1);
    // what it cannot do is said plainly, and nothing is made
    const before = thread.options().length;
    await w.studio.onReply(message("remove the bin on the left", [], { thread }), thread);
    expect(thread.texts().at(-1)).toMatch(/Changing what is in the photo is not something the team can do yet/);
    expect(thread.options()).toHaveLength(before);
    // a reply in a thread with no photo
    const lone = new FakeThread(snowflake(), "lone");
    await w.studio.onReply(message("make it warmer", [], { thread: lone }), lone);
    expect(lone.texts()).toEqual(["Drop a photo here and your team will make post options from it."]);

    // approve the adjusted option
    const ok = press(studioButtonId("approve", approvalId, "C"));
    await w.studio.onButton(ok);
    expect(text(ok.updates[0]!)).toMatch(/✅ You approved option C\. It is saved as a draft post\. Nothing has been published\./);
    expect((ok.updates[0] as Exclude<Outgoing, string>).buttons).toEqual([]);
    const [c] = await w.g.roQuery<{ id: string; status: string; fmt: string }>("MATCH (c:Content)-[:USES_ASSET]->(v:Asset {label:'C'}) RETURN c.id AS id, c.status AS status, c.format AS fmt");
    expect(c).toMatchObject({ status: "draft", fmt: "post" });
    const [v] = await w.g.roQuery<{ status: string; step: string }>("MATCH (v:Asset {label:'C'}) RETURN v.status AS status, v.step AS step");
    expect(v).toEqual({ status: "approved", step: "revision" });
    const lineage = await w.g.roQuery<{ p: string }>("MATCH (:Asset {label:'C'})-[:DERIVED_FROM]->(p:Asset) RETURN p.kind AS p");
    expect(lineage.map((l) => l.p).sort()).toEqual(["original", "variant"]);
    const [ap] = await w.g.roQuery<{ s: string }>("MATCH (a:Approval {id:$id}) RETURN a.status AS s", { id: approvalId });
    expect(ap!.s).toMatch(/approved|executed/);

    // deciding it twice, or approving another option afterwards, changes nothing
    const again = press(studioButtonId("approve", approvalId, "A"));
    await w.studio.onButton(again);
    expect(again.replies[0]).toMatchObject({ ephemeral: true, text: expect.stringMatching(/already decided/) });
    const late = message("cooler", [], { thread });
    await w.studio.onReply(late, thread);
    expect(thread.texts().at(-1)).toMatch(/already decided/);
  });
});

describe("the download rules hold", () => {
  let w: World;
  beforeEach(async () => { w = await world("kestrel_oak"); });
  afterAll(async () => { await closeAll(); });

  it("a file that is not on Discord's own hosts is never fetched and never reaches the team", async () => {
    const m = message("look", [file("photo.jpg", { url: "https://evil.example/photo.jpg" }), file("photo2.jpg", { url: "https://cdn.discordapp.com.evil.example/photo.jpg" })]);
    await w.studio.onMedia(m);
    expect(w.fetched).toEqual([]);
    expect(w.vision.calls).toEqual([]);
    expect(m.started[0]!.texts().filter((t) => /uploaded to Discord itself/.test(t))).toHaveLength(2);
    await w.cleanup();
  });

  it("takes at most four, says so, leaves other kinds of file alone, and refuses a photo that is not one", async () => {
    const files = [...Array.from({ length: 6 }, (_, i) => file(`photo${i}.jpg`)), file("report.pdf", { contentType: "application/pdf" })];
    // only fetch+reject: make the downloads fail fast so this test only looks at the rules
    const m = message("batch", files);
    (w.studio as unknown as { d: { fetch: FetchFn } }).d.fetch = async (url) => { w.fetched.push(url); return new Response("x", { status: 404 }); };
    await w.studio.onMedia(m);
    expect(w.fetched).toHaveLength(4);
    const t = m.started[0]!.texts();
    expect(t.some((x) => /first 4 files and leave the other 2/.test(x))).toBe(true);
    expect(t.some((x) => /One file was not a photo or a video/.test(x))).toBe(true);

    const w2 = await world("kestrel_oak");
    const fake = message("x", [file("fake.png")]);
    await w2.studio.onMedia(fake);
    expect(fake.started[0]!.texts().join("\n")).toMatch(/not an image we can read/);
    expect(w2.vision.calls).toEqual([]);
    await w2.cleanup();
    await w.cleanup();
  });

  it("an oversize photo is refused before anything is downloaded", async () => {
    const m = message("big", [file("photo.jpg", { size: 11 * 1024 * 1024 })]);
    await w.studio.onMedia(m);
    expect(w.fetched).toEqual([]);
    expect(m.started[0]!.texts().join("\n")).toMatch(/too large: send one under 10 MB/);
    await w.cleanup();
  });
});

describe("videos", () => {
  it("without ffmpeg: kept, and said honestly in plain words; nothing is looked at", async () => {
    const w = await world("kestrel_oak");
    const m = message("walk-through", [file("clip.mp4")]);
    await w.studio.onMedia(m);
    expect(w.vision.calls).toEqual([]);
    const said = m.started[0]!.texts().join("\n");
    expect(said).toMatch(/I saved your video with your other media/);
    expect(said).toMatch(/can't look inside videos on this server yet/);
    expect(said).toMatch(/can't edit video today/);
    const [a] = await w.g.roQuery<{ media: string; key: string }>("MATCH (a:Asset) WHERE a.mediaType = 'video' RETURN a.mediaType AS media, a.storageKey AS key");
    expect(a!.media).toBe("video");
    expect(w.store.get("kestrel_oak", a!.key)).not.toBeNull();
    await w.cleanup();
  });

  it("with ffmpeg: the details are stripped, Tara looks at the first frame, and the limits are still stated", async () => {
    const w = await world("kestrel_oak");
    w.ffmpeg.available = true;
    w.ffmpeg.frame = await facadePhoto({ gps: false });
    const m = message("", [file("clip.mp4")]);
    await w.studio.onMedia(m);
    const said = m.started[0]!.texts().join("\n");
    expect(said).toMatch(/removed the location and device details/);
    expect(said).toMatch(/Tara looked at its first frame: it needs a little polish/);
    expect(said).toMatch(/can't edit or restyle video yet/);
    expect(w.vision.calls.map((c) => c.agent)).toEqual(["content-strategist"]); // one look at one frame, no variants
    const [a] = await w.g.roQuery<{ v: string }>("MATCH (a:Asset) WHERE a.mediaType = 'video' RETURN a.verdict AS v");
    expect(a!.v).toBe("enhance");
    await w.cleanup();
  });
});

describe("one Studio run at a time", () => {
  it("a second photo waits its turn and is told so", async () => {
    const w = await world("kestrel_oak");
    let active = 0;
    let overlap = false;
    const slow = new FakeVision({
      "content-strategist": async () => { active++; overlap ||= active > 1; await new Promise((r) => setTimeout(r, 40)); active--; return TARA_ANSWER; },
      "fact-checker": A_NISHA, "copy-editor": DEV_ANSWER,
    } as never);
    const studio = new StudioDiscord({ ...(w.studio as unknown as { d: ConstructorParameters<typeof StudioDiscord>[0] }).d, studio: { ...(w.studio as unknown as { d: { studio: object } }).d.studio, vision: slow } as never });
    const one = message("one", [file("photo.jpg")]);
    const two = message("two", [file("photo.jpg")]);
    await Promise.all([studio.onMedia(one), studio.onMedia(two)]);
    expect(overlap).toBe(false);
    expect([...one.started[0]!.texts(), ...two.started[0]!.texts()].some((t) => /working on another photo\. Yours is next/.test(t))).toBe(true);
    expect(one.started[0]!.options().length + two.started[0]!.options().length).toBe(4);
    await w.cleanup();
  });
});

describe("through the hub: a business reaches only its own Studio", () => {
  let hub: FakeHub;
  let store: MemoryHubStore;
  let staff: string;
  let A: AreaRecord;
  let B: AreaRecord;
  let wa: World;
  let wb: World;
  let bot: HubBot;
  let asked: AskInput[];

  beforeAll(async () => {
    wa = await world("aamdani");
    wb = await world("avs_atelier", 2); // a different photo: ids come from the photo's content
    hub = new FakeHub();
    store = new MemoryHubStore();
    staff = hub.addRole("Allevia staff", 10).id;
    const deps: ProvisionDeps = { hub, store, staffRoleId: staff, tenant: async (s) => ({ name: s === "aamdani" ? "Aamdani" : "AVS Atelier" }), log: () => {} };
    A = (await provisionCustomer("aamdani", deps)).area;
    B = (await provisionCustomer("avs_atelier", deps)).area;
  });
  afterAll(async () => { await wa.cleanup(); await wb.cleanup(); await closeAll(); });

  beforeEach(() => {
    asked = [];
    const studios: Record<string, StudioDiscord> = { aamdani: wa.studio, avs_atelier: wb.studio };
    bot = new HubBot({
      guildId: hub.guildId, staffRoleId: staff, store, hub, log: () => {},
      botFor: (area) => new AlleviaBot({
        tenant: area.slug, guildId: hub.guildId, channelId: area.channels["your-team"]!, webBase: "http://127.0.0.1:8787", graph: area.slug === "aamdani" ? wa.g : wb.g,
        ask: async (input): Promise<AskResult> => { asked.push(input); return { ok: true, turnId: "t", sessionId: input.sessionId ?? "s", answer: "ok", citations: [], checks: ALL_OK, agents: [], ms: 1 }; },
        workLogIntervalMs: 0, log: () => {},
      }),
      studioFor: (area) => studios[area.slug],
    });
    wa.fetched.length = 0;
    wb.fetched.length = 0;
  });

  const msg = (content: string, files: AttachmentRef[], where: string, roles: string[], thread?: FakeThread, parent?: string) => {
    const m = message(content, files, thread ? { thread, parent: parent ?? where } : {});
    return Object.assign(m, { guildId: hub.guildId, channelId: thread?.id ?? where, memberRoleIds: roles });
  };
  const count = async (g: GraphHandle) => (await g.roQuery<{ n: number }>("MATCH (a:Asset) WHERE a.kind = 'original' RETURN count(a) AS n"))[0]!.n;

  it("a photo in A's #studio runs in A's graph only; B's graph is untouched", async () => {
    const m = msg("the harbour", [file("photo.jpg")], A.channels.studio!, [A.roleId!]);
    const [beforeA, beforeB] = [await count(wa.g), await count(wb.g)];
    await bot.onMessage(m);
    expect(m.started).toHaveLength(1);
    expect(m.started[0]!.options()).toHaveLength(2);
    expect(await count(wa.g)).toBe(beforeA + 1);
    expect(await count(wb.g)).toBe(beforeB);
    expect(wb.fetched).toEqual([]);
  });

  it("a photo attached in #your-team goes to the Studio; plain text there is still a question", async () => {
    const m = msg("", [file("photo.jpg")], A.channels["your-team"]!, [A.roleId!]);
    await bot.onMessage(m);
    expect(m.started[0]!.options()).toHaveLength(2);
    expect(asked).toEqual([]);
    await bot.onMessage(msg("How did we do this week?", [], A.channels["your-team"]!, [A.roleId!]));
    expect(asked.map((a) => a.tenant)).toEqual(["aamdani"]);
  });

  it("someone else's role, the staff role, or a channel we do not know: nothing is fetched or run", async () => {
    const before = [await count(wa.g), await count(wb.g)];
    for (const m of [
      msg("x", [file("photo.jpg")], A.channels.studio!, [B.roleId!]),
      msg("x", [file("photo.jpg")], A.channels.studio!, [staff]),
      msg("x", [file("photo.jpg")], A.channels.studio!, []),
      msg("x", [file("photo.jpg")], B.channels.studio!, [A.roleId!]),
      msg("x", [file("photo.jpg")], snowflake(), [A.roleId!, B.roleId!]),
      msg("x", [file("photo.jpg")], A.channels.approvals!, [A.roleId!]),
      msg("x", [file("photo.jpg")], A.channels.support!, [A.roleId!]),
    ]) {
      await bot.onMessage(m);
      expect(m.started).toEqual([]);
    }
    expect(wa.fetched).toEqual([]);
    expect(wb.fetched).toEqual([]);
    expect([await count(wa.g), await count(wb.g)]).toEqual(before);
  });

  it("text in #studio gets a hint, and a reply under a photo makes the next option for that business", async () => {
    const hint = msg("hello?", [], A.channels.studio!, [A.roleId!]);
    await bot.onMessage(hint);
    expect(hint.replies[0]).toMatch(/Drop a photo or a video here/);
    const m = msg("the harbour again", [file("photo.jpg")], A.channels.studio!, [A.roleId!]);
    await bot.onMessage(m);
    const t = m.started[0]!;
    const before = t.options().length;
    await bot.onMessage(msg("make it a bit cooler", [], A.channels.studio!, [A.roleId!], t));
    expect(t.options()).toHaveLength(before + 1);
    expect((t.options().at(-1)!.first as Exclude<Outgoing, string>).content).toContain("cooler");
  });

  it("'blur faces from now on' in #studio sets A's setting only, a reply in a thread turns it off, and nothing is asked per photo", async () => {
    const on = msg("Blur faces from now on", [], A.channels.studio!, [A.roleId!]);
    await bot.onMessage(on);
    expect(on.replies[0]).toMatch(/From now on I will blur people's faces/);
    expect(await loadStudioSettings(wa.g, BIZ)).toEqual({ blurFaces: true });
    expect(await loadStudioSettings(wb.g, BIZ)).toEqual({ blurFaces: false });
    // the next photo says so, plainly, and has no question or buttons about people
    const m = msg("with the setting on", [file("photo.jpg")], A.channels.studio!, [A.roleId!]);
    await bot.onMessage(m);
    const t = m.started[0]!;
    expect(t.texts().join("\n")).toContain("Faces are blurred in the options, because your setting blurs people's faces.");
    expect(t.texts().join("\n")).not.toMatch(/Is it you|Keep them|Blur them/);
    const off = msg("stop blurring faces", [], A.channels.studio!, [A.roleId!], t);
    await bot.onMessage(off);
    expect(t.texts().at(-1)).toMatch(/faces will be kept as they are/i);
    expect(await loadStudioSettings(wa.g, BIZ)).toEqual({ blurFaces: false });
    // someone from B cannot change A's setting
    const stranger = msg("blur faces from now on", [], A.channels.studio!, [B.roleId!]);
    await bot.onMessage(stranger);
    expect(stranger.replies).toEqual([]);
    expect(await loadStudioSettings(wa.g, BIZ)).toEqual({ blurFaces: false });
  });

  it("'always answer in English' in #your-team sets A's language only and is not sent to the team as a question", async () => {
    const m = msg("From now on, always answer in English please", [], A.channels["your-team"]!, [A.roleId!]);
    await bot.onMessage(m);
    expect(m.replies[0]).toMatch(/From now on I will answer in English/);
    expect(asked).toEqual([]);
    expect(await loadLanguagePreference(wa.g)).toBe("english");
    expect(await loadLanguagePreference(wb.g)).toBeUndefined();
    const back = msg("From now on reply in the language I write in", [], A.channels["your-team"]!, [A.roleId!]);
    await bot.onMessage(back);
    expect(await loadLanguagePreference(wa.g)).toBeUndefined();
    // an ordinary question that mentions a language is still a question
    await bot.onMessage(msg("Can you write the Diwali post in Hindi?", [], A.channels["your-team"]!, [A.roleId!]));
    expect(asked.map((a) => a.question)).toEqual(["Can you write the Diwali post in Hindi?"]);
    expect(await loadLanguagePreference(wa.g)).toBeUndefined();
  });

  it("an Approve press decides A's card in A's graph; B's card id from A's thread finds nothing; B's role is turned away", async () => {
    const mine = msg("one more", [file("photo.jpg")], A.channels.studio!, [A.roleId!]);
    await bot.onMessage(mine);
    const theirs = msg("theirs", [file("photo.jpg")], B.channels.studio!, [B.roleId!]);
    await bot.onMessage(theirs);
    const idOf = (t: FakeThread) => (t.options()[0]!.first as Exclude<Outgoing, string>).buttons![0]!.customId;
    const aButton = idOf(mine.started[0]!);
    const bButton = idOf(theirs.started[0]!);
    const status = async (g: GraphHandle, customId: string) => {
      const approvalId = customId.replace(/^allevia:studio:approve:/, "").replace(/:A$/, "");
      return (await g.roQuery<{ s: string }>("MATCH (a:Approval {id:$id}) RETURN a.status AS s", { id: approvalId }))[0]?.s;
    };
    const inThreadOf = (m: ReturnType<typeof msg>) => ({ channelId: m.started[0]!.id, threadParentId: A.channels.studio! });

    // B's role, in A's thread
    const intruder = press(aButton, { guildId: hub.guildId, ...inThreadOf(mine), memberRoleIds: [B.roleId!] });
    await bot.onButton(intruder);
    expect(intruder.replies[0]!.ephemeral).toBe(true);
    expect(await status(wa.g, aButton)).toBe("pending");

    // A's member, in A's thread, with B's card id
    const cross = press(bButton, { guildId: hub.guildId, ...inThreadOf(mine), memberRoleIds: [A.roleId!] });
    await bot.onButton(cross);
    expect(cross.replies[0]).toMatchObject({ ephemeral: true, text: expect.stringMatching(/no longer exists/) });
    expect(await status(wb.g, bButton)).toBe("pending");

    // staff, a button from nowhere, and a button in #support
    for (const b of [
      press(aButton, { guildId: hub.guildId, ...inThreadOf(mine), memberRoleIds: [staff] }),
      press(aButton, { guildId: hub.guildId, channelId: snowflake(), memberRoleIds: [A.roleId!] }),
      press(aButton, { guildId: hub.guildId, channelId: A.channels.support!, memberRoleIds: [A.roleId!] }),
    ]) {
      await bot.onButton(b);
      expect(b.updates).toEqual([]);
    }
    expect(await status(wa.g, aButton)).toBe("pending");

    // the right person decides it
    const ok = press(aButton, { guildId: hub.guildId, ...inThreadOf(mine), memberRoleIds: [A.roleId!] });
    await bot.onButton(ok);
    expect(text(ok.updates[0]!)).toMatch(/You approved option A/);
    expect(await status(wa.g, aButton)).toMatch(/approved|executed/);
    expect(await status(wb.g, bButton)).toBe("pending");
  });

  it("with no Studio wired, photo messages are ignored instead of failing", async () => {
    const bare = new HubBot({ guildId: hub.guildId, staffRoleId: staff, store, hub, log: () => {}, botFor: () => { throw new Error("not asked"); } });
    const m = msg("x", [file("photo.jpg")], A.channels.studio!, [A.roleId!]);
    await bare.onMessage(m);
    expect(m.started).toEqual([]);
  });
});

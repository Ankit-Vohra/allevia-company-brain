// Graph audit G12: what a chat turn writes goes through the privacy filter ingest uses (src/ingest/clean.ts). A key pasted into a
// question, a phone number said in a note, an address typed into an instruction or a draft never reaches the business's graph (or the
// question's vector), the owner and the model are told that it was taken out, and the graph scan of a business that only chatted comes
// back empty. The values are invented and patterned (the hygiene test requires it).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ask, type AskDeps } from "../../src/agent/ask.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { proposeAction, runPropose } from "../../src/agent/tools/actions.js";
import { remember } from "../../src/agent/tools/memory.js";
import { saveDeliverable } from "../../src/creative/deliverable.js";
import { saveTextDraft } from "../../src/creative/textcard.js";
import { scanGraph } from "../../src/ingest/privacy.js";
import { applyDirective, previewDirective } from "../../src/settings/directives.js";
import { AssetStore } from "../../src/studio/store.js";
import { fakeEmbed } from "../fixtures/seed-graph.js";
import { fakeTool, result, NOW } from "../helpers/agent.js";
import { testGraph } from "../helpers/graph.js";
import { call, makeCtx } from "../helpers/tools.js";

const KEY = ["ghp", "abcd1234efgh5678ijkl9012mnop3456qrst"].join("_"); // built, so no secrets scan reads it as a key in the source
const PHONE = "+91 98765 43210";
const EMAIL = "priya.sharma@example.com";

const NODES = [
  { type: "Business" as const, id: "business:kestrel-oak", name: "Kestrel & Oak Studio" },
  { type: "Channel" as const, id: "channel:instagram", name: "Instagram" },
  { type: "Channel" as const, id: "channel:linkedin", name: "LinkedIn" },
  { type: "Person" as const, id: "person:founder", name: "Founder" },
];

async function chatGraph(): Promise<{ g: GraphHandle; cleanup: () => Promise<void> }> {
  const { g, cleanup } = await testGraph();
  await ensureIndexes(g);
  const s = await writeBatch(g, { nodes: NODES, edges: [{ from: "channel:linkedin", type: "PART_OF", to: "business:kestrel-oak" }] }, NOW);
  expect(s.errors).toEqual([]);
  await ensureRoster(g, { businessId: "business:kestrel-oak" }, NOW);
  return { g, cleanup: async () => { await cleanup(); await closeAll(); } };
}

/** Every string stored on a node, flattened: what a reader of the graph could see. */
async function textOf(g: GraphHandle, id: string): Promise<string> {
  const [r] = await g.roQuery<{ p: Record<string, unknown> }>("MATCH (n:Entity {id:$id}) RETURN properties(n) AS p", { id });
  return JSON.stringify(Object.entries(r?.p ?? {}).filter(([k]) => !/embedding/i.test(k)));
}
const clean = (text: string): void => {
  for (const raw of [KEY, PHONE, EMAIL, "98765 43210"]) expect(text).not.toContain(raw);
};

describe("a chat turn leaves nothing private in the graph", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  beforeAll(async () => {
    ({ g, cleanup } = await chatGraph());
    dir = mkdtempSync(join(tmpdir(), "allevia-chat-privacy-"));
  }, 60_000);
  afterAll(async () => { await cleanup(); rmSync(dir, { recursive: true, force: true }); });

  it("ask(): the Turn, its Findings, the thread's name and the question's vector are saved without the key, the number and the address", async () => {
    const question = `Our GitHub token is ${KEY}, ring Priya on ${PHONE} or ${EMAIL}: why did signups drop?`;
    const answer = `Signups dropped after the connector change [[channel:instagram]]. I will ring ${PHONE} as you said.`;
    const tools: Record<string, AlleviaTool> = { get_entity: fakeTool("get_entity", result({ data: {}, nodes: [{ id: "channel:instagram", label: "Channel", name: "Instagram" }] })) };
    const scripts: Record<string, FakeScript> = {
      "chief-of-staff:plan": { structured: { steps: [{ agent: "chief-of-staff", task: `Look into ${EMAIL}'s question` }], rationale: "one desk" } },
      "chief-of-staff": { calls: [{ name: "get_entity", args: { id: "channel:instagram" } }], text: answer },
    };
    const embedded: string[] = [];
    const deps: AskDeps = {
      runtime: new FakeRuntime(scripts), getTools: (n) => n.map((x) => tools[x]).filter((t): t is AlleviaTool => !!t), graph: g, now: () => NOW,
      embedQuery: async (t) => { embedded.push(t); return fakeEmbed(t); },
    };
    const r = await ask({ tenant: "t", question, channel: "cli" }, deps, () => {});
    expect(r.ok).toBe(true);
    // the owner still reads their own words on screen
    expect(r.answer).toContain(PHONE);

    const turn = await textOf(g, r.turnId);
    clean(turn);
    expect(turn).toContain("[redacted:secret]");
    expect(turn).toContain("[redacted:phone]");
    expect(turn).toContain("[redacted:email]");
    expect(turn).toContain("channel:instagram"); // citations and ids are untouched
    const [t] = await g.roQuery<{ n: number; q: string; a: string; ev: string; name: string }>(
      "MATCH (t:Turn {id:$id}) RETURN t.redactions AS n, t.question AS q, t.answer AS a, t.events AS ev, t.name AS name", { id: r.turnId });
    expect(t!.n).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(t!.ev)).toBeInstanceOf(Array); // the event log is still valid JSON
    expect(t!.a).toContain("[[channel:instagram]]");

    const [s] = await g.roQuery<{ name: string }>("MATCH (s:Entity:Session {id:$id}) RETURN s.name AS name", { id: r.sessionId });
    clean(s!.name);
    const findings = await g.roQuery<{ id: string }>("MATCH (f:Finding {turnId:$id}) RETURN f.id AS id", { id: r.turnId });
    for (const f of findings) clean(await textOf(g, f.id));

    // the question was embedded with its private details already taken out
    expect(embedded.length).toBeGreaterThan(0);
    for (const e of embedded) clean(e);
    expect(await scanGraph(g)).toEqual([]);
  });

  it("remember: the note, its name and summary, and the vector's text are cleaned; the tool says so", async () => {
    const embedded: string[] = [];
    const ctx = makeCtx(g, { turnId: "turn:2026-10-17-aa11bb22", embedQuery: async (t) => { embedded.push(t); return fakeEmbed(t); } });
    const r = await call(remember, { text: `Priya's number is ${PHONE}; the API token is ${KEY}`, kind: "fact", about: ["channel:instagram"] }, ctx);
    expect(r.data.id).toMatch(/^memory:/);
    clean(JSON.stringify(r.data));
    expect(r.data.privateDetailsRemoved).toBe("a phone number and a key or password");
    expect(r.note).toMatch(/Private details were taken out before saving/);
    expect(r.note).toMatch(/Tell the owner/);
    const m = await textOf(g, r.data.id);
    clean(m);
    expect(m).toContain("[redacted:phone]");
    const [row] = await g.roQuery<{ n: number }>("MATCH (m:Memory {id:$id}) RETURN m.redactions AS n", { id: r.data.id });
    expect(row!.n).toBe(2);
    expect(embedded).toEqual(["Priya's number is [redacted:phone]; the API token is [redacted:secret]"]);
    expect(await scanGraph(g)).toEqual([]);
  });

  it("remember: a note with nothing private is saved as it was said, with no mention of it", async () => {
    const r = await call(remember, { text: "Stories stay paused until Diwali", kind: "fact", about: ["channel:instagram"] }, makeCtx(g, { turnId: "turn:2026-10-17-cc33dd44" }));
    expect(r.data.privateDetailsRemoved).toBeUndefined();
    expect(r.note).not.toMatch(/Private details/);
    const [row] = await g.roQuery<{ text: string; n: number | null }>("MATCH (m:Memory {id:$id}) RETURN m.text AS text, m.redactions AS n", { id: r.data.id });
    expect(row).toEqual({ text: "Stories stay paused until Diwali", n: null });
  });

  it("propose_action: the title, the reasoning and the text to post are cleaned, the card is marked, and the tool says so", async () => {
    const r = await call(proposeAction, {
      title: `Post about the sale, mail ${EMAIL}`, why: `The owner gave the token ${KEY}`, kind: "content_draft",
      payload: { title: "Sale post", body: `Our big sale starts Friday. Ring ${PHONE} to book your slot today.` }, evidence: ["channel:instagram"],
    }, makeCtx(g, { turnId: "turn:2026-10-17-ee55ff66" }));
    expect(r.data.status).toBe("pending");
    expect(r.data.privateDetailsRemoved).toBe("a phone number, an email address and a key or password");
    expect(r.note).toMatch(/add them by hand when they edit the card/);
    clean(JSON.stringify(r.data));
    for (const id of [r.data.recommendationId, r.data.approvalId]) clean(await textOf(g, id));
    const [a] = await g.roQuery<{ payload: string; n: number }>("MATCH (a:Approval {id:$id}) RETURN a.payload AS payload, a.redactions AS n", { id: r.data.approvalId });
    expect(JSON.parse(a!.payload)).toEqual({ title: "Sale post", body: "Our big sale starts Friday. Ring [redacted:phone] to book your slot today." });
    expect(a!.n).toBe(3);
    expect(r.data.recommendationId).not.toContain("priya");
    expect(await scanGraph(g)).toEqual([]);
  });

  it("a made text draft and a made poster: the title, the words, the caption and the owner's request are cleaned", async () => {
    const text = await saveTextDraft(g, {
      agentId: "content-strategist", turnId: "turn:2026-10-17-aa00bb11", now: NOW, title: `Reel script for ${EMAIL}`,
      body: `Open on the shop front. Say: ring ${PHONE} today.`, target: "instagram", why: `Asked by the owner, key ${KEY}`,
    });
    for (const id of [text.recommendationId, text.approvalId]) clean(await textOf(g, id));
    const [card] = await g.roQuery<{ payload: string }>("MATCH (a:Approval {id:$id}) RETURN a.payload AS payload", { id: text.approvalId });
    expect(JSON.parse(card!.payload)).toMatchObject({ body: "Open on the shop front. Say: ring [redacted:phone] today." });
    const [rec] = await g.roQuery<{ why: string }>("MATCH (r:Recommendation {id:$id}) RETURN r.summary AS why", { id: text.recommendationId });
    expect(rec!.why).toMatch(/Private details were taken out before saving/);

    const jpeg = await sharp(randomBytes(8 * 10 * 3), { raw: { width: 8, height: 10, channels: 3 } }).resize(1080, 1350).jpeg().toBuffer();
    const made = await saveDeliverable(g, { store: new AssetStore(dir), tenant: "t", agentId: "content-strategist", turnId: "turn:2026-10-17-cc22dd33", now: NOW }, {
      kind: "poster", title: `Sale poster for ${EMAIL}`, caption: `Ring ${PHONE} for the sale`, altText: "A poster", aspect: "4:5", channel: "instagram",
      request: `make a poster, token ${KEY}`, usesBrand: [], guidedBy: [], notes: [`note for ${EMAIL}`], hfCredits: 3,
      options: [{ label: "A", buffer: jpeg, mime: "image/jpeg", w: 1080, h: 1350, badge: "ok", note: "checked", aiEdited: true, words: `ring ${PHONE}` }],
    });
    clean(await textOf(g, made.recommendationId));
    clean(await textOf(g, made.approvalId));
    clean(await textOf(g, made.options[0]!.assetId));
    const [pay] = await g.roQuery<{ payload: string }>("MATCH (a:Approval {id:$id}) RETURN a.payload AS payload", { id: made.approvalId });
    expect(JSON.parse(pay!.payload)).toMatchObject({ title: "Sale poster for [redacted:email]", body: "Ring [redacted:phone] for the sale" });
    expect(made.title).toBe("Sale poster for [redacted:email]");
    expect(await scanGraph(g)).toEqual([]);
  });

  it("a standing instruction: the preview, the Document and the memory it becomes carry no private detail, and the preview says so", async () => {
    const pv = await previewDirective(g, { text: `No emojis on LinkedIn. Reach me on ${PHONE}, my token is ${KEY}` }, { llm: null, now: NOW });
    clean(JSON.stringify(pv));
    expect(pv.text).toBe("No emojis on LinkedIn. Reach me on [redacted:phone], my token is [redacted:secret]");
    expect(pv.notes.join(" ")).toMatch(/Private details were taken out before saving \(a phone number and a key or password\)/);
    clean(await textOf(g, pv.id));
    const applied = await applyDirective(g, pv.id, { now: NOW + 1000 });
    expect(applied.errors).toEqual([]);
    for (const d of pv.diff) clean(JSON.stringify(d));
    const memories = await g.roQuery<{ id: string }>("MATCH (m:Memory) WHERE m.id STARTS WITH $p RETURN m.id AS id", { p: `memory:${pv.id.slice("document:".length)}` });
    expect(memories.length).toBeGreaterThan(0);
    for (const m of memories) clean(await textOf(g, m.id));
    expect(await scanGraph(g)).toEqual([]);
  });
});

describe("an action card keeps what its executor needs", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => { ({ g, cleanup } = await chatGraph()); }, 60_000);
  afterAll(async () => cleanup());

  it("an email card's recipients and the label that says where it goes stay whole; the email's own words are cleaned", async () => {
    const r = await runPropose({
      title: "Send email: Your quote", why: "A lead asked for a quote", kind: "email_send", area: "sales", evidence: ["channel:instagram"],
      payload: { title: "Your quote", subject: "Your quote", to: [EMAIL], cc: ["accounts@example.com"], body: `Hello Priya, ring me on ${PHONE}.`, send: false, target: `Draft email to ${EMAIL}` },
    }, makeCtx(g, { turnId: "turn:2026-10-17-ab12cd34" }));
    const [a] = await g.roQuery<{ payload: string }>("MATCH (a:Approval {id:$id}) RETURN a.payload AS payload", { id: r.data.approvalId });
    expect(JSON.parse(a!.payload)).toEqual({
      title: "Your quote", subject: "Your quote", to: [EMAIL], cc: ["accounts@example.com"], body: "Hello Priya, ring me on [redacted:phone].", send: false, target: `Draft email to ${EMAIL}`,
    });
  });
});

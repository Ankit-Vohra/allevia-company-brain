// Issue #8: a spreadsheet dropped in #your-team runs the same upload as the web app. A fake Discord and a fake file host
// stand in for the network; the graph is a throwaway one on the test database. The preview comes first in plain words
// with OK and Not now, the owner's changes in their own words change the plan, OK adds the numbers to THIS business only,
// and nothing is written before OK.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlleviaBot, type ButtonPort, type MessagePort, type Outgoing, type PostedPort, type ThreadPort } from "../../src/discord/bot.js";
import type { FetchFn } from "../../src/discord/attachments.js";
import { pickSpreadsheet } from "../../src/discord/numbers-bot.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-15T09:00:00Z");
const MONDAY = Date.UTC(2026, 6, 6);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const CSV = ["Week starting,Enquiries,Phone calls", ...Array.from({ length: 14 }, (_, i) => `${iso(MONDAY + i * 7 * DAY)},${10 + i},${4 + i}`)].join("\n");
const URL_OF = (name: string) => `https://cdn.discordapp.com/attachments/1/2/${name}`;

let seq = 0;
const id = () => String(900000000000000000n + BigInt(++seq));
const text = (m: Outgoing) => (typeof m === "string" ? m : m.content);
const buttonsOf = (m: Outgoing) => (typeof m === "string" ? [] : m.buttons ?? []);

class Posted implements PostedPort {
  id = id();
  edits: Outgoing[] = [];
  constructor(public first: Outgoing) {}
  get current(): Outgoing { return this.edits.at(-1) ?? this.first; }
  async edit(m: Outgoing) { this.edits.push(m); }
}
class Thread implements ThreadPort {
  sent: Posted[] = [];
  constructor(public id: string) {}
  async send(m: Outgoing) { const p = new Posted(m); this.sent.push(p); return p; }
  last() { return this.sent.at(-1)!.current; }
}

const files = new Map<string, string>();
const fakeFetch: FetchFn = async (url) => {
  const body = files.get(url);
  if (body === undefined) return new Response("no", { status: 404 });
  return new Response(body, { status: 200, headers: { "content-type": "text/csv", "content-length": String(Buffer.byteLength(body)) } });
};

function drop(name: string, body: string, o: Partial<MessagePort> = {}): MessagePort & { started: Thread[]; replies: string[] } {
  files.set(new URL(URL_OF(name)).toString(), body);
  const started: Thread[] = [];
  const replies: string[] = [];
  return {
    id: id(), guildId: GUILD, channelId: CHANNEL, threadParentId: null, authorId: "1", authorIsBot: false, authorIsOwner: true, system: false,
    content: "", files: [{ url: URL_OF(name), name, size: Buffer.byteLength(body), contentType: "text/csv" }],
    thread: () => null,
    async startThread() { const t = new Thread(id()); started.push(t); return t; },
    async reply(m) { replies.push(text(m)); },
    started, replies, ...o,
  };
}

const say = (thread: Thread, content: string): MessagePort => ({
  id: id(), guildId: GUILD, channelId: thread.id, threadParentId: CHANNEL, authorId: "1", authorIsBot: false, authorIsOwner: true, system: false,
  content, files: [], thread: () => thread, startThread: async () => thread, reply: async () => {},
});

function press(customId: string, thread: Thread): ButtonPort & { replies: string[]; updates: Outgoing[] } {
  const replies: string[] = [];
  const updates: Outgoing[] = [];
  return { customId, guildId: GUILD, channelId: thread.id, threadParentId: CHANNEL, userId: "1", isOwner: true, thread: () => thread,
    reply: async (t) => { replies.push(t); }, update: async (m) => { updates.push(m); }, replies, updates };
}

describe("numbers on Discord (#your-team)", () => {
  let g: GraphHandle;
  let other: GraphHandle;
  let cleanup: () => Promise<void>;
  let cleanupOther: () => Promise<void>;
  let asked = 0;

  const bot = (graph: GraphHandle, biz: string, numbers = true) => new AlleviaBot({
    tenant: "kestrel", guildId: GUILD, channelId: CHANNEL, webBase: "http://x", graph,
    ask: async () => { asked++; throw new Error("not a question"); },
    ...(numbers ? { numbers: { businessId: biz, fetch: fakeFetch } } : {}),
    now: () => NOW, log: () => {},
  });
  const uploads = async (graph: GraphHandle) =>
    (await graph.roQuery<{ c: number }>("MATCH (d:Document {kind:'upload'}) RETURN count(d) AS c"))[0]!.c;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    ({ g: other, cleanup: cleanupOther } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:kestrel", name: "Kestrel Dental", props: { countryCode: "GB" } }, NOW - 30 * DAY);
    await upsertNode(other, { type: "Business", id: "business:other", name: "Other Shop" }, NOW - 30 * DAY);
  });
  afterAll(async () => { await cleanup(); await cleanupOther(); });

  it("knows a spreadsheet by its name or its type, and leaves photos alone", () => {
    expect(pickSpreadsheet([{ url: "u", name: "Numbers.XLSX", size: 1, contentType: null }])?.name).toBe("Numbers.XLSX");
    expect(pickSpreadsheet([{ url: "u", name: "export", size: 1, contentType: "text/csv; charset=utf-8" }])?.name).toBe("export");
    expect(pickSpreadsheet([{ url: "u", name: "shop.jpg", size: 1, contentType: "image/jpeg" }])).toBeNull();
  });

  it("previews in plain words with OK and Not now, changes the plan from a reply, and adds on OK", async () => {
    const b = bot(g, "business:kestrel");
    const m = drop("Kestrel numbers.csv", CSV);
    await b.onMessage(m);
    const [t] = m.started;
    expect(t).toBeDefined();
    const card = t!.last();
    expect(text(card)).toMatch(/weekly/i);
    expect(text(card)).toMatch(/Column B “Enquiries”/);
    expect(buttonsOf(card).map((x) => x.label)).toEqual(["OK, add these", "Not now"]);
    expect(await uploads(g)).toBe(0); // nothing is written before OK

    await b.onMessage(say(t!, "leave out C"));
    const changed = t!.last();
    expect(text(changed)).toMatch(/Column C “Phone calls”: left out/);
    expect(buttonsOf(changed)).toHaveLength(2);
    expect(buttonsOf(t!.sent.at(-2)!.current)).toEqual([]); // the older card's buttons went

    await b.onButton(press(buttonsOf(changed)[0]!.customId, t!));
    expect(text(t!.last())).toMatch(/^Added\./);
    expect(await uploads(g)).toBe(1);
    const metrics = await g.roQuery<{ k: string }>("MATCH (o:Observation) WHERE o.metric IS NOT NULL RETURN DISTINCT o.metric AS k ORDER BY k");
    expect(metrics.map((r) => r.k)).toEqual(["enquiries"]); // the column left out was not added
    expect(asked).toBe(0);
  });

  it("'Not now' adds nothing, and a typed OK works like the button", async () => {
    const b = bot(g, "business:kestrel");
    const m = drop("again.csv", CSV.replace("Phone calls", "Calls"));
    await b.onMessage(m);
    const t = m.started[0]!;
    await b.onButton(press(buttonsOf(t.last())[1]!.customId, t));
    expect(text(t.last())).toMatch(/nothing was added/);
    const before = await uploads(g);

    const m2 = drop("again2.csv", CSV.replace(",10,", ",12,"));
    await b.onMessage(m2);
    const t2 = m2.started[0]!;
    await b.onMessage(say(t2, "OK"));
    expect(text(t2.last())).toMatch(/^Added\.|^Nothing new to add\./);
    expect(await uploads(g)).toBe(before + 1);
  });

  it("adds to this business only: another business's graph is untouched", async () => {
    expect(await uploads(other)).toBe(0);
  });

  it("says what is wrong with a file in plain words", async () => {
    const b = bot(g, "business:kestrel");
    const m = drop("empty.csv", "Week,Enquiries\n");
    await b.onMessage(m);
    expect(text(m.started[0]!.last())).not.toMatch(/Error|stack|undefined/);
    expect(buttonsOf(m.started[0]!.last())).toEqual([]);
  });

  it("an old button, or a bot without the upload, does nothing harmful", async () => {
    const b = bot(g, "business:kestrel");
    const t = new Thread(id());
    const p = press("allevia:num:ok:0123456789ab", t);
    await b.onButton(p);
    expect(p.replies[0]).toMatch(/no longer waiting/);

    const plain = bot(g, "business:kestrel", false);
    const m = drop("ignored.csv", CSV);
    await plain.onMessage(m);
    expect(m.started).toEqual([]);
  });
});

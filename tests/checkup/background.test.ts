// The check-up follow-ups: `--tenant` reads the site and the kind of business onboarding stored; the background runs
// (one at a time, one per business, everyone who asked is told how it ended); the weekly schedule (on for a real
// business, off for a demo one unless switched); the web app's "Check my website" (GET/POST /api/:t/checkup, PUT
// /schedule); and Discord's /checkup, which posts the top five in a thread when the run is done. A fake runner stands in
// for the crawl and Lighthouse and writes a stored check-up the way saveCheckup does.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { CheckupJobs, type CheckupRunner } from "../../src/checkup/jobs.js";
import { startDueCheckups } from "../../src/checkup/schedule.js";
import { checkupKind, latestCheckup, setCheckupWeekly, tenantSite, topFiveText, weeklyOn } from "../../src/checkup/tenant.js";
import { AlleviaBot, type CommandPort, type Outgoing, type ThreadPort } from "../../src/discord/bot.js";
import { testGraph } from "../helpers/graph.js";
import { harness, TENANT, type Harness } from "../server/harness.js";

const NOW = Date.parse("2026-10-16T09:00:00Z");
const text = (m: Outgoing) => (typeof m === "string" ? m : m.content);

// What saveCheckup leaves behind that the readers use: the report Document with the top five as JSON.
async function storeCheckup(g: GraphHandle, asOf: string, host = "kestrel.example"): Promise<void> {
  const top = [
    { key: "call-button", title: "Add a call button to the first screen", what: "Put a Call button at the top of the home page.", why: "Phone visitors can't see how to reach you.", effort: "about 30 minutes", tier: "losing enquiries" },
    { key: "titles", title: "Give each page its own title", what: "Write a title for each service page.", why: "Google shows the same title for all of them.", effort: "about 1 hour", tier: "found and trusted" },
  ];
  await upsertNode(g, {
    type: "Document", id: `document:website-checkup-${host}-${asOf.slice(0, 10)}`, name: `Website check-up of ${host}`, asOf,
    props: { kind: "report", checkup: "website", url: `https://${host}`, top: JSON.stringify(top), fixTitles: top.map((f) => `${f.key}|${f.title}`), good: [], notes: [] },
  }, Date.parse(asOf));
}

describe("the business behind --tenant", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:kestrel", name: "Kestrel Dental", props: { domain: "kestrel.example", businessKind: "health_and_beauty" } }, NOW);
  });
  afterAll(() => cleanup());

  it("maps onboarding's kind of business to local or online", () => {
    expect(checkupKind("online_shop")).toBe("online");
    expect(checkupKind("software_product")).toBe("online");
    expect(checkupKind("food_and_drink")).toBe("local");
    expect(checkupKind(null)).toBeUndefined();
  });

  it("reads the site and the kind onboarding stored, and the weekly setting (on unless a demo)", async () => {
    const s = (await tenantSite(g, "kestrel", "business:kestrel"))!;
    expect(s).toMatchObject({ url: "https://kestrel.example", kind: "local", name: "Kestrel Dental", weekly: null });
    expect(weeklyOn(s, false)).toBe(true);
    expect(weeklyOn(s, true)).toBe(false);
    await setCheckupWeekly(g, "kestrel", false, NOW, "business:kestrel");
    expect(weeklyOn((await tenantSite(g, "kestrel", "business:kestrel"))!, false)).toBe(false);
    await setCheckupWeekly(g, "kestrel", true, NOW, "business:kestrel");
    expect(weeklyOn((await tenantSite(g, "kestrel", "business:kestrel"))!, true)).toBe(true); // a demo switched on
  });

  it("reads the latest top five in owner words", async () => {
    expect(await latestCheckup(g)).toBeNull();
    await storeCheckup(g, "2026-10-10T08:00:00Z");
    const last = (await latestCheckup(g))!;
    expect(last).toMatchObject({ checkedOn: "2026-10-10", verdict: expect.stringMatching(/losing enquiries in one place/) });
    expect(topFiveText(last)).toMatch(/1\. Add a call button to the first screen\*\*\nWhat to change: Put a Call button/);
  });
});

describe("background runs", () => {
  it("runs one at a time, never twice for a business, and tells everyone who asked", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run: CheckupRunner = async (t) => { order.push(`start ${t}`); if (t === "a") await gate; order.push(`end ${t}`); };
    const jobs = new CheckupJobs({ run, log: () => {} });
    const told: string[] = [];
    expect(jobs.start("a", "owner", (o) => told.push(`a1 ${o.ok}`)).started).toBe(true);
    expect(jobs.start("a", "owner", (o) => told.push(`a2 ${o.ok}`)).started).toBe(false);
    expect(jobs.start("b", "schedule").started).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["start a"]); // b waits its turn
    expect(jobs.state("b")?.status).toBe("waiting");
    release();
    await jobs.idle();
    await jobs.idle();
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
    expect(told).toEqual(["a1 true", "a2 true"]);
  });

  it("a failed run is said plainly, and can be started again", async () => {
    const jobs = new CheckupJobs({ run: async () => { throw new Error("Chromium crashed"); }, log: () => {} });
    let said = "";
    jobs.start("a", "owner", (o) => { said = o.error ?? ""; });
    await jobs.idle();
    expect(said).toMatch(/couldn't finish this time/);
    expect(said).not.toMatch(/Chromium/);
    expect(jobs.start("a", "owner").started).toBe(true);
  });
});

describe("the weekly schedule", () => {
  const graphs: Array<{ g: GraphHandle; cleanup: () => Promise<void> }> = [];
  const slugs = ["real", "demo", "off", "nosite", "fresh"] as const;
  const bySlug = new Map<string, GraphHandle>();
  beforeAll(async () => {
    for (const s of slugs) {
      const t = await testGraph();
      graphs.push(t);
      bySlug.set(s, t.g);
      await upsertNode(t.g, { type: "Business", id: `business:${s}`, name: s, props: { ...(s === "nosite" ? {} : { domain: `${s}.example` }), ...(s === "off" ? { checkupWeekly: false } : {}) } }, NOW);
    }
    await storeCheckup(bySlug.get("fresh")!, new Date(NOW - 2 * 86_400_000).toISOString().slice(0, 19) + "Z", "fresh.example");
  });
  afterAll(async () => { for (const t of graphs) await t.cleanup(); });

  it("starts a real business that is due, and not a demo, one switched off, one with no site or one checked this week", async () => {
    const ran: string[] = [];
    const jobs = new CheckupJobs({ run: async (t) => { ran.push(t); }, log: () => {} });
    const started = await startDueCheckups({
      tenants: async () => slugs.map((s) => ({ slug: s, businessId: `business:${s}`, ...(s === "demo" ? { demo: true } : {}) })),
      openGraph: async (s) => bySlug.get(s)!, jobs, now: () => NOW, log: () => {},
    });
    expect(started).toEqual(["real"]);
    await jobs.idle();
    expect(ran).toEqual(["real"]);
  });
});

describe("Check my website (API)", () => {
  let h: Harness;
  const ran: string[] = [];
  let jobs: CheckupJobs;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  beforeAll(async () => {
    h = await harness();
    await upsertNode(h.g, { type: "Business", id: TENANT.businessId, name: "Aamdani", props: { domain: "mini.example", businessKind: "jobs_or_recruitment" } }, NOW);
    jobs = new CheckupJobs({ run: async (t) => { ran.push(t); await gate; await storeCheckup(h.g, "2026-10-16T08:00:00Z", "mini.example"); }, log: () => {} });
  });
  afterAll(() => h.cleanup());

  it("says it hasn't been checked, starts one in the background, then shows the top five", async () => {
    const app = h.make({ checkupJobs: jobs });
    const before = await (await app.request("/api/mini/checkup")).json() as { status: string; message: string; weekly: boolean; website: string };
    expect(before).toMatchObject({ status: "idle", website: "https://mini.example", weekly: true });
    expect(before.message).toMatch(/hasn't been checked yet/);

    const res = await app.request("/api/mini/checkup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { message: string }).message).toMatch(/Checking your website now/);
    release();
    await jobs.idle();
    expect(ran).toEqual(["mini"]);
    const after = await (await app.request("/api/mini/checkup")).json() as { status: string; last: { top: Array<{ title: string }> } };
    expect(after.status).toBe("done");
    expect(after.last.top[0]!.title).toBe("Add a call button to the first screen");
  });

  it("switches the weekly check-up, and refuses both changes in public mode", async () => {
    const app = h.make({ checkupJobs: jobs });
    const r = await app.request("/api/mini/checkup/schedule", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ weekly: false }) });
    expect(((await r.json()) as { weekly: boolean }).weekly).toBe(false);
    const pub = h.make({ checkupJobs: jobs, publicMode: true });
    expect((await pub.request("/api/mini/checkup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await pub.request("/api/mini/checkup/schedule", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ weekly: true }) })).status).toBe(403);
  });
});

describe("/checkup on Discord", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:kestrel", name: "Kestrel Dental", props: { domain: "kestrel.example" } }, NOW);
  });
  afterAll(() => cleanup());

  const GUILD = "100000000000000001";
  const CHANNEL = "200000000000000002";
  function command(o: Partial<CommandPort> = {}) {
    const said: Array<{ m: string; ephemeral: boolean }> = [];
    const thread = { id: "300000000000000003", sent: [] as string[], async send(m: Outgoing) { this.sent.push(text(m)); return { id: "p", edit: async () => {} }; } };
    const c: CommandPort = {
      command: "checkup", guildId: GUILD, channelId: CHANNEL, threadParentId: null, userId: "1", isOwner: true,
      defer: async () => {}, respond: async (m, x) => { said.push({ m: text(m), ephemeral: !!x?.ephemeral }); },
      followUp: async () => ({ id: "f", edit: async () => {} }), thread: () => null, createThread: async () => thread as ThreadPort, ...o,
    };
    return { c, said, thread };
  }

  it("starts the business's own check-up and posts the top five in a thread when it is done", async () => {
    const ran: string[] = [];
    const jobs = new CheckupJobs({ run: async (t) => { ran.push(t); await storeCheckup(g, "2026-10-16T08:30:00Z"); }, log: () => {} });
    const bot = new AlleviaBot({ tenant: "kestrel", guildId: GUILD, channelId: CHANNEL, webBase: "http://x", graph: g, ask: async () => { throw new Error("no"); }, checkup: jobs, log: () => {} });
    const { c, said, thread } = command();
    await bot.onCommand(c);
    expect(said[0]!.m).toMatch(/^Checking kestrel\.example now\. It takes about 3 minutes; I'll post the top five fixes in <#300000000000000003>/);
    await jobs.idle();
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toEqual(["kestrel"]);
    expect(thread.sent.join("\n")).toMatch(/Your website check-up\*\* \(kestrel\.example, 2026-10-16\)[\s\S]*1\. Add a call button/);
  });

  it("only the owner, and only where the bot works", async () => {
    const jobs = new CheckupJobs({ run: async () => {}, log: () => {} });
    const bot = new AlleviaBot({ tenant: "kestrel", guildId: GUILD, channelId: CHANNEL, webBase: "http://x", graph: g, ask: async () => { throw new Error("no"); }, checkup: jobs, log: () => {} });
    const a = command({ isOwner: false });
    await bot.onCommand(a.c);
    expect(a.said).toEqual([{ m: "Only the owner can start a website check-up.", ephemeral: true }]);
    const b = command({ channelId: "999" });
    await bot.onCommand(b.c);
    expect(b.said[0]!.ephemeral).toBe(true);
    expect(jobs.state("kestrel")).toBeUndefined();
  });
});

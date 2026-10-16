// Everything that needs the owner's OK reaches the business's Discord with the thing itself (audit #39, the founder's
// rule: Discord is where owners work for now). Cards carry the full text, the pictures attached, the reason in a line,
// who a message goes to, what a web page says now, Approve / Change / No thanks, and the result after a decision; a
// backlog is posted over a few syncs; a stand-up draft is posted once; a card made now is posted within seconds.
// Fake Discord ports and fake stores only: nothing here can post to a real server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderApproval, verdictLine } from "../../src/discord/approval-card.js";
import { approvalExtras } from "../../src/discord/approval-extras.js";
import { startApprovalNudge } from "../../src/discord/hub-nudge.js";
import { MAX_CARDS_PER_SYNC, provisionCustomer, syncArea, type ProvisionDeps, type TenantSource } from "../../src/discord/hub-provision.js";
import { approvalCreated } from "../../src/graph/approval-hook.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode } from "../../src/graph/upsert.js";
import type { ApprovalDto } from "../../src/server/types.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeHub, MemoryHubStore } from "../helpers/hub-fakes.js";
import { testGraph } from "../helpers/graph.js";

const card = (id: string, over: Partial<ApprovalDto> = {}): ApprovalDto => ({
  id, kind: "content_draft", status: "pending", title: `Post ${id}`, by: "content-strategist", createdAt: "2026-10-16T09:00:00.000Z",
  payload: { title: `Post ${id}`, body: "Diwali greetings from Raipur.\n\n#diwali", target: "Instagram post" }, ...over,
});

describe("renderApproval: what the owner reads", () => {
  it("shows the full text, the reason and Approve / Change / No thanks", () => {
    const m = renderApproval(card("approval:a1"), { why: "Diwali is in about 23 days." });
    expect(m.rest).toEqual([]);
    expect(m.first.content).toContain("**Post approval:a1** · a draft post");
    expect(m.first.content).toContain("Why: Diwali is in about 23 days.");
    expect(m.first.content).toContain("> Diwali greetings from Raipur.");
    expect(m.first.content).toContain("> #diwali");
    expect(m.first.buttons.map((b) => b.label)).toEqual(["Approve", "Change", "No thanks"]);
    expect(m.first.buttons.map((b) => b.customId)).toEqual(["allevia:approve:approval:a1", "allevia:change:approval:a1", "allevia:reject:approval:a1"]);
    expect(m.first.content).not.toMatch(/approval:a1`/); // no raw id line for the owner
  });

  it("never cuts a long text: the first message says it continues and the rest follows in full", () => {
    const body = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: ${"words ".repeat(12).trim()}`).join("\n");
    const m = renderApproval(card("approval:long", { payload: { title: "Long", body } }));
    expect(m.first.content.length).toBeLessThanOrEqual(2000);
    expect(m.first.content).toContain("(continues below)");
    expect(m.rest.length).toBeGreaterThan(0);
    for (const p of m.rest) expect(p.length).toBeLessThanOrEqual(2000);
    const all = [m.first.content, ...m.rest].join("\n");
    for (let i = 1; i <= 60; i++) expect(all).toContain(`Line ${i}:`);
  });

  it("a website fix shows what the page says now, then the new words", () => {
    const m = renderApproval(card("approval:site", { kind: "github_issue", by: "tech-lead", payload: { title: "New words: opening hours", body: "Heading: Opening hours\nOpen Monday to Saturday.", target: "https://www.example.com/" } }),
      { before: { label: "On the page now", text: "Page title: Home\nMain heading: Welcome" } });
    const c = m.first.content;
    expect(c.indexOf("On the page now:")).toBeGreaterThan(-1);
    expect(c.indexOf("> Page title: Home")).toBeLessThan(c.indexOf("New:"));
    expect(c.indexOf("New:")).toBeLessThan(c.indexOf("> Heading: Opening hours"));
  });

  it("a message says who it goes to and its subject", () => {
    const m = renderApproval(card("approval:mail", { payload: { title: "Follow up with Priya", body: "Hi Priya, thanks for your enquiry." } }), { to: "priya@example.com", subject: "Your enquiry" });
    expect(m.first.content).toContain("To: priya@example.com");
    expect(m.first.content).toContain("Subject: Your enquiry");
  });

  it("options and attachments are named, and the first message carries the files", () => {
    const files = [{ name: "option-a.jpg", data: Buffer.from("a") }, { name: "option-b.jpg", data: Buffer.from("b") }];
    const m = renderApproval(card("approval:studio"), { files, options: [{ label: "Option A", note: "Free clean-up", pick: true }, { label: "Option B", note: "AI edit", pick: false, held: true }] });
    expect(m.first.files).toHaveLength(2);
    expect(m.first.content).toContain("**Option A** (our pick): Free clean-up");
    expect(m.first.content).toContain("**Option B** (held back, can't be approved): AI edit");
    expect(m.first.content).toContain("Attached: option-a.jpg, option-b.jpg");
  });

  it("a decided card has no buttons, and the verdict carries the result", () => {
    expect(renderApproval(card("approval:d", { status: "approved" }), {}, { buttons: false }).first.buttons).toEqual([]);
    expect(verdictLine({ status: "approved", result: "Added to your tasks: “Fix it”." })).toBe("✅ Approved · Added to your tasks: “Fix it”.");
    expect(verdictLine({ status: "rejected" })).toBe("❌ No thanks");
    expect(verdictLine({ status: "edited" })).toContain("changed first");
  });
});

describe("syncArea posts the content, a backlog over a few syncs, and the result", () => {
  let hub: FakeHub; let store: MemoryHubStore; let deps: ProvisionDeps; let approvals: string; let note: string;
  const clock = { t: 1_800_000_000_000 };
  beforeAll(async () => {
    hub = new FakeHub();
    const staff = hub.addRole("Allevia staff", 10).id;
    store = new MemoryHubStore();
    deps = { hub, store, staffRoleId: staff, now: () => clock.t, log: () => undefined, tenant: async () => ({ name: "Aamdani" }) };
    const prov = await provisionCustomer("aamdani", deps);
    approvals = prov.area.channels.approvals!;
    note = prov.area.channels["todays-note"]!;
  });
  const msgs = (ch: string) => [...hub.messages.values()].filter((m) => m.channelId === ch);

  it("attaches the pictures to the card and says why in one line", async () => {
    const a = card("approval:pic");
    const src: TenantSource = {
      pendingApprovals: async () => [a], approval: async () => a, latestBrief: async () => null,
      extras: async () => ({ why: "The best reel did 4 times the usual views.", files: [{ name: "option-a.jpg", data: Buffer.from("x") }], options: [{ label: "Option A", note: "", pick: true }] }),
    };
    await syncArea("aamdani", deps, src);
    const m = msgs(approvals).find((x) => x.content.includes("Post approval:pic"))!;
    expect(m.files).toEqual(["option-a.jpg"]);
    expect(m.content).toContain("Why: The best reel did 4 times the usual views.");
    expect(m.buttons).toHaveLength(3);
  });

  it("posts a card again without its pictures when Discord refuses them, and still posts it", async () => {
    const a = card("approval:big");
    const real = hub.sendMessage.bind(hub);
    hub.sendMessage = async (ch, m) => { if (typeof m !== "string" && m.files?.length) throw new Error("Request entity too large"); return real(ch, m); };
    const src: TenantSource = { pendingApprovals: async () => [a], approval: async () => a, latestBrief: async () => null, extras: async () => ({ files: [{ name: "reel.mp4", data: Buffer.from("x") }] }) };
    await syncArea("aamdani", deps, src);
    hub.sendMessage = real;
    const m = msgs(approvals).find((x) => x.content.includes("Post approval:big"))!;
    expect(m.files).toEqual([]);
    expect(m.content).toMatch(/too big to attach/);
    expect(m.buttons).toHaveLength(3);
  });

  it("posts a long text in full, and a backlog of more than one sync's worth over two syncs, oldest first", async () => {
    const all = Array.from({ length: MAX_CARDS_PER_SYNC + 5 }, (_, i) => card(`approval:q${String(i).padStart(2, "0")}`, { title: `Q${i}`, createdAt: `2026-10-15T09:${String(i).padStart(2, "0")}:00.000Z`, payload: { title: `Q${i}`, body: i === 0 ? "z ".repeat(1500) : "short" } }));
    const src: TenantSource = { pendingApprovals: async () => all, approval: async () => null, latestBrief: async () => null };
    const first = await syncArea("aamdani", deps, src);
    expect(first).toMatchObject({ cards: MAX_CARDS_PER_SYNC, more: 5 });
    const q0 = msgs(approvals).find((x) => x.content.includes("**Q0**"))!;
    expect(q0.content).toContain("(continues below)");
    const second = await syncArea("aamdani", deps, src);
    expect(second.cards).toBe(5);
    expect(second.more).toBeUndefined();
    expect(msgs(approvals).filter((x) => /\*\*Q\d+\*\*/.test(x.content))).toHaveLength(MAX_CARDS_PER_SYNC + 5);
    expect((await syncArea("aamdani", deps, src)).cards).toBe(0);
  });

  it("shows the result on the card once it is decided anywhere, and posts a stand-up draft once, under the note only", async () => {
    const draft = card("approval:standup-x", { title: "A poster for Dussehra" });
    const live: { status: ApprovalDto["status"]; result?: string } = { status: "pending" };
    const src: TenantSource = {
      pendingApprovals: async () => [{ ...draft, status: live.status }], approval: async () => ({ ...draft, status: live.status, ...(live.result ? { result: live.result } : {}) }),
      latestBrief: async () => null,
      standupCards: async () => [{ approval: draft, why: "Dussehra is in 4 days. A second sentence." }],
    };
    await syncArea("aamdani", deps, src);
    expect(msgs(approvals).some((x) => x.content.includes("A poster for Dussehra"))).toBe(false); // not in #approvals
    const posted = msgs(note).find((x) => x.content.includes("A poster for Dussehra"))!;
    expect(posted.content).toContain("Why: Dussehra is in 4 days.");
    expect(posted.content).not.toContain("A second sentence");
    live.status = "approved"; live.result = "Saved as a draft.";
    await syncArea("aamdani", deps, src);
    expect(posted.buttons).toEqual([]);
    expect(posted.content).toContain("✅ Approved · Saved as a draft.");
  });

  it("two processes never post for one business at once", async () => {
    const a = card("approval:race");
    const src: TenantSource = { pendingApprovals: async () => [a], approval: async () => a, latestBrief: async () => null };
    const held = await store.claimSync("aamdani", clock.t, 60_000);
    expect(held).toBeTruthy();
    expect(await syncArea("aamdani", deps, src)).toEqual({ cards: 0, note: false, closed: 0 }); // someone else is posting
    await store.releaseSync("aamdani", held!);
    expect((await syncArea("aamdani", deps, src)).cards).toBe(1);
  });

  it("a card made in this process is posted within the nudge delay, not at the minute sync", async () => {
    const a = card("approval:fresh");
    const src: TenantSource = { pendingApprovals: async () => [a], approval: async () => a, latestBrief: async () => null };
    const done = new Promise<void>((resolve) => {
      const stop = startApprovalNudge({ deps, source: async () => src, delayMs: 20, done: () => { stop(); resolve(); } });
      approvalCreated("allevia_aamdani");
      approvalCreated("allevia_aamdani"); // two cards in one breath: one sync covers both
      approvalCreated("allevia_meta");    // not a business: ignored
    });
    await done;
    expect(msgs(approvals).some((x) => x.content.includes("Post approval:fresh"))).toBe(true);
  });
});

describe("approvalExtras reads the business's own graph and folder", () => {
  let g: GraphHandle; let cleanup: () => Promise<void>; let dir: string; let store: AssetStore;
  const NOW = Date.parse("2026-10-16T05:00:00Z");
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    dir = mkdtempSync(join(tmpdir(), "allevia-extras-"));
    store = new AssetStore(dir);
    const key = store.put("kestrel", "a".repeat(64), Buffer.from("jpeg-bytes"), "jpg");
    await upsertNode(g, { type: "Asset", id: "asset:v-a", name: "A", props: { storageKey: key, mime: "image/jpeg", kind: "variant", label: "A" } }, NOW);
    await upsertNode(g, { type: "Asset", id: "asset:v-b", name: "B", props: { storageKey: "missing", mime: "image/jpeg", kind: "variant", label: "B" } }, NOW);
    await upsertNode(g, { type: "Recommendation", id: "recommendation:r1", name: "Post the villa", summary: "The villa photo did best last month. More text here.", props: { status: "open" } }, NOW);
    await upsertNode(g, { type: "Page", id: "page:home", name: "Home", props: { url: "https://www.kestrel.example/", title: "Kestrel Dental", h1: "Gentle dentistry in Pune", metaDescription: "Family dentist." } }, NOW);
    const payload = JSON.stringify({ title: "Post the villa", body: "Caption", target: "instagram", to: ["priya@example.com"], subject: "Hello", studio: { recommended: "asset:v-a", variants: [{ id: "asset:v-a", label: "A", badge: "unchanged", note: "Building unchanged · Free clean-up" }, { id: "asset:v-b", label: "B", badge: "held", note: "Changed: added a wall" }] } });
    await upsertNode(g, { type: "Approval", id: "approval:s1", name: "content_draft: Post the villa", props: { status: "pending", kind: "content_draft", title: "Post the villa", payload } }, NOW);
    await upsertNode(g, { type: "Approval", id: "approval:w1", name: "github_issue: New words", props: { status: "pending", kind: "github_issue", title: "New words", payload: JSON.stringify({ title: "New words", body: "New text:\nPage: /\nAddress: https://www.kestrel.example/\nWhy: x", target: "https://www.kestrel.example/" }) } }, NOW);
  });
  afterAll(async () => { await cleanup(); rmSync(dir, { recursive: true, force: true }); await closeAll(); });

  it("finds the options, attaches the files that exist, and reads the reason, recipient and subject", async () => {
    const a = card("approval:s1", { recommendationId: "recommendation:r1" });
    const x = await approvalExtras(a, { graph: g, store, tenant: "kestrel" });
    expect(x.why).toBe("The villa photo did best last month.");
    expect(x.to).toBe("priya@example.com");
    expect(x.subject).toBe("Hello");
    expect(x.options).toEqual([
      { label: "Option A", note: "Free clean-up", pick: true, held: false },
      { label: "Option B", note: "added a wall", pick: false, held: true },
    ]);
    expect(x.files).toEqual([{ name: "option-a.jpg", data: Buffer.from("jpeg-bytes") }]); // B has no file on disk
  });

  it("leaves a file out and says so when it is too big to attach", async () => {
    const a = card("approval:s1", { recommendationId: "recommendation:r1" });
    const small = await approvalExtras(a, { graph: g, store, tenant: "kestrel", webBase: "http://x" });
    expect(small.notAttached).toBeUndefined();
    const tiny = new AssetStore(dir);
    const big = Buffer.alloc(21 * 1024 * 1024, 1);
    const key = tiny.put("kestrel", "b".repeat(64), big, "mp4");
    await upsertNode(g, { type: "Asset", id: "asset:v-a", name: "A", props: { storageKey: key, mime: "video/mp4", kind: "variant", label: "A" } }, NOW + 1000);
    const x = await approvalExtras(a, { graph: g, store: tiny, tenant: "kestrel", webBase: "http://x/" });
    expect(x.files).toBeUndefined();
    expect(x.notAttached).toBe(1);
    expect(x.webUrl).toBe("http://x/approvals");
  });

  it("a website fix gets what the page says now", async () => {
    const a = card("approval:w1", { kind: "github_issue", payload: { title: "New words", body: "New text:\nAddress: https://www.kestrel.example/", target: "https://www.kestrel.example/" } });
    const x = await approvalExtras(a, { graph: g, tenant: "kestrel" });
    expect(x.before).toEqual({ label: "On the page now", text: "Page title: Kestrel Dental\nMain heading: Gentle dentistry in Pune\nDescription: Family dentist." });
  });
});

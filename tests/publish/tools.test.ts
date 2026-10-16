// The agents' posting tools, and the cards made things become: the card says where it posts and shows the picture and the exact
// words; approving it through the real decision path posts it (a dry run says "would have posted"); a channel that is not connected
// keeps the draft card and says why. Nothing here reaches a real account.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { publishCancel, publishPost, publishStatus } from "../../src/agent/tools/publish.js";
import { saveDeliverable } from "../../src/creative/deliverable.js";
import { decide } from "../../src/server/approvals.js";
import { studioDecisionHook } from "../../src/server/studio.js";
import { approveStudioDraft, studioCard } from "../../src/studio/approve.js";
import { AssetStore } from "../../src/studio/store.js";
import { planPublish, platformOfChannel, upgradeToPublish } from "../../src/publish/offer.js";
import { contentIdFor, readPost } from "../../src/publish/record.js";
import { runDue } from "../../src/publish/scheduler.js";
import type { ToolContext } from "../../src/agent/tool.js";
import { call, makeCtx } from "../helpers/tools.js";
import { addAsset, NOW, publishHarness, scriptFacebook, scriptInstagram, scriptLinkedIn, TENANT, type PublishHarness } from "./harness.js";

let h: PublishHarness;
let dir: string;
let store: AssetStore;
const TUESDAY = Date.parse("2026-10-20T15:00:00Z"); // Tuesday 7 pm in Dubai

beforeAll(async () => {
  h = await publishHarness();
  for (const p of ["instagram", "facebook", "linkedin"] as const) await h.connect(p);
  await addAsset(h.g, "asset:poster-a");
  await addAsset(h.g, "asset:tall", { w: 1080, h: 1920 });
  dir = mkdtempSync(join(tmpdir(), "allevia-publish-"));
  store = new AssetStore(dir);
  // the business, with its own time zone
  const [b] = await h.g.roQuery<{ id: string; name: string }>("MATCH (b:Entity:Business) RETURN b.id AS id, b.name AS name ORDER BY b.id LIMIT 1");
  await upsertNode(h.g, { type: "Business", id: b!.id, name: b!.name, props: { timeZone: "Asia/Dubai" } }, NOW);
}, 90_000);
afterAll(async () => { await h.cleanup(); await closeAll(); rmSync(dir, { recursive: true, force: true }); });

const ctx = (over: Partial<ToolContext> = {}): ToolContext => makeCtx(h.g, { tenant: TENANT, agentId: "content-strategist", now: NOW, connections: h.svc.port(TENANT), ...over });
const actions = (live: boolean) => ({ live, connections: () => h.svc.port(TENANT), publish: () => h.runtime() });
const pending = async (id: string) => (await h.g.roQuery<{ s: string; k: string; p: string }>("MATCH (a:Approval {id:$id}) RETURN a.status AS s, a.kind AS k, a.payload AS p", { id }))[0]!;

describe("publish_post", () => {
  it("proposes a card that says where it posts, with the picture and the exact words, and posts nothing", async () => {
    scriptInstagram(h);
    h.composio.calls.length = 0;
    const r = await call(publishPost, { platform: "instagram", caption: "Fresh bread every morning #bakery", asset_id: "asset:poster-a", why: "The owner asked for a bread post" }, ctx());
    expect(r.data).toMatchObject({ kind: "publish_post", status: "pending", posted: false, waitingForOk: true, platform: "instagram", account: "@cafe" });
    expect(r.data.say).toMatch(/Approving posts it to Instagram \(your account @cafe\) straight away\. Nothing is posted until you approve\./);
    const card = await pending(r.data.approvalId);
    expect(card).toMatchObject({ s: "pending", k: "publish_post" });
    const payload = JSON.parse(card.p) as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: "Post to Instagram (your account @cafe): Fresh bread every morning #bakery", body: "Fresh bread every morning #bakery", target: "Instagram: @cafe",
      publish: { platform: "instagram", connection: "instagram", account: { id: "1784", name: "cafe", handle: "@cafe" }, tz: "Asia/Dubai" },
      studio: { recommended: "asset:poster-a", variants: [{ id: "asset:poster-a", badge: "unchanged" }] },
    });
    // only the account was read (to say whose it is); nothing was posted
    expect(h.composio.executed().map((c) => c.tool)).toEqual(["INSTAGRAM_GET_USER_INFO"]);
  });

  it("'Tuesday 7 pm' is the next Tuesday in the business's own time zone, shown on the card, and the OK schedules it", async () => {
    scriptInstagram(h);
    h.composio.calls.length = 0;
    const r = await call(publishPost, { platform: "instagram", caption: "Diwali offer starts tonight", asset_id: "asset:poster-a", when: { weekday: "tuesday", time: "7pm" }, why: "Owner asked for Tuesday evening" }, ctx());
    expect(r.data).toMatchObject({ scheduledFor: "Tue 20 Oct, 7:00 pm", timeZone: "Asia/Dubai" });
    expect(r.data.say).toMatch(/It is set for Tue 20 Oct, 7:00 pm \(Asia\/Dubai\)/);
    expect((JSON.parse((await pending(r.data.approvalId)).p) as { publish: { at: number } }).publish.at).toBe(TUESDAY);
    // approve (real executors, live): scheduled, nothing posted yet
    const d = await decide(h.g, TENANT, r.data.approvalId, { decision: "approve" }, { now: NOW, actions: actions(true) });
    expect(d.action).toMatchObject({ kind: "publish_post", status: "done", result: "Scheduled for Tue 20 Oct, 7:00 pm on Instagram (your account @cafe). You can cancel it until then." });
    expect(d.status).toBe("executed");
    expect(h.composio.executed("INSTAGRAM_CREATE_POST")).toHaveLength(0);
    // what is scheduled can be listed, and the clock posts it on time
    const list = await call(publishStatus, {}, ctx());
    expect(list.data.posts.find((p: { id: string }) => p.id === contentIdFor(r.data.approvalId))).toMatchObject({ status: "scheduled", platform: "instagram", when: "Tue 20 Oct, 7:00 pm", canCancel: true });
    await runDue(TENANT, h.g, { tenant: TENANT, connections: h.svc.port(TENANT), dryRun: false, publish: h.runtime() }, TUESDAY + 1000);
    expect(await readPost(h.g, contentIdFor(r.data.approvalId))).toMatchObject({ status: "published" });
  });

  it("a scheduled post can be cancelled by the owner's word, and then it never goes", async () => {
    scriptFacebook(h);
    const r = await call(publishPost, { platform: "facebook", caption: "Closed for Diwali on Friday", when: { date: "2026-10-22", time: "9am" }, why: "Owner asked" }, ctx());
    await decide(h.g, TENANT, r.data.approvalId, { decision: "approve" }, { now: NOW, actions: actions(true) });
    const id = contentIdFor(r.data.approvalId);
    const c = await call(publishCancel, { post_id: id }, ctx());
    expect(c.data).toMatchObject({ cancelled: true });
    expect(c.note).toMatch(/^Cancelled\./);
    h.composio.calls.length = 0;
    await runDue(TENANT, h.g, { tenant: TENANT, connections: h.svc.port(TENANT), dryRun: false, publish: h.runtime() }, Date.parse("2026-10-22T05:00:00Z"));
    expect(h.composio.executed()).toHaveLength(0);
    expect((await call(publishStatus, {}, ctx())).data.posts.find((p: { id: string }) => p.id === id)).toMatchObject({ status: "cancelled", canCancel: false });
  });

  it("with real actions off, approving says it would have posted and posts nothing", async () => {
    scriptInstagram(h);
    const r = await call(publishPost, { platform: "instagram", caption: "Dry run caption for the test", asset_id: "asset:poster-a", why: "Test of the dry run" }, ctx());
    h.composio.calls.length = 0;
    const d = await decide(h.g, TENANT, r.data.approvalId, { decision: "approve" }, { now: NOW, actions: actions(false) });
    expect(d.action).toMatchObject({ status: "dry_run" });
    expect(d.action!.result).toMatch(/^Dry run: would have posted to Instagram \(your account @cafe\): "Dry run caption for the test"\. Nothing was posted; ALLEVIA_ACTIONS_LIVE=1 posts it\.$/);
    expect(h.composio.executed()).toHaveLength(0);
    expect(await readPost(h.g, contentIdFor(r.data.approvalId))).toBeNull();
  });

  it("the owner's edit to the words is what is posted (the OK is on the edited text)", async () => {
    scriptInstagram(h);
    const r = await call(publishPost, { platform: "instagram", caption: "First wording of the post", asset_id: "asset:poster-a", why: "Test of an edit" }, ctx());
    h.composio.calls.length = 0;
    const p = JSON.parse((await pending(r.data.approvalId)).p) as { title: string; target: string };
    await decide(h.g, TENANT, r.data.approvalId, { decision: "approve", editedPayload: { title: p.title, body: "Second wording, changed by the owner", target: p.target } }, { now: NOW, actions: actions(true) });
    expect(h.composio.executed("INSTAGRAM_CREATE_MEDIA_CONTAINER")[0]!.args).toMatchObject({ caption: "Second wording, changed by the owner" });
  });

  it("No thanks posts nothing", async () => {
    const r = await call(publishPost, { platform: "instagram", caption: "A post nobody wanted", asset_id: "asset:poster-a", why: "Test of a no" }, ctx());
    h.composio.calls.length = 0;
    const d = await decide(h.g, TENANT, r.data.approvalId, { decision: "reject" }, { now: NOW, actions: actions(true) });
    expect(d.status).toBe("rejected");
    expect(h.composio.executed()).toHaveLength(0);
  });

  it("Facebook can be text alone; LinkedIn says its picture stays out", async () => {
    scriptFacebook(h); scriptLinkedIn(h);
    const fb = await call(publishPost, { platform: "facebook", caption: "We are open late tonight", why: "Owner asked" }, ctx());
    expect(JSON.parse((await pending(fb.data.approvalId)).p)).toMatchObject({ title: "Post to Facebook (your Page Cafe Roma): We are open late tonight", publish: { account: { id: "555" } } });
    const li = await call(publishPost, { platform: "linkedin", caption: "We just opened a second branch", asset_id: "asset:poster-a", why: "Owner asked" }, ctx());
    expect(li.data.say).toMatch(/LinkedIn posts from here are text only, so the picture is left out/);
  });

  it("is refused plainly before a card is made: no picture for Instagram, a picture of the wrong shape, text too long, a time without a zone or in the past", async () => {
    const need = async (args: Record<string, unknown>) => { const r = await call(publishPost, { why: "Test of a refusal", ...args } as never, ctx()); return r.data.error ? String(r.data.error) : "made"; };
    expect(await need({ platform: "instagram", caption: "No picture here" })).toMatch(/Instagram posts need a picture or a video/);
    expect(await need({ platform: "instagram", caption: "A story shape", asset_id: "asset:tall" })).toMatch(/this picture is 1080 by 1920/);
    expect(await need({ platform: "instagram", caption: "x".repeat(2300), asset_id: "asset:poster-a" })).toMatch(/takes 2200/);
    expect(await need({ platform: "instagram", caption: "Too late", asset_id: "asset:poster-a", when: { date: "2026-10-14", time: "7pm" } })).toMatch(/already passed/);
    expect(await need({ platform: "instagram", caption: "A missing picture", asset_id: "asset:not-there" })).toMatch(/missing from your records/);
  });

  it("a channel that is not connected says so with a Connect link, and makes no card", async () => {
    const before = (await h.g.roQuery<{ n: number }>("MATCH (a:Approval {kind:'publish_post'}) RETURN count(a) AS n"))[0]!.n;
    const r = await call(publishPost, { platform: "instagram", caption: "Nobody can post this", asset_id: "asset:poster-a", why: "Test of a missing connection" }, ctx({ tenant: "nobody_shop", connections: h.svc.port("nobody_shop") }));
    expect(r.data).toMatchObject({ connected: false, nothingChanged: true });
    expect(r.data.say).toMatch(/\[Connect Instagram\]\(\/connections\?connect=instagram\)/);
    expect((await h.g.roQuery<{ n: number }>("MATCH (a:Approval {kind:'publish_post'}) RETURN count(a) AS n"))[0]!.n).toBe(before);
  });

  it("the same proposal twice is one card", async () => {
    scriptLinkedIn(h);
    const a = await call(publishPost, { platform: "linkedin", caption: "Same words twice over", why: "Test of a repeat" }, ctx());
    const b = await call(publishPost, { platform: "linkedin", caption: "Same words twice over", when: { weekday: "tuesday", time: "7pm" }, why: "Test of a repeat" }, ctx());
    expect(b.data).toMatchObject({ alreadyPending: true, approvalId: a.data.approvalId });
    // the card shows what was asked for last (now with its time), never a second card
    expect((JSON.parse((await pending(a.data.approvalId)).p) as { publish: { at: number } }).publish.at).toBe(TUESDAY);
  });
});

describe("what a made thing becomes when the channel is connected", () => {
  // a picture of random colours, so two made posters never share a file (and so never an id)
  const jpeg = async () => sharp(randomBytes(8 * 10 * 3), { raw: { width: 8, height: 10, channels: 3 } }).resize(1080, 1350).jpeg().toBuffer();
  async function madePoster(tag: string) {
    const r = await saveDeliverable(h.g, { store, tenant: TENANT, agentId: "content-strategist", turnId: `t-${tag}`, now: NOW }, {
      kind: "poster", title: `Diwali sale ${tag}`, caption: "Diwali sale: 20% off this week #diwali", altText: "A poster", aspect: "4:5", channel: "instagram", request: "a diwali poster",
      options: [
        { label: "A", buffer: await jpeg(), mime: "image/jpeg", w: 1080, h: 1350, badge: "ok", note: "checked", aiEdited: true },
        { label: "B", buffer: await jpeg(), mime: "image/jpeg", w: 1080, h: 1350, badge: "ok", note: "checked", aiEdited: true },
      ], usesBrand: [], guidedBy: [], notes: [], hfCredits: 3,
    });
    return r;
  }

  it("a feed channel is postable; a Story or print is not, and says so", () => {
    expect(platformOfChannel("instagram")).toEqual({ platform: "instagram" });
    expect(platformOfChannel("instagram story")).toMatchObject({ why: expect.stringMatching(/Stories can't be posted from here yet/) });
    expect(platformOfChannel("print", "poster")).toMatchObject({ why: expect.stringMatching(/for print/) });
  });

  it("a connected Instagram turns the waiting draft card into a post card with the same options, and approving the chosen option posts that one", async () => {
    scriptInstagram(h);
    const saved = await madePoster("a");
    const plan = await planPublish({ graph: h.g, connections: h.svc.port(TENANT), agent: "content-strategist" }, "instagram");
    expect(plan).toMatchObject({ ok: true, block: { account: { handle: "@cafe" }, tz: "Asia/Dubai" } });
    if (!plan.ok) return;
    expect(await upgradeToPublish(h.g, saved.approvalId, plan.block, NOW)).toBe(true);
    const row = await pending(saved.approvalId);
    expect(row.k).toBe("publish_post");
    expect(JSON.parse(row.p)).toMatchObject({ title: "Post to Instagram (your account @cafe): Diwali sale a", target: "Instagram: @cafe", body: "Diwali sale: 20% off this week #diwali" });
    const card = (await studioCard(h.g, saved.approvalId))!;
    expect(card.payload.studio.variants).toHaveLength(2);
    // the owner picks option B (the Studio's own Approve), through the same decision path every surface uses
    h.composio.calls.length = 0;
    const optionB = saved.options.find((o) => o.label === "B")!.assetId;
    const decideWith = (id: string, edited?: { title: string; body: string; target: string }) =>
      decide(h.g, TENANT, id, { decision: "approve", ...(edited ? { editedPayload: edited } : {}) }, { now: NOW, actions: actions(true) });
    const done = await approveStudioDraft(h.g, { approvalId: saved.approvalId, variantId: optionB, now: NOW }, decideWith);
    expect(done.status).toBe("executed");
    const url = String((h.composio.executed("INSTAGRAM_CREATE_MEDIA_CONTAINER")[0]!.args as Record<string, unknown>).image_url);
    expect(url).toMatch(/\/m\//);
    const post = (await readPost(h.g, contentIdFor(saved.approvalId)))!;
    expect(post).toMatchObject({ status: "published", assetId: optionB, platform: "instagram" });
    // the Studio's part is added to the post (who made it, the cost, the picked option approved) without turning it back into a draft
    expect(post.status).toBe("published");
    expect((await h.g.roQuery<{ s: string }>("MATCH (a:Asset {id:$id}) RETURN a.status AS s", { id: optionB }))[0]!.s).toBe("approved");
    expect((await h.g.roQuery<{ n: number }>("MATCH (:Agent)-[:PRODUCED]->(c:Content {id:$id}) RETURN count(*) AS n", { id: post.id }))[0]!.n).toBeGreaterThan(0);
    expect((await h.g.roQuery<{ r: string }>("MATCH (a:Approval {id:$id}) RETURN a.result AS r", { id: saved.approvalId }))[0]!.r).toMatch(/^Posted to Instagram: https:\/\/www\.instagram\.com\/p\/abc\/$/);
  });

  it("approved from the Approvals list (no option picked), the recommended option posts, and the Studio's part is still added once", async () => {
    scriptInstagram(h);
    const saved = await madePoster("b");
    const plan = await planPublish({ graph: h.g, connections: h.svc.port(TENANT) }, "instagram");
    if (!plan.ok) throw new Error("no plan");
    await upgradeToPublish(h.g, saved.approvalId, plan.block, NOW);
    const hook = studioDecisionHook(async () => h.g, () => NOW);
    const d = await decide(h.g, TENANT, saved.approvalId, { decision: "approve" }, { now: NOW, actions: actions(true), onDecision: hook });
    expect(d.action?.status).toBe("done");
    const post = (await readPost(h.g, contentIdFor(saved.approvalId)))!;
    expect(post).toMatchObject({ status: "published", assetId: saved.recommended });
    expect((await h.g.roQuery<{ c: string | null }>("MATCH (a:Approval {id:$id}) RETURN a.contentId AS c", { id: saved.approvalId }))[0]!.c).toBe(post.id);
  });

  it("in a dry run no draft is saved either: approving says it would have posted, and the records hold no Content for it", async () => {
    scriptInstagram(h);
    const saved = await madePoster("c");
    const plan = await planPublish({ graph: h.g, connections: h.svc.port(TENANT) }, "instagram");
    if (!plan.ok) throw new Error("no plan");
    await upgradeToPublish(h.g, saved.approvalId, plan.block, NOW);
    const decideWith = (id: string) => decide(h.g, TENANT, id, { decision: "approve" }, { now: NOW, actions: actions(false) });
    const r = await approveStudioDraft(h.g, { approvalId: saved.approvalId, now: NOW }, decideWith);
    expect(r.contentId).toBe("");
    expect((await h.g.roQuery<{ r: string }>("MATCH (a:Approval {id:$id}) RETURN a.result AS r", { id: saved.approvalId }))[0]!.r).toMatch(/^Dry run: would have posted to Instagram/);
    expect((await h.g.roQuery<{ n: number }>("MATCH (:Approval {id:$id})-[:RESULTED_IN]->(:Action)-[:RESULTED_IN]->(c:Content) RETURN count(c) AS n", { id: saved.approvalId }))[0]!.n).toBe(0);
  });

  it("without the channel connected the card stays a draft, and the reason is plain", async () => {
    const saved = await madePoster("d");
    const plan = await planPublish({ graph: h.g, connections: h.svc.port("nobody_shop") }, "instagram");
    expect(plan).toMatchObject({ ok: false, why: "Instagram isn't connected yet.", connect: { id: "instagram" } });
    expect((await pending(saved.approvalId)).k).toBe("content_draft");
    // an approved draft cannot be turned into a post afterwards, and a card with no options cannot become one
    await decide(h.g, TENANT, saved.approvalId, { decision: "approve" }, { now: NOW, actions: actions(true) });
    const ok = await planPublish({ graph: h.g, connections: h.svc.port(TENANT) }, "instagram");
    if (ok.ok) expect(await upgradeToPublish(h.g, saved.approvalId, ok.block, NOW)).toBe(false);
  });
});

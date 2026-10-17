// Approving a "post it" card, end to end against a fake Composio and a throwaway graph: what is posted and where, what is kept, and
// every way it must NOT post (no OK on this content, a dry run, the daily limit, a connection that is missing or is another
// account), and what the owner is told when it fails.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeApproval, type ExecutorDeps } from "../../src/actions/executors.js";
import { closeAll } from "../../src/graph/client.js";
import { ComposioError, ComposioToolError } from "../../src/connections/composio.js";
import { runDue } from "../../src/publish/scheduler.js";
import { cancelScheduled, retryPost, runJob } from "../../src/publish/executor.js";
import { verifyMediaToken } from "../../src/publish/media.js";
import { contentIdFor, countedSince, dueIds, readPost, writePost } from "../../src/publish/record.js";
import { approvedHash } from "../../src/publish/types.js";
import type { Payload } from "../../src/actions/shared.js";
import { ACCOUNTS, addAsset, addCard, BASE, KEY, NOW, publishHarness, scriptFacebook, scriptInstagram, scriptLinkedIn, TENANT, type PublishHarness } from "./harness.js";

let h: PublishHarness;
let n = 0;
const nextId = () => `approval:pub-${++n}`;

beforeAll(async () => {
  h = await publishHarness();
  for (const p of ["instagram", "facebook", "linkedin"] as const) await h.connect(p);
  await addAsset(h.g, "asset:poster-a");
  await addAsset(h.g, "asset:poster-b", { sha: "e".repeat(64) });
  await addAsset(h.g, "asset:story", { w: 1080, h: 1920 });
}, 90_000);
afterAll(async () => { await h.cleanup(); await closeAll(); });

const deps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ tenant: TENANT, connections: h.svc.port(TENANT), dryRun: false, publish: h.runtime(), ...over });
const run = (id: string, payload: Record<string, unknown>, over: Partial<ExecutorDeps> = {}, now = NOW) =>
  executeApproval(h.g, { approvalId: id, kind: "publish_post", payload: payload as Payload, agent: "content-strategist", now }, deps(over));
const posts = (tool: string) => h.composio.executed(tool);
const reset = () => { h.composio.calls.length = 0; };
const count = async (q: string, p: Record<string, unknown> = {}) => (await h.g.roQuery<{ c: number }>(q, p))[0]?.c ?? 0;

describe("Instagram", () => {
  it("posts the approved picture and caption from the owner's account, and keeps the post: platform, address, time", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    const payload = await addCard(h.g, { id });
    const a = await run(id, payload);
    expect(a).toMatchObject({ kind: "publish_post", status: "done", url: "https://www.instagram.com/p/abc/", result: "Posted to Instagram: https://www.instagram.com/p/abc/" });
    // the picture is fetched from a signed, expiring address of this business's own asset, as a JPEG
    const container = posts("INSTAGRAM_CREATE_MEDIA_CONTAINER");
    expect(container).toHaveLength(1);
    const { image_url: imageUrl, caption, ig_user_id, content_type } = container[0]!.args as Record<string, string>;
    const image_url = imageUrl!;
    expect(caption).toBe("Diwali sale: 20% off everything this week #diwali");
    expect([ig_user_id, content_type]).toEqual(["1784", "photo"]);
    expect(image_url.startsWith(`${BASE}/m/`)).toBe(true);
    expect(verifyMediaToken(KEY, image_url.split("/m/")[1]!, NOW)).toEqual({ tenant: TENANT, assetId: "asset:poster-a", as: "jpeg" });
    expect(verifyMediaToken(KEY, image_url.split("/m/")[1]!, NOW + 2 * 3_600_000)).toBeNull();
    // it ran as the owner's own Composio entity, and only theirs
    expect(new Set(h.composio.executed().map((c) => c.userId)).size).toBe(1);
    // the record
    const post = (await readPost(h.g, contentIdFor(id)))!;
    expect(post).toMatchObject({ status: "published", platform: "instagram", accountId: "1784", accountHandle: "@cafe", postUrl: "https://www.instagram.com/p/abc/", postId: "M1", publishedAt: NOW, counted: true, assetId: "asset:poster-a", mediaKind: "image" });
    expect(await count("MATCH (:Approval {id:$id})-[:RESULTED_IN]->(:Action)-[:RESULTED_IN]->(c:Content {status:'published'})-[:PUBLISHED_ON]->(:Channel {id:'channel:instagram'}) RETURN count(*) AS c", { id })).toBe(1);
    expect(await count("MATCH (c:Content {id:$c})-[:USES_ASSET]->(:Asset {id:'asset:poster-a'}) RETURN count(*) AS c", { c: post.id })).toBe(1);
    expect(await count("MATCH (:Agent)-[:PRODUCED]->(c:Content {id:$c}) RETURN count(*) AS c", { c: post.id })).toBe(1);
  });

  it("posts exactly once: approving again changes nothing", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    const payload = await addCard(h.g, { id });
    const first = await run(id, payload);
    const again = await run(id, payload);
    expect(again.id).toBe(first.id);
    expect(posts("INSTAGRAM_CREATE_POST")).toHaveLength(1);
  });

  it("posts the option the owner picked (not the recommended one)", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    const payload = await addCard(h.g, { id, assets: [{ id: "asset:poster-a" }, { id: "asset:poster-b" }], chosen: "asset:poster-b" });
    expect((await run(id, payload)).status).toBe("done");
    const url = (posts("INSTAGRAM_CREATE_MEDIA_CONTAINER")[0]!.args as Record<string, string>).image_url!;
    expect(verifyMediaToken(KEY, url.split("/m/")[1]!, NOW)?.assetId).toBe("asset:poster-b");
    expect((await readPost(h.g, contentIdFor(id)))?.assetId).toBe("asset:poster-b");
  });

  it("never posts an option Fact Checker held back, a picture the wrong shape, or a card with no picture", async () => {
    scriptInstagram(h);
    reset();
    const held = nextId();
    const r1 = await run(held, await addCard(h.g, { id: held, assets: [{ id: "asset:poster-a", badge: "held" }] }));
    expect(r1).toMatchObject({ status: "failed" });
    expect(r1.result).toMatch(/^Nothing was posted: Fact Checker held/);
    const tall = nextId();
    const r2 = await run(tall, await addCard(h.g, { id: tall, assets: [{ id: "asset:story" }] }));
    expect(r2.result).toMatch(/Nothing was posted: this picture is 1080 by 1920, and Instagram's feed takes shapes between 4:5/);
    const none = nextId();
    const r3 = await run(none, await addCard(h.g, { id: none, noStudio: true }));
    expect(r3.result).toMatch(/Nothing was posted: Instagram posts need a picture or a video/);
    expect(h.composio.executed()).toHaveLength(0);
    expect(await readPost(h.g, contentIdFor(held))).toBeNull();
  });

  it("an unchecked option may be posted only when the card allows it", async () => {
    scriptInstagram(h);
    const ok = nextId();
    expect((await run(ok, await addCard(h.g, { id: ok, assets: [{ id: "asset:poster-a", badge: "unchecked" }], allowUnchecked: true }))).status).toBe("done");
    const no = nextId();
    expect((await run(no, await addCard(h.g, { id: no, assets: [{ id: "asset:poster-a", badge: "unchecked" }], allowUnchecked: false }))).status).toBe("failed");
  });

  it("refuses text that is too long or has too many hashtags before touching Instagram", async () => {
    reset();
    const long = nextId();
    expect((await run(long, await addCard(h.g, { id: long, caption: "x".repeat(2300) }))).result).toMatch(/takes 2200/);
    const tags = nextId();
    expect((await run(tags, await addCard(h.g, { id: tags, caption: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ") }))).result).toMatch(/30 hashtags/);
    const empty = nextId();
    expect((await run(empty, await addCard(h.g, { id: empty, caption: "  " }))).result).toMatch(/no text/);
    expect(h.composio.executed()).toHaveLength(0);
  });
});

describe("a dry run", () => {
  it("says it would have posted, and reaches nothing: not even a look at the account", async () => {
    reset();
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id }), { dryRun: true });
    expect(a.status).toBe("dry_run");
    expect(a.result).toMatch(/^Dry run: would have posted to Instagram \(your account @cafe\): "Diwali sale: 20% off everything this week #diwali"\. Nothing was posted; ALLEVIA_ACTIONS_LIVE=1 posts it\.$/);
    expect(h.composio.calls.filter((c) => c.op === "execute")).toHaveLength(0);
    // the post is still kept, as a planned post: nothing was sent, but the card has something to show
    expect(await readPost(h.g, contentIdFor(id))).toMatchObject({ status: "dry_run", platform: "instagram", retryable: false, attempts: 0 });
  });

  it("a scheduled card in a dry run says when it would have gone, and schedules nothing", async () => {
    const id = nextId();
    const at = NOW + 4 * 86_400_000;
    const a = await run(id, await addCard(h.g, { id, at, tz: "Asia/Dubai" }), { dryRun: true });
    expect(a.status).toBe("dry_run");
    expect(a.result).toMatch(/would have posted to Instagram \(your account @cafe\) at /);
    // planned, never scheduled: the scheduler only takes posts whose status is "scheduled"
    expect(await readPost(h.g, contentIdFor(id))).toMatchObject({ status: "dry_run", publishAt: at });
    expect(await dueIds(h.g, at + 1)).not.toContain(contentIdFor(id));
  });
});

describe("Facebook and LinkedIn", () => {
  it("Facebook: posts the picture to the approved Page from a signed address, and never keeps the Page's token", async () => {
    scriptFacebook(h);
    reset();
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id, platform: "facebook", caption: "Open late tonight" }));
    expect(a).toMatchObject({ status: "done", url: "https://www.facebook.com/555_777", result: "Posted to Facebook: https://www.facebook.com/555_777" });
    const call = posts("FACEBOOK_CREATE_PHOTO_POST")[0]!.args as Record<string, unknown>;
    expect(call).toMatchObject({ page_id: "555", message: "Open late tonight", published: true });
    expect(String(call.url).startsWith(`${BASE}/m/`)).toBe(true);
    // a picture for Facebook is served as it is (Facebook takes PNG too), not converted
    expect(verifyMediaToken(KEY, String(call.url).split("/m/")[1]!, NOW)).toEqual({ tenant: TENANT, assetId: "asset:poster-a" });
    expect(JSON.stringify(await h.g.roQuery("MATCH (n) WHERE n.id STARTS WITH 'content:publish' RETURN properties(n) AS p"))).not.toMatch(/page-token|EAAB/);
  });

  it("Facebook: a text-only post needs no picture", async () => {
    scriptFacebook(h);
    reset();
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id, platform: "facebook", noStudio: true, caption: "We're closed Monday." }));
    expect(a).toMatchObject({ status: "done", url: "https://www.facebook.com/555_9" });
    expect(posts("FACEBOOK_CREATE_POST")[0]!.args).toEqual({ page_id: "555", message: "We're closed Monday.", published: true });
  });

  it("LinkedIn: posts text as the owner's profile, and says plainly that the picture stays out", async () => {
    scriptLinkedIn(h);
    reset();
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id, platform: "linkedin", caption: "We just launched (finally)." }));
    expect(a.status).toBe("done");
    expect(a.result).toMatch(/^Posted to LinkedIn as text \(LinkedIn's connection can't attach pictures from here yet\): https:\/\/www\.linkedin\.com\/feed\/update\//);
    expect(posts("LINKEDIN_CREATE_LINKED_IN_POST")[0]!.args).toEqual({ author: "urn:li:person:abc", commentary: "We just launched \\(finally\\).", visibility: "PUBLIC", lifecycleState: "PUBLISHED" });
    expect(h.composio.executed().some((c) => /MEDIA|PHOTO|IMAGE/.test(c.tool))).toBe(false);
  });
});

describe("what stops a post", () => {
  it("a business that has not connected the platform: plain words, nothing posted", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id }), { tenant: "nobody_shop", connections: h.svc.port("nobody_shop") });
    expect(a.status).toBe("failed");
    expect(a.result).toBe("Instagram isn't connected. Connect it from Connections, then try again. Nothing was posted.");
    expect(h.composio.executed()).toHaveLength(0);
  });

  it("another account is connected now than the one the owner approved: refused", async () => {
    reset();
    h.composio.handlers.set("INSTAGRAM_GET_USER_INFO", () => ({ id: "9999", username: "someone_else" }));
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id }));
    expect(a.status).toBe("failed");
    expect(a.result).toBe("Instagram is now connected as your account @someone_else, not your account @cafe that you approved. Nothing was posted.");
    expect(posts("INSTAGRAM_CREATE_MEDIA_CONTAINER")).toHaveLength(0);
    scriptInstagram(h);
  });

  it("the Facebook Page approved is found among several, not taken as the first", async () => {
    reset();
    h.composio.handlers.set("FACEBOOK_GET_USER_PAGES", () => ({ response_data: { data: [{ id: "111", name: "Other Page" }, { id: "555", name: "Cafe Roma" }] } }));
    h.composio.handlers.set("FACEBOOK_CREATE_POST", () => ({ response_data: { id: "555_1" } }));
    const id = nextId();
    expect((await run(id, await addCard(h.g, { id, platform: "facebook", noStudio: true }))).status).toBe("done");
    expect(posts("FACEBOOK_CREATE_POST")[0]!.args).toMatchObject({ page_id: "555" });
    scriptFacebook(h);
  });

  it("the picture's address must be reachable from the internet: a local server address is explained", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id }), { publish: h.runtime({ signer: { key: KEY, base: "http://127.0.0.1:8787", now: () => NOW } }) });
    expect(a.status).toBe("failed");
    expect(a.result).toMatch(/can only be reached from inside its own network.*Set ALLEVIA_WEB_URL.*Nothing was posted\.$/);
    expect(posts("INSTAGRAM_CREATE_MEDIA_CONTAINER")).toHaveLength(0);
    expect((await readPost(h.g, contentIdFor(id)))).toMatchObject({ status: "failed", retryable: true });
  });

  it("the daily limit holds the post back, says so, keeps it for a retry, and lets it go once there is room", async () => {
    scriptInstagram(h);
    reset();
    const used = await countedSince(h.g, NOW - 86_400_000);
    const tight = deps({ publish: h.runtime({ perDay: used + 1 }) });
    const one = nextId(), two = nextId();
    expect((await run(one, await addCard(h.g, { id: one }), tight)).status).toBe("done");
    const held = await run(two, await addCard(h.g, { id: two }), tight);
    expect(held.status).toBe("failed");
    expect(held.result).toBe(`You've reached today's limit of ${used + 1} posts, so this one was held back. Nothing was posted. Tap Try again tomorrow, or later today once an earlier post is more than a day old.`);
    expect(posts("INSTAGRAM_CREATE_POST")).toHaveLength(1);
    expect(await readPost(h.g, contentIdFor(two))).toMatchObject({ status: "failed", retryable: true, maybePosted: false });
    // a day on, the first post is old enough that there is room again
    const later = await retryPost(h.g, contentIdFor(two), tight, { now: NOW + 86_400_000 + 60_000 });
    expect(later.ok).toBe(true);
    expect(posts("INSTAGRAM_CREATE_POST")).toHaveLength(2);
  });
});

describe("when something goes wrong", () => {
  it("Instagram says no to the picture: plain words, nothing posted, one tap to try again, and the retry works", async () => {
    scriptInstagram(h);
    h.composio.handlers.set("INSTAGRAM_CREATE_MEDIA_CONTAINER", (_a, k) => (k === 1 ? { fail: "(#9004) The media could not be fetched from this URI" } : { id: "C2" }));
    reset();
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id }));
    expect(a.status).toBe("failed");
    expect(a.result).toBe("Instagram couldn't use the picture. It has to be a JPEG or PNG that loads from the internet, with a shape between 4:5 and 1.91:1 for the feed. Nothing was posted.");
    const failed = (await readPost(h.g, contentIdFor(id)))!;
    expect(failed).toMatchObject({ status: "failed", retryable: true, maybePosted: false });
    expect(posts("INSTAGRAM_CREATE_POST")).toHaveLength(0);
    // Try again
    h.composio.handlers.set("INSTAGRAM_CREATE_MEDIA_CONTAINER", () => ({ id: "C2" }));
    const r = await retryPost(h.g, failed.id, deps(), { now: NOW + 60_000 });
    expect(r).toMatchObject({ ok: true, message: "Posted to Instagram: https://www.instagram.com/p/abc/" });
    expect(await readPost(h.g, failed.id)).toMatchObject({ status: "published", attempts: 2 });
    // the card follows: Action done with the address, Approval executed with the words
    expect((await h.g.roQuery<{ s: string; r: string }>("MATCH (a:Approval {id:$id}) RETURN a.status AS s, a.result AS r", { id }))[0]).toEqual({ s: "executed", r: "Posted to Instagram: https://www.instagram.com/p/abc/" });
    expect((await h.g.roQuery<{ s: string; u: string }>("MATCH (a:Action {id:$id}) RETURN a.status AS s, a.url AS u", { id: `action:${id.replace("approval:", "")}` }))[0]).toEqual({ s: "done", u: "https://www.instagram.com/p/abc/" });
    // and a post that already went out can't be posted a second time by tapping again
    expect(await retryPost(h.g, failed.id, deps(), { now: NOW + 120_000 })).toMatchObject({ ok: false, message: "It already went out." });
    expect(posts("INSTAGRAM_CREATE_POST")).toHaveLength(1);
  });

  it("a dropped line at the last step may have posted: it is never repeated by itself, and the owner is asked to look first", async () => {
    scriptInstagram(h);
    h.composio.handlers.set("INSTAGRAM_CREATE_POST", (_a, k) => { if (k === 1) throw new ComposioError("Composio answered 504.", 504); return { id: "M5" }; });
    reset();
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id }));
    expect(a.status).toBe("failed");
    expect(a.result).toMatch(/couldn't confirm that Instagram took it.*Check your Instagram account before trying again\.$/);
    const row = (await readPost(h.g, contentIdFor(id)))!;
    expect(row).toMatchObject({ status: "failed", maybePosted: true, retryable: true, containerId: "C1", counted: true });
    // trying again without looking first is refused; after looking, it carries on with the SAME container (no second post)
    const refused = await retryPost(h.g, row.id, deps(), { now: NOW + 60_000 });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/Check your account first/);
    expect(posts("INSTAGRAM_CREATE_POST")).toHaveLength(1);
    const ok = await retryPost(h.g, row.id, deps(), { now: NOW + 120_000, anyway: true });
    expect(ok.ok).toBe(true);
    expect(posts("INSTAGRAM_CREATE_MEDIA_CONTAINER")).toHaveLength(1);
    expect(posts("INSTAGRAM_CREATE_POST").map((c) => (c.args as { creation_id: string }).creation_id)).toEqual(["C1", "C1"]);
    scriptInstagram(h);
  });

  it("an expired login says so and asks to connect again; it is not a mystery", async () => {
    scriptInstagram(h);
    h.composio.handlers.set("INSTAGRAM_CREATE_MEDIA_CONTAINER", () => ({ fail: "OAuthException (#190): Error validating access token: Session has expired" }));
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id }));
    expect(a.result).toBe("Instagram stopped letting us in. Connect Instagram again, then try again. Nothing was posted.");
    expect(await readPost(h.g, contentIdFor(id))).toMatchObject({ reconnect: true, retryable: true });
    scriptInstagram(h);
  });

  it("an unexpected error after the claim is treated as maybe-posted, never retried by itself", async () => {
    scriptInstagram(h);
    h.composio.handlers.set("INSTAGRAM_CREATE_MEDIA_CONTAINER", () => { throw new TypeError("boom"); });
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id }));
    expect(a.status).toBe("failed");
    expect(a.result).toMatch(/can't confirm|couldn't|didn't answer|can't tell/);
    scriptInstagram(h);
  });
});

describe("only what was approved is posted", () => {
  it("a post whose caption changed after the OK is not sent", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    const at = NOW + 3_600_000;
    await run(id, await addCard(h.g, { id, at, tz: "Asia/Dubai" }));
    const cid = contentIdFor(id);
    expect((await readPost(h.g, cid))?.status).toBe("scheduled");
    // somebody (or something) edits the stored post
    await writePost(h.g, cid, "Post", { caption: "Buy my crypto instead" }, NOW + 10);
    const r = await runJob(h.g, cid, deps(), { from: ["scheduled"], now: at + 1000 });
    expect(r.outcome).toMatchObject({ status: "failed", result: "This post changed after you approved it, so it was not sent. Ask your team to propose it again. Nothing was posted." });
    expect(posts("INSTAGRAM_CREATE_MEDIA_CONTAINER")).toHaveLength(0);
    expect(await readPost(h.g, cid)).toMatchObject({ status: "failed", retryable: false });
  });

  it("a post whose picture was swapped for another file is not sent", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    await addAsset(h.g, "asset:swap", { sha: "c".repeat(64) });
    const at = NOW + 3_600_000;
    await run(id, await addCard(h.g, { id, at, tz: "Asia/Dubai", assets: [{ id: "asset:swap" }] }));
    await addAsset(h.g, "asset:swap", { sha: "d".repeat(64) }); // same record, different bytes
    const r = await runJob(h.g, contentIdFor(id), deps(), { from: ["scheduled"], now: at + 1000 });
    expect(r.outcome.result).toMatch(/changed after you approved it/);
    expect(h.composio.executed()).toHaveLength(0);
  });

  it("a post with no OK on record is not sent, even if its record is made by hand", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    await addCard(h.g, { id, decided: false });
    const cid = contentIdFor(id);
    await writePost(h.g, cid, "Forged", {
      approval: id, platform: "instagram", connection: "instagram", accountId: "1784", accountName: "cafe", title: "Forged", caption: "hello", status: "scheduled", publishAt: NOW,
      approvedHash: approvedHash({ platform: "instagram", accountId: "1784", caption: "hello", at: NOW }), attempts: 0,
    }, NOW);
    const r = await runJob(h.g, cid, deps(), { from: ["scheduled"], now: NOW + 1000 });
    expect(r.outcome.result).toMatch(/no OK from you on record/);
    expect(h.composio.executed()).toHaveLength(0);
  });
});

describe("scheduling", () => {
  const tuesday = Date.parse("2026-10-20T15:00:00Z"); // Tuesday 7 pm in Dubai
  it("approving a card with a time sets it for then, in the business's zone, and posts nothing now", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id, at: tuesday, tz: "Asia/Dubai" }));
    expect(a).toMatchObject({ status: "done", result: "Scheduled for Tue 20 Oct, 7:00 pm on Instagram (your account @cafe). You can cancel it until then." });
    expect(h.composio.executed()).toHaveLength(0);
    expect(await readPost(h.g, contentIdFor(id))).toMatchObject({ status: "scheduled", publishAt: tuesday, tz: "Asia/Dubai" });
  });

  it("the scheduler posts it when its time comes, not before, and writes the result back to the card", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    await run(id, await addCard(h.g, { id, at: tuesday, tz: "Asia/Dubai" }));
    const env = { tenant: TENANT, connections: h.svc.port(TENANT), dryRun: false, publish: h.runtime() };
    expect(await runDue(TENANT, h.g, env, tuesday - 60_000)).toEqual([]);
    expect(h.composio.executed()).toHaveLength(0);
    const done = await runDue(TENANT, h.g, env, tuesday + 5_000);
    const mine = done.filter((r) => r.id === contentIdFor(id));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.outcome).toMatchObject({ status: "done", url: "https://www.instagram.com/p/abc/" });
    expect(await readPost(h.g, contentIdFor(id))).toMatchObject({ status: "published", publishedAt: tuesday + 5_000 });
    expect((await h.g.roQuery<{ s: string; r: string }>("MATCH (a:Approval {id:$id}) RETURN a.status AS s, a.result AS r", { id }))[0]).toEqual({ s: "executed", r: "Posted to Instagram: https://www.instagram.com/p/abc/" });
    // and it is only ever posted once, however many times the clock ticks
    const before = posts("INSTAGRAM_CREATE_POST").length;
    await runDue(TENANT, h.g, env, tuesday + 60_000);
    await runDue(TENANT, h.g, env, tuesday + 120_000);
    expect(posts("INSTAGRAM_CREATE_POST")).toHaveLength(before);
  });

  it("a cancelled post is never sent, and the card says it was cancelled", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    await run(id, await addCard(h.g, { id, at: tuesday, tz: "Asia/Dubai" }));
    const c = await cancelScheduled(h.g, contentIdFor(id), { now: NOW + 5000 });
    expect(c).toMatchObject({ ok: true });
    expect(c.message).toBe("Cancelled. Instagram (your account @cafe) will not get this post (it was set for Tue 20 Oct, 7:00 pm). Nothing was posted.");
    const env = { tenant: TENANT, connections: h.svc.port(TENANT), dryRun: false, publish: h.runtime() };
    await runDue(TENANT, h.g, env, tuesday + 5_000);
    expect(h.composio.executed()).toHaveLength(0);
    expect(await readPost(h.g, contentIdFor(id))).toMatchObject({ status: "cancelled" });
    expect((await h.g.roQuery<{ s: string; r: string }>("MATCH (a:Approval {id:$id}) RETURN a.status AS s, a.result AS r", { id }))[0]!.r).toMatch(/^Cancelled\./);
    // cancelling twice is fine; cancelling one that went out is explained
    expect((await cancelScheduled(h.g, contentIdFor(id), { now: NOW + 6000 })).message).toMatch(/already cancelled/);
  });

  it("cannot cancel a post that already went out", async () => {
    scriptInstagram(h);
    const id = nextId();
    await run(id, await addCard(h.g, { id }));
    const c = await cancelScheduled(h.g, contentIdFor(id), { now: NOW });
    expect(c).toMatchObject({ ok: false, message: "It already went out, so it can't be cancelled from here." });
  });

  it("a time that has already passed by more than a quarter of an hour is not posted; one a few minutes late still goes", async () => {
    scriptInstagram(h);
    reset();
    const late = nextId();
    const a = await run(late, await addCard(h.g, { id: late, at: NOW - 3_600_000, tz: "Asia/Dubai" }));
    expect(a.status).toBe("failed");
    expect(a.result).toMatch(/^Nothing was posted: the time you chose \(.*\) has already passed/);
    const slightly = nextId();
    expect((await run(slightly, await addCard(h.g, { id: slightly, at: NOW - 5 * 60_000, tz: "Asia/Dubai" }))).status).toBe("done");
  });

  it("a scheduled post whose time comes in a dry run posts nothing and says so", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    await run(id, await addCard(h.g, { id, at: tuesday, tz: "Asia/Dubai" }));
    const env = { tenant: TENANT, connections: h.svc.port(TENANT), dryRun: true, publish: h.runtime() };
    const done = (await runDue(TENANT, h.g, env, tuesday + 1000)).filter((r) => r.id === contentIdFor(id));
    expect(done[0]!.outcome.status).toBe("dry_run");
    expect(h.composio.executed()).toHaveLength(0);
    expect(await readPost(h.g, contentIdFor(id))).toMatchObject({ status: "dry_run" });
  });
});

describe("a video still being prepared by Instagram", () => {
  it("is left for the scheduler, which finishes the same container when it is ready, and gives up after half an hour", async () => {
    await addAsset(h.g, "asset:clip", { mime: "video/mp4", kind: "clip", w: 1080, h: 1920, sha: "f".repeat(64) });
    scriptInstagram(h);
    let status = "IN_PROGRESS";
    h.composio.handlers.set("INSTAGRAM_GET_POST_STATUS", () => ({ status_code: status }));
    reset();
    const id = nextId();
    const rt = h.runtime({ post: { sleep: async () => undefined, now: (() => { let t = 0; return () => (t += 20_000); })(), maxWaitMs: 40_000, pollMs: 1000 } });
    const a = await run(id, await addCard(h.g, { id, assets: [{ id: "asset:clip" }] }), { publish: rt });
    expect(a.status).toBe("done");
    expect(a.result).toMatch(/still preparing it/);
    const cid = contentIdFor(id);
    expect(await readPost(h.g, cid)).toMatchObject({ status: "publishing", containerId: "C1" });
    expect(posts("INSTAGRAM_CREATE_POST")).toHaveLength(0);
    expect(posts("INSTAGRAM_CREATE_MEDIA_CONTAINER")[0]!.args).toMatchObject({ content_type: "reel" });
    // not yet a minute: left alone. Later, still preparing: left alone. Then ready: posted with the same container.
    const env = { tenant: TENANT, connections: h.svc.port(TENANT), dryRun: false, publish: h.runtime() };
    expect((await runDue(TENANT, h.g, env, NOW + 10_000)).filter((r) => r.id === cid)).toEqual([]);
    status = "FINISHED";
    const done = (await runDue(TENANT, h.g, env, NOW + 90_000)).filter((r) => r.id === cid);
    expect(done[0]!.outcome).toMatchObject({ status: "done" });
    expect(posts("INSTAGRAM_CREATE_MEDIA_CONTAINER")).toHaveLength(1);
    expect(await readPost(h.g, cid)).toMatchObject({ status: "published" });
  });

  it("gives up after half an hour with words and a Try again", async () => {
    scriptInstagram(h);
    h.composio.handlers.set("INSTAGRAM_GET_POST_STATUS", () => ({ status_code: "IN_PROGRESS" }));
    const id = nextId();
    const rt = h.runtime({ post: { sleep: async () => undefined, now: (() => { let t = 0; return () => (t += 20_000); })(), maxWaitMs: 40_000 } });
    await run(id, await addCard(h.g, { id, assets: [{ id: "asset:clip" }] }), { publish: rt });
    const env = { tenant: TENANT, connections: h.svc.port(TENANT), dryRun: false, publish: h.runtime() };
    const cid = contentIdFor(id);
    const done = (await runDue(TENANT, h.g, env, NOW + 31 * 60_000)).filter((r) => r.id === cid);
    expect(done[0]!.outcome.result).toMatch(/more than half an hour.*Nothing was posted\. Tap Try again\./);
    expect(await readPost(h.g, cid)).toMatchObject({ status: "failed", retryable: true });
    scriptInstagram(h);
  });
});

describe("a crash half way", () => {
  it("is never repeated by itself: it is marked 'may have gone out' and the owner is asked to look", async () => {
    scriptInstagram(h);
    reset();
    const id = nextId();
    await run(id, await addCard(h.g, { id, at: NOW + 3_600_000, tz: "Asia/Dubai" }));
    const cid = contentIdFor(id);
    // claimed, and then the server stopped before it wrote the result
    await h.g.query("MATCH (c:Entity:Content {id:$id}) SET c.status = 'publishing', c.attemptedAt = $t", { id: cid, t: NOW + 3_600_000 });
    const env = { tenant: TENANT, connections: h.svc.port(TENANT), dryRun: false, publish: h.runtime() };
    expect((await runDue(TENANT, h.g, env, NOW + 3_600_000 + 5 * 60_000)).filter((r) => r.id === cid)).toEqual([]);
    const done = (await runDue(TENANT, h.g, env, NOW + 3_600_000 + 11 * 60_000)).filter((r) => r.id === cid);
    expect(done[0]!.outcome.result).toMatch(/couldn't confirm that this went out.*Check your account\./);
    expect(await readPost(h.g, cid)).toMatchObject({ status: "failed", maybePosted: true, counted: true });
    expect(h.composio.executed()).toHaveLength(0);
  });
});

describe("the daily limit", () => {
  it("counts what went out, over 24 hours", async () => {
    const before = await countedSince(h.g, NOW - 86_400_000);
    expect(before).toBeGreaterThan(0);
    expect(await countedSince(h.g, NOW + 10 * 86_400_000)).toBe(0);
  });
});

void ACCOUNTS;

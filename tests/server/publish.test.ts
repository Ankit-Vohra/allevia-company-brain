// The owner's posts over HTTP: the list, Try again, Cancel, the card's preview saying where a post goes and when, and the signed
// picture address Instagram fetches from. Fakes only: no account is reached.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { signMediaUrl } from "../../src/publish/media.js";
import { contentIdFor, readPost, writePost } from "../../src/publish/record.js";
import { approvedHash } from "../../src/publish/types.js";
import { AssetStore } from "../../src/studio/store.js";
import { addAsset, addCard, KEY, NOW, publishHarness, scriptInstagram, type PublishHarness } from "../publish/harness.js";
import { harness, post, type Harness } from "./harness.js";

let h: Harness;
let c: PublishHarness;
let dir: string;
let store: AssetStore;
let app: Harness["app"];
let pub: Harness["app"];
const TUESDAY = Date.parse("2026-10-20T15:00:00Z");

beforeAll(async () => {
  h = await harness();
  c = await publishHarness();
  await c.connect("instagram", "mini");
  dir = mkdtempSync(join(tmpdir(), "allevia-pubroute-"));
  store = new AssetStore(dir);
  const jpeg = await sharp({ create: { width: 16, height: 20, channels: 3, background: "#aa5533" } }).jpeg().toBuffer();
  const key = store.put("mini", "a".repeat(64), jpeg, "jpg");
  await addAsset(h.g, "asset:poster-a");
  await upsertNode(h.g, { type: "Asset", id: "asset:poster-a", name: "Poster", props: { storageKey: key, mime: "image/jpeg" } }, NOW);
  const wiring = { actions: { live: true, connections: () => c.svc.port("mini"), publish: () => c.runtime() }, media: async () => ({ key: KEY, store, openGraph: async () => h.g, now: () => NOW }) };
  app = h.make(wiring);
  pub = h.make({ ...wiring, publicMode: true });
}, 90_000);
afterAll(async () => { await c.cleanup(); await h.cleanup(); await closeAll(); rmSync(dir, { recursive: true, force: true }); });

// a post as the executor leaves it, with the OK on record
async function seedPost(id: string, o: { status: "scheduled" | "failed" | "published"; at?: number; failure?: string; maybePosted?: boolean; retryable?: boolean }): Promise<string> {
  const approval = `approval:${id}`;
  const payload = await addCard(h.g, { id: approval });
  const publishAt = o.at ?? NOW;
  await writePost(h.g, contentIdFor(approval), String(payload.title), {
    approval, platform: "instagram", connection: "instagram", accountId: "1784", accountName: "cafe", accountHandle: "@cafe", title: String(payload.title), caption: String(payload.body),
    assetId: "asset:poster-a", mediaKind: "image", status: o.status, publishAt, tz: "Asia/Dubai",
    approvedHash: approvedHash({ platform: "instagram", accountId: "1784", caption: String(payload.body), assetSha: "assetpostera".padEnd(64, "a"), at: publishAt }),
    attempts: 1, ...(o.failure ? { failure: o.failure, retryable: o.retryable ?? true, maybePosted: o.maybePosted ?? false } : {}),
  }, NOW);
  return contentIdFor(approval);
}

const json = async (r: Response) => (await r.json()) as Record<string, unknown> & { posts?: Array<Record<string, unknown>>; message?: string; ok?: boolean; post?: Record<string, unknown> };

describe("GET /api/:t/publish", () => {
  it("lists the posts with their time in the business's words, and what the owner can do", async () => {
    const s = await seedPost("pub-s", { status: "scheduled", at: TUESDAY });
    const f = await seedPost("pub-f", { status: "failed", failure: "Instagram couldn't use the picture. Nothing was posted." });
    const r = await json(await app.request("/api/mini/publish"));
    const sched = r.posts!.find((p) => p.id === s)!;
    expect(sched).toMatchObject({ status: "scheduled", where: "Instagram (your account @cafe)", when: "Tue 20 Oct, 7:00 pm", timeZone: "Asia/Dubai", canCancel: true, canRetry: false });
    expect(r.posts!.find((p) => p.id === f)).toMatchObject({ status: "failed", canRetry: true, canCancel: false, checkFirst: false, failure: "Instagram couldn't use the picture. Nothing was posted." });
  });
});

describe("Try again and Cancel", () => {
  it("Try again posts the same approved content, and the answer says how it went", async () => {
    scriptInstagram(c);
    const f = await seedPost("pub-r1", { status: "failed", failure: "Instagram didn't answer just now. Nothing was posted." });
    const res = await post(app, `/api/mini/publish/${encodeURIComponent(f)}/retry`, {});
    expect(res.status).toBe(200);
    const r = await json(res);
    expect(r).toMatchObject({ ok: true, message: "Posted to Instagram: https://www.instagram.com/p/abc/", post: { status: "published", url: "https://www.instagram.com/p/abc/" } });
    expect(await readPost(h.g, f)).toMatchObject({ status: "published" });
  });

  it("a post that may have gone out is not posted again until the owner says they looked", async () => {
    scriptInstagram(c);
    c.composio.calls.length = 0;
    const f = await seedPost("pub-r2", { status: "failed", failure: "We couldn't confirm that Instagram took it.", maybePosted: true });
    const first = await json(await post(app, `/api/mini/publish/${encodeURIComponent(f)}/retry`, {}));
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/Check your account first/);
    expect(c.composio.executed("INSTAGRAM_CREATE_POST")).toHaveLength(0);
    const second = await json(await post(app, `/api/mini/publish/${encodeURIComponent(f)}/retry`, { anyway: true }));
    expect(second.ok).toBe(true);
  });

  it("Cancel stops a scheduled post; one that went out cannot be cancelled", async () => {
    const s = await seedPost("pub-c1", { status: "scheduled", at: TUESDAY });
    const r = await json(await post(app, `/api/mini/publish/${encodeURIComponent(s)}/cancel`, {}));
    expect(r).toMatchObject({ ok: true, post: { status: "cancelled" } });
    const done = await seedPost("pub-c2", { status: "published" });
    expect(await json(await post(app, `/api/mini/publish/${encodeURIComponent(done)}/cancel`, {}))).toMatchObject({ ok: false, message: "It already went out, so it can't be cancelled from here." });
  });

  it("is refused in the public demo, and an unknown post is a 404 (the post must be this business's own)", async () => {
    const s = await seedPost("pub-p", { status: "scheduled", at: TUESDAY });
    expect((await post(pub, `/api/mini/publish/${encodeURIComponent(s)}/cancel`, {})).status).toBe(403);
    expect((await post(pub, `/api/mini/publish/${encodeURIComponent(s)}/retry`, {})).status).toBe(403);
    expect((await pub.request("/api/mini/publish")).status).toBe(200);
    expect((await post(app, "/api/mini/publish/content:publish-nobody/cancel", {})).status).toBe(404);
    expect((await post(app, "/api/mini/publish/content:publish-nobody/retry", {})).status).toBe(404);
  });
});

describe("the card says where a post goes and when", () => {
  it("the card's preview carries the account and the time, and the options to look at", async () => {
    const id = "approval:pub-card";
    await addCard(h.g, { id, decided: false, at: TUESDAY, tz: "Asia/Dubai" });
    const cards = (await (await app.request("/api/mini/approvals")).json()) as Array<{ id: string; kind: string; preview?: { post?: { where: string; when?: { words: string; timeZone: string } }; media?: { options: unknown[] } } }>;
    const card = cards.find((x) => x.id === id)!;
    expect(card.kind).toBe("publish_post");
    expect(card.preview?.post).toMatchObject({ where: "Instagram (your account @cafe)", when: { words: "Tue 20 Oct, 7:00 pm", timeZone: "Asia/Dubai" } });
    expect(card.preview?.media?.options).toHaveLength(1);
  });
});

describe("GET /m/:token", () => {
  it("serves the picture of a signed address, and is a 404 for anything else", async () => {
    const url = signMediaUrl({ key: KEY, base: "https://allevia.example", now: () => NOW }, { tenant: "mini", assetId: "asset:poster-a" });
    const ok = await app.request(`/m/${url.split("/m/")[1]}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect((await app.request("/m/not-a-token")).status).toBe(404);
    const bare = h.make({});
    expect((await bare.request(`/m/${url.split("/m/")[1]}`)).status).toBe(404); // a server with no signing key serves nothing
  });
});

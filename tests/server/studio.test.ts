// The Studio API: a multipart upload streams the run back as AgentEvents; assets are served only through a tenant
// check; the last run is readable after a reload; approving writes the draft post (from the Studio card or from the
// general Approvals route); public mode and missing wiring refuse; other routes keep the 64 KB body limit.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AgentEvent } from "../../shared/contracts.js";
import { upsertNode } from "../../src/graph/upsert.js";
import type { StudioWiring } from "../../src/server/studio.js";
import { FakeEngine } from "../../src/studio/engine.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { studioSample } from "../../src/studio/wiring.js";
import { facadePhoto, nishaAnswer, TARA_ANSWER } from "../studio/fixtures.js";
import { harness, post, sseEvents, type Harness } from "./harness.js";

describe("server: studio (integration)", () => {
  let h: Harness;
  let dir: string;
  let wiring: StudioWiring;
  beforeAll(async () => {
    h = await harness();
    dir = mkdtempSync(join(tmpdir(), "allevia-studio-api-"));
    mkdirSync(join(dir, "studio-demo", "mini"), { recursive: true });
    writeFileSync(join(dir, "studio-demo", "mini", "rough.jpg"), await facadePhoto({ tilt: 4, gps: false }));
    writeFileSync(join(dir, "studio-demo", "mini", "sample.json"), JSON.stringify({ note: "the front", caption: "Demo photo: made in code." }));
    wiring = {
      deps: {
        store: new AssetStore(dir),
        vision: new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": nishaAnswer(false) }),
        engine: new FakeEngine(async (input) => sharp(input.image).modulate({ brightness: 1.3 }).jpeg().toBuffer()),
      },
      sample: (t) => studioSample(dir, t),
    };
  }, 90_000);
  afterAll(async () => {
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const upload = async (app = h.make({ studio: async () => wiring }), photo?: Buffer, note = "the front, before the garden") => {
    const form = new FormData();
    if (photo) form.append("photo", new File([new Uint8Array(photo)], "phone.jpg", { type: "image/jpeg" }));
    form.append("note", note);
    return app.request("/api/mini/studio/intake", { method: "POST", body: form });
  };

  it("streams the run, serves its assets through the tenant check, keeps it for the page, and approving writes the draft", async () => {
    const app = h.make({ studio: async () => wiring });
    const res = await upload(app, await facadePhoto({ tilt: 5 }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = sseEvents(await res.text());
    const order = events.filter((e) => ["asset", "assessment", "review", "proposal", "final"].includes(e.type)).map((e) => e.type === "asset" ? `asset:${e.kind}` : e.type);
    expect(order).toEqual(["asset:original", "assessment", "asset:variant", "asset:variant", "review", "review", "proposal", "final"]);
    const assets = events.filter((e): e is Extract<AgentEvent, { type: "asset" }> => e.type === "asset");
    const proposal = events.find((e): e is Extract<AgentEvent, { type: "proposal" }> => e.type === "proposal")!;

    // the asset proxy: full file, a smaller copy, and nothing for unknown ids, other tenants or bad storage keys
    const full = await app.request(`/api/mini/assets/${encodeURIComponent(assets[1]!.assetId)}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/jpeg");
    expect((await sharp(Buffer.from(await full.arrayBuffer())).metadata()).width).toBe(1080);
    const thumb = await app.request(assets[0]!.thumb!);
    expect((await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).width).toBe(640);
    expect((await app.request("/api/mini/assets/asset%3Anope")).status).toBe(404);
    expect((await app.request(`/api/other/assets/${encodeURIComponent(assets[0]!.assetId)}`)).status).toBe(404);
    await upsertNode(h.g, { type: "Asset", id: "asset:sneaky", name: "sneaky", props: { kind: "original", storageKey: "../../../etc/hosts" } });
    expect((await app.request("/api/mini/assets/asset%3Asneaky")).status).toBe(404);

    // the page after a reload
    const latest = await (await app.request("/api/mini/studio/latest")).json() as { run: { assetId: string; events: AgentEvent[]; approval: { id: string; status: string; contentId: string | null } } };
    expect(latest.run.assetId).toBe(assets[0]!.assetId);
    expect(latest.run.approval).toMatchObject({ id: proposal.approvalId, status: "pending", contentId: null });

    // approve variant B (Nisha passed it) with the caption as written
    const ok = await post(app, "/api/mini/studio/approve", { approvalId: proposal.approvalId, variantId: assets[2]!.assetId });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { contentId: string; status: string; approval: { status: string } };
    expect(body.status).toMatch(/^(approved|executed)$/); // executed: the content_draft executor wrote the draft
    expect(body.approval.status).toBe(body.status);
    const [row] = await h.g.roQuery<{ format: string; status: string; a: string }>(
      "MATCH (c:Content {id:$id})-[:USES_ASSET]->(a:Asset) RETURN c.format AS format, c.status AS status, a.id AS a", { id: body.contentId });
    expect(row).toEqual({ format: "post", status: "draft", a: assets[2]!.assetId });
    const after = await (await app.request("/api/mini/studio/latest")).json() as typeof latest;
    expect(after.run.approval).toMatchObject({ status: body.status, contentId: body.contentId });
    expect((await post(app, "/api/mini/studio/approve", { approvalId: proposal.approvalId })).status).toBe(409);
  }, 60_000);

  it("a Studio card approved from the general Approvals route still becomes a draft post", async () => {
    const app = h.make({ studio: async () => wiring });
    const events = sseEvents(await (await upload(app, await facadePhoto({ tilt: -2 }), "another angle")).text());
    const proposal = events.find((e): e is Extract<AgentEvent, { type: "proposal" }> => e.type === "proposal")!;
    const res = await post(app, `/api/mini/approvals/${encodeURIComponent(proposal.approvalId)}`, { decision: "approve" });
    expect(res.status).toBe(200);
    const [row] = await h.g.roQuery<{ c: number }>(
      "MATCH (:Approval {id:$id})-[:RESULTED_IN]->(:Action)-[:RESULTED_IN]->(c:Content {format:'post'}) RETURN count(c) AS c", { id: proposal.approvalId });
    expect(row!.c).toBe(1);
  }, 60_000);

  it("refuses what it should: no photo, not an image, public mode, no wiring; other routes keep the 64 KB limit", async () => {
    expect((await upload(undefined, undefined)).status).toBe(400);
    const notImage = sseEvents(await (await upload(undefined, Buffer.from("definitely not a photo"))).text());
    expect(notImage.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/not an image we can read/) });
    expect((await upload(h.make({ studio: async () => wiring, publicMode: true }), await facadePhoto())).status).toBe(403);
    expect((await upload(h.make(), await facadePhoto())).status).toBe(501);
    expect((await post(h.make({ studio: async () => wiring }), "/api/mini/ask", { question: "x".repeat(70_000) })).status).toBe(413);
  }, 60_000);

  it("serves the prepared sample photo and its honest caption", async () => {
    const app = h.make({ studio: async () => wiring });
    const s = await (await app.request("/api/mini/studio/sample")).json() as { note: string; caption: string; url: string };
    expect(s).toEqual({ note: "the front", caption: "Demo photo: made in code.", url: "/api/mini/studio/sample.jpg" });
    const img = await app.request(s.url);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect((await app.request("/api/other/studio/sample")).status).toBe(404);
  });
});

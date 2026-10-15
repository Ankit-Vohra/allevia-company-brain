// The Studio thin slice end to end on a throwaway graph, with a fake vision model and a fake generation engine:
// intake (EXIF stripped, fingerprints, AUTHORED by the owner), Tara's assessment (clamped overlays, REVIEWED), the two
// variants (DERIVED_FROM {step, treatment}, PRODUCED by Tara), Nisha's fidelity check (REVIEWED, badges, fails
// closed), Dev's caption (voice rules applied), the approval card, and what approving it writes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { approveStudioDraft, studioCard, type DecideFn } from "../../src/studio/approve.js";
import { decide } from "../../src/server/approvals.js";
import { EngineDecline, FakeEngine, RecordedEngine, recordingKey } from "../../src/studio/engine.js";
import { chooseTilt, latestStudioRun, runStudio } from "../../src/studio/pipeline.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, DEV_ANSWER, facadePhoto, nishaAnswer, NOW, OWNER, PAGE, PROJECT, seedBrand, TARA_ANSWER } from "./fixtures.js";

describe("studio pipeline (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;
  let clock = NOW;
  const now = () => (clock += 1000);

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await seedBrand(g);
    dir = mkdtempSync(join(tmpdir(), "allevia-studio-test-"));
    store = new AssetStore(dir);
  }, 60_000);
  afterAll(async () => {
    await cleanup();
    await closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  const one = async <T>(cypher: string, params?: Record<string, unknown>) => (await g.roQuery<T>(cypher, params))[0]!;
  // decisions go through the server's own path: the status change, the content_draft executor (its markdown under the temp
  // data dir) and the learning loop
  const decideWith: DecideFn = (id, edited) => decide(g, "kestrel_oak", id, { decision: "approve", ...(edited ? { editedPayload: edited } : {}) }, { now: now(), actions: { config: { dataDir: dir } } });

  it("streams asset, assessment, variant A and B, reviews, a proposal and a final; writes the graph", async () => {
    const vision = new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": nishaAnswer(true), "copy-editor": DEV_ANSWER });
    // the "generative" edit: the frame, relit, with a fake second roofline painted on (Nisha must catch it)
    const engine = new FakeEngine(async (input) => {
      const m = await sharp(input.image).metadata();
      const bar = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}"><rect x="0" y="${Math.round(m.height! * 0.1)}" width="${m.width}" height="${Math.round(m.height! * 0.08)}" fill="#3a2a1a"/></svg>`);
      return sharp(input.image).modulate({ brightness: 1.4 }).composite([{ input: bar }]).jpeg().toBuffer();
    }, { credits: 2 });
    const events: AgentEvent[] = [];
    const photo = await facadePhoto({ tilt: 5 });
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: photo, note: "Harbour House from the street, before the garden work" },
      { store, vision, engine, now, devRewrite: true }, (e) => events.push(e));

    // the event order the Studio page and the office rely on
    const key = (e: AgentEvent) => e.type === "asset" ? `asset:${e.kind}` : e.type;
    const visible = events.map(key).filter((k) => ["asset:original", "assessment", "asset:variant", "review", "proposal", "final"].includes(k));
    expect(visible).toEqual(["asset:original", "assessment", "asset:variant", "asset:variant", "review", "review", "proposal", "final"]);
    expect(events.filter((e) => e.type === "agent_start").map((e) => (e as { agent: string }).agent)).toEqual(["content-strategist", "fact-checker", "copy-editor"]);
    const assessment = events.find((e) => e.type === "assessment") as Extract<AgentEvent, { type: "assessment" }>;
    expect(assessment.verdict).toBe("enhance");
    // the off-frame box is dropped, the unknown kind becomes clutter, the rest are kept
    expect(assessment.overlays.map((o) => o.kind)).toEqual(["lock", "privacy", "clutter"]);
    const asset0 = events.find((e) => e.type === "asset") as Extract<AgentEvent, { type: "asset" }>;
    expect(asset0.thumb).toBe(`/api/kestrel_oak/assets/${encodeURIComponent(r.original.id)}?w=640`);

    // intake: stored without EXIF, fingerprinted, authored by the owner the graph names
    const file = store.path("kestrel_oak", r.original.storageKey)!;
    expect(existsSync(file)).toBe(true);
    expect((await sharp(readFileSync(file)).metadata()).exif).toBeUndefined();
    const orig = await one<Record<string, unknown>>("MATCH (a:Asset {id:$id}) RETURN properties(a) AS p", { id: r.original.id }).then((x) => (x as { p: Record<string, unknown> }).p);
    expect(orig).toMatchObject({ kind: "original", mime: "image/jpeg", source: "upload", metadataStripped: true, verdict: "enhance", subjectKind: "exterior", status: "assessed" });
    expect(orig.sha256).toBe(r.original.sha256);
    expect(orig.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(await one("MATCH (:Person {id:$o})-[:AUTHORED]->(a:Asset {id:$id}) RETURN count(a) AS c", { o: OWNER, id: r.original.id })).toEqual({ c: 1 });
    expect(await one("MATCH (:Agent {id:'agent:allevia-content-strategist'})-[r:REVIEWED]->(:Asset {id:$id}) RETURN r.verdict AS v", { id: r.original.id })).toEqual({ v: "enhance" });
    expect(await one("MATCH (:Asset {id:$id})-[:DEPICTS]->(p:Page) RETURN p.id AS p", { id: r.original.id })).toEqual({ p: PAGE });

    // the plan: the edges' tilt estimate wins over Tara's, and the crop keeps the facade and leaves the person out
    expect(r.tilt.source).toBe("edges");
    expect(r.tilt.deg).toBeGreaterThan(3.5);
    expect(r.plan.lockCovered).toBeGreaterThan(0.6);
    expect(r.plan.privacyCovered).toBe(0);

    // the variants
    expect(r.variants.map((v) => v.label)).toEqual(["A", "B"]);
    const rows = await g.roQuery<{ label: string; step: string; treatment: string; ai: boolean; iptc: string; w: number; h: number }>(
      `MATCH (v:Asset)-[d:DERIVED_FROM]->(:Asset {id:$id}) MATCH (:Agent {id:'agent:allevia-content-strategist'})-[:PRODUCED]->(v)
       RETURN v.label AS label, d.step AS step, d.treatment AS treatment, v.aiEdited AS ai, v.iptcSourceType AS iptc, v.w AS w, v.h AS h ORDER BY label, v.id`,
      { id: r.original.id });
    expect(rows.map((x) => [x.label, x.step, x.ai, x.iptc, x.w, x.h])).toEqual([
      ["A", "local-grade", false, "algorithmicallyEnhanced", 1080, 1350],
      ["B", "generative-edit", true, "compositeWithTrainedAlgorithmicMedia", 1080, 1350],
    ]);
    expect(rows[0]!.treatment).toMatch(/straighten -[\d.]+°.*crop 4:5.*white balance toward #f4f1ea/);

    // the prompt came from the graph: brand palette, the locks, the fidelity rules
    const prompt = engine.prompts[0]!;
    expect(prompt).toMatch(/LOCK: Keep exactly as they are: seven windows, evenly spaced; the dark roofline band\./);
    expect(prompt).toContain("Do not add, remove or alter architectural elements");
    expect(prompt).toContain("Never change the number of windows.");
    expect(prompt).toContain("#f4f1ea, #6b6457, #a8542e, #191714");
    expect(prompt).toContain("the Harbour House project");
    expect(prompt).toMatch(/NEGATIVES: No text/);

    // Nisha: A passes, B (with the invented roofline) is held back, both REVIEWED
    expect(r.fidelity.map((f) => [f.label, f.badge])).toEqual([["A", "unchanged"], ["B", "changed"]]);
    expect(r.fidelity[0]!.note).toMatch(/^Building unchanged/);
    expect(r.fidelity[1]!.note).toBe("Changed: added a second roofline");
    expect(r.fidelity[0]!.structure).toBeGreaterThan(0.8);
    const reviews = events.filter((e) => e.type === "review") as Array<Extract<AgentEvent, { type: "review" }>>;
    expect(reviews.map((e) => [e.agent, e.verdict])).toEqual([["fact-checker", "ok"], ["fact-checker", "reject"]]);
    expect(await one("MATCH (:Agent {id:'agent:allevia-fact-checker'})-[r:REVIEWED]->(:Asset) RETURN count(r) AS c")).toEqual({ c: 2 });

    // Dev: the voice rules applied (no "Nestled", no "seamlessly", no "!"), hashtags tidied
    expect(r.caption.by).toBe("dev-model");
    expect(r.caption.caption).not.toMatch(/nestled|seamlessly|!/i);
    expect(r.caption.edits.join("; ")).toMatch(/Nestled → /);
    expect(r.caption.hashtags).toEqual(["#bristolarchitecture", "#victorianterrace"]);
    // Dev saw the post he captioned (variant A, the one that passed)
    expect(vision.calls.find((c) => c.agent === "copy-editor")!.images).toHaveLength(1);

    // the card: pending, recommending A (B failed), 1 credit
    const card = (await studioCard(g, r.approvalId))!;
    expect(card.status).toBe("pending");
    expect(card.payload.studio.recommended).toBe(r.variants[0]!.id);
    expect(card.payload.studio.credits).toBe(1);
    expect(card.payload.studio.pageId).toBe(PAGE);
    expect(card.payload.body).toContain(r.caption.caption);
    const proposal = events.find((e) => e.type === "proposal") as Extract<AgentEvent, { type: "proposal" }>;
    expect(proposal).toMatchObject({ agent: "content-strategist", approvalId: r.approvalId, kind: "content_draft" });

    // the run is kept for the page
    const latest = (await latestStudioRun(g))!;
    expect(latest.assetId).toBe(r.original.id);
    expect(latest.events.map((e) => e.type)).toEqual(events.map((e) => e.type));

    // approving: a "changed" variant is refused, then A with an edited caption writes the draft
    await expect(approveStudioDraft(g, { approvalId: r.approvalId, variantId: r.variants[1]!.id, now: now() }, decideWith)).rejects.toThrow(/held variant B back/);
    const edited = "Harbour House, from the street.\n\nBristol";
    const ok = await approveStudioDraft(g, { approvalId: r.approvalId, variantId: r.variants[0]!.id, caption: edited, now: now() }, decideWith);
    expect(ok.status).toMatch(/^(edited|executed)$/);
    const content = await one<{ p: Record<string, unknown> }>("MATCH (c:Content {id:$id}) RETURN properties(c) AS p", { id: ok.contentId });
    expect(content.p).toMatchObject({ format: "post", status: "draft", caption: edited, channel: "instagram" });
    expect(await one("MATCH (:Content {id:$c})-[:USES_ASSET]->(a:Asset) RETURN a.id AS a", { c: ok.contentId })).toEqual({ a: r.variants[0]!.id });
    expect(await one("MATCH (:Asset {id:$a})-[:DEPICTS]->(p:Page) RETURN p.id AS p", { a: r.variants[0]!.id })).toEqual({ p: PAGE });
    expect(await one("MATCH (:Approval {id:$id})-[:RESULTED_IN]->(:Action)-[:RESULTED_IN]->(c:Content) RETURN c.id AS c", { id: r.approvalId })).toEqual({ c: ok.contentId });
    expect(await one("MATCH (:Content {id:$c})-[:PROMOTES]->(p:Content) RETURN p.id AS p", { c: ok.contentId })).toEqual({ p: PROJECT });
    const obs = await g.roQuery<{ metric: string; value: number; unit: string }>(
      "MATCH (o:Observation)-[:MEASURES]->(:Content {id:$c}) RETURN o.metric AS metric, o.value AS value, o.unit AS unit ORDER BY metric, o.id", { c: ok.contentId });
    expect(obs).toEqual([{ metric: "credits_charged", value: 1, unit: "credits" }, { metric: "usd_cost", value: 0.5, unit: "USD" }]);
    const statuses = await g.roQuery<{ label: string | null; status: string }>(
      "MATCH (a:Asset) WHERE a.id IN $ids RETURN a.label AS label, a.status AS status ORDER BY label, a.id", { ids: [r.original.id, ...r.variants.map((v) => v.id)] });
    expect(statuses.map((s) => s.status).sort()).toEqual(["approved", "declined", "used"]);
    // decided once
    await expect(approveStudioDraft(g, { approvalId: r.approvalId, now: now() }, decideWith)).rejects.toThrow(/already decided/);
  }, 60_000);

  it("RecordedEngine replays a recording by original + treatment; without one there is no variant B, never a fake", async () => {
    const recDir = join(dir, "recorded");
    mkdirSync(recDir, { recursive: true });
    const photo = await facadePhoto({ tilt: -3, gps: false });
    const vision = new FakeVision({ "content-strategist": { ...TARA_ANSWER, quality: { ...TARA_ANSWER.quality, tiltDeg: -3 } }, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const empty = new RecordedEngine(join(recDir, "manifest.json"));
    const events: AgentEvent[] = [];
    const r1 = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: photo, note: "street view" }, { store, vision, engine: empty, now }, (e) => events.push(e));
    expect(r1.variants.map((v) => v.label)).toEqual(["A"]);
    // no Dev rewrite configured: Tara's draft, held to the voice rules and the brand's don'ts in code (no model call)
    expect(vision.calls.map((c) => c.agent)).toEqual(["content-strategist", "fact-checker"]);
    expect(r1.caption.by).toBe("tara-draft");
    expect(r1.caption.caption).toBe("Seven tall windows let the afternoon in.\n\nHarbour House, Bristol");
    expect(r1.caption.edits.join("; ")).toMatch(/hard sell.*negative-parallelism|negative-parallelism.*hard sell|hard sell/);
    expect(r1.caption.altText).toBe(TARA_ANSWER.altText);
    expect(events.some((e) => e.type === "agent_status" && /No generative edit for this photo yet/.test(e.text))).toBe(true);
    expect(r1.context.project).toBeNull();

    // record an edit for this photo, and the next run uses it
    // an engine that reframes: the relit photo on a taller canvas (more sky), as image models return it
    const relit = await sharp(photo).modulate({ brightness: 1.3 }).extend({ top: 160, background: "#c9c2b8" }).jpeg().toBuffer();
    writeFileSync(join(recDir, "b.jpg"), relit);
    writeFileSync(join(recDir, "manifest.json"), JSON.stringify({ recordings: [{
      key: recordingKey(r1.original.sha256, "relight-clean-editorial"), file: "b.jpg", engine: "higgsfield", model: "test-edit-model",
      prompt: "the prompt it was made with", jobId: "job-test-1", credits: 2, createdAt: "2026-10-15T08:00:00Z",
    }, { key: "x:y", file: "../../escape.jpg", engine: "higgsfield", model: "m", prompt: "p", createdAt: "2026-10-15T08:00:00Z" }] }));
    const recorded = new RecordedEngine(join(recDir, "manifest.json"));
    const r2 = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: photo, note: "street view" }, { store, vision, engine: recorded, now }, () => undefined);
    expect(r2.original.id).toBe(r1.original.id); // the same photo is the same Asset
    expect(r2.variants.map((v) => v.label)).toEqual(["A", "B"]);
    const b = await one<{ p: Record<string, unknown> }>("MATCH (a:Asset {id:$id}) RETURN properties(a) AS p", { id: r2.variants[1]!.id });
    expect(b.p).toMatchObject({ source: "higgsfield", recorded: true, hfJobId: "job-test-1", hfCredits: 2, model: "test-edit-model", prompt: "the prompt it was made with" });
    expect(String(b.p.graphPrompt)).toMatch(/^Edit this photo of/);
    // a manifest entry pointing outside its directory is never read
    expect(await recorded.edit({ image: Buffer.alloc(0), mime: "image/jpeg", originalSha256: "x" }, "", { treatment: "y", aspect: "4:5" })).toBeNull();
    // the re-run reuses the pending card instead of stacking a second one
    expect(r2.approvalId).toBe(r1.approvalId);
  }, 60_000);

  it("fails closed: when Nisha's look cannot run, every variant is 'unchecked' and none is recommended as passed", async () => {
    const vision = new FakeVision({ "content-strategist": TARA_ANSWER, "copy-editor": DEV_ANSWER }); // no answer for Nisha: it throws
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await facadePhoto({ tilt: 2 }), note: "" },
      { store, vision, engine: { name: "declining", edit: async () => { throw new EngineDecline("not-logged-in", "The AI editor isn't signed in right now, so I made the simple clean-up only."); } }, now }, () => undefined);
    expect(r.variants.map((v) => v.label)).toEqual(["A"]); // the engine declines; B is skipped, the run goes on
    expect(r.fidelity.map((f) => f.badge)).toEqual(["unchecked"]);
    const card = (await studioCard(g, r.approvalId))!;
    expect(card.payload.studio.variants[0]!.badge).toBe("unchecked");
    await expect(approveStudioDraft(g, { approvalId: r.approvalId, now: now() }, decideWith)).rejects.toThrow(/held variant A back/);
  }, 60_000);

  it("chooseTilt trusts confident edges, falls back to Tara, and calls a small angle level", () => {
    expect(chooseTilt({ deg: 5.2, confidence: 0.2 }, 3)).toEqual({ deg: 5.2, source: "edges" });
    expect(chooseTilt({ deg: 5.2, confidence: 0.02 }, 3)).toEqual({ deg: 3, source: "tara" });
    expect(chooseTilt({ deg: 0.1, confidence: 0.5 }, 4)).toEqual({ deg: 0, source: "level" });
    expect(chooseTilt({ deg: 14, confidence: 0.5 }, 0.2)).toEqual({ deg: 0, source: "level" });
  });
});

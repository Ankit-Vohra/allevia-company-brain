// Honest status and failures, as one table: whatever is missing (the image engine, its login, its credits, the request's
// credit limit, the checker, the logo file, the brand fonts), the owner still gets what can be made and is told exactly what
// was not, in plain words. Never a fake result.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePoster, type PosterRequest } from "../../src/creative/poster.js";
import type { CreativeDeps } from "../../src/creative/ports.js";
import { studioEngineAdapter } from "../../src/creative/wiring.js";
import { RecordedEngine } from "../../src/studio/engine.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, FakeCreativeEngine, fakeVisionFor, NOW, seedKit, TENANT } from "./helpers.js";

describe("honest status and failures", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let store: AssetStore;
  let dir: string;
  let n = 0;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    dir = mkdtempSync(join(tmpdir(), "allevia-honest-"));
    store = new AssetStore(dir);
    await seedKit(g, store, { logo: false, fonts: false });
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); rmSync(dir, { recursive: true, force: true }); });

  const req = (): PosterRequest => ({
    tenant: TENANT, businessId: BIZ, agentId: "chief-of-staff", turnId: `h${++n}`, now: NOW + n * 1000, question: "a poster for Insta with my logo",
    content: { headline: "Open studio on Saturday" }, format: "insta_square", occasion: "announcement", count: 2, scenes: ["a sunlit studio table"], artwork: "generate",
  });
  const deps = (engine: CreativeDeps["engine"], vision = fakeVisionFor()): CreativeDeps => ({ store, vision, engine, maxCreditsPerRequest: 10, spent: { credits: 0 } });
  const down = (reason: "no_cli" | "not_signed_in" | "no_credits", plain: string) => { const e = new FakeCreativeEngine(); e.statusNow = { ok: false, reason, plain }; return e; };

  const cases: Array<[string, () => CreativeDeps, RegExp]> = [
    ["no engine on the server", () => deps(null), /Pictures aren't switched on yet, so these use a plain background in your brand colours\./],
    ["the Studio engine cannot draw from a description yet", () => deps(studioEngineAdapter(new RecordedEngine("/nonexistent/manifest.json"))), /Pictures aren't switched on yet, so these use a plain background/],
    ["the CLI is not installed", () => deps(down("no_cli", "pictures aren't switched on yet")), /Pictures aren't switched on yet, so these use a plain background/],
    ["not signed in", () => deps(down("not_signed_in", "the Higgsfield account isn't signed in")), /isn't signed in/],
    ["no credits", () => deps(down("no_credits", "there are no Higgsfield credits left")), /no Higgsfield credits left/],
    ["over the request's credit limit", () => { const e = new FakeCreativeEngine(); e.cost = 50; return deps(e); }, /more credits than this request is allowed/],
    ["the checker is down", () => deps(new FakeCreativeEngine(), new FakeVision({})), /couldn't double-check/],
  ];
  for (const [name, mk, said] of cases) {
    it(`${name}: still delivers, and says so`, async () => {
      const r = await makePoster(g, req(), mk());
      expect(r.saved.options.length).toBeGreaterThan(0);
      expect(r.notes.join(" ")).toMatch(said);
      // no logo file and no font files: said too, and the poster still has the name and a fallback font
      expect(r.notes.join(" ")).toMatch(/don't have a logo file/);
      expect(r.notes.join(" ")).toMatch(/set in Inter/);
    }, 60_000);
  }

  it("the adapter never pretends: no quote, no picture, a plain reason", async () => {
    const a = studioEngineAdapter(new RecordedEngine("/nonexistent/manifest.json"));
    expect(await a.status()).toMatchObject({ ok: false, reason: "off" });
    expect(await a.quote({ prompt: "x", aspect: "1:1" })).toBeNull();
    await expect(a.generate({ prompt: "x", aspect: "1:1" })).rejects.toThrow(/^pictures aren't switched on yet$/);
  });
});

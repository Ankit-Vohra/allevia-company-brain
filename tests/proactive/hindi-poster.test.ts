// Hindi on posters: the poster's words are checked against the brand's fonts and the font files in its brand library
// before anything is paid for; a Devanagari font from the library (Mukta here) sets Hindi words, and the stand-up asks for
// the headline in the post's own language, falling back to English only when nothing can set it.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadComposeKit, pairCovers } from "../../src/creative/kit.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import type { Picked } from "../../src/proactive/choose.js";
import { draftPick, type Drafters, type PosterJob, type TextJob } from "../../src/proactive/draft.js";
import { standupFontCheck } from "../../src/proactive/wiring.js";
import { sha256Hex } from "../../src/studio/image.js";
import { AssetStore } from "../../src/studio/store.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, NOW, seedKit, TENANT } from "../creative/helpers.js";

const HINDI = "दशहरा की शुभकामनाएँ";
let g: GraphHandle;
let cleanup: () => Promise<void>;
let dir: string;
let store: AssetStore;

beforeAll(async () => {
  ({ g, cleanup } = await testGraph());
  dir = mkdtempSync(join(tmpdir(), "allevia-hindi-"));
  store = new AssetStore(dir);
  await seedKit(g, store, { logo: false });
}, 60_000);
afterAll(async () => {
  await cleanup();
  await closeAll();
  rmSync(dir, { recursive: true, force: true });
});

const addMukta = async () => {
  for (const weight of [400, 700]) {
    const bytes = readFileSync(`tests/fixtures/fonts/Mukta-${weight}.ttf`);
    const sha = sha256Hex(bytes);
    const key = store.put(TENANT, sha, bytes, "ttf");
    await upsertNode(g, { type: "BrandAsset", id: `brand-asset:font-file-mukta-${weight}`, name: `Mukta ${weight} (font file)`, props: { kind: "font", family: "Mukta", weight, mime: "font/ttf", storageKey: key, sha256: sha, origin: "upload", status: "active" } }, NOW);
  }
};

const pick: Picked = {
  key: "season:dussehra-test", kind: "poster", source: "season", agent: "content-strategist", title: "A Dussehra post with a poster", reason: "Dussehra is soon.", why: "Dussehra is soon.",
  brief: "Purpose: be there.", purpose: "Purpose: be there.", facts: [], skill: { agent: "content-strategist", id: "instagram-post" }, evidence: [], goals: [], score: 0.5,
  occasion: { name: "Dussehra", date: "2026-10-20" },
};

function drafters(headlines: string[], covers: Drafters["covers"]): Drafters & { posters: PosterJob[]; asked: TextJob[] } {
  const posters: PosterJob[] = [], asked: TextJob[] = [];
  return {
    posters, asked, covers,
    async text(job) { asked.push(job); return { ok: true, text: job.kind === "headline" ? headlines.shift() ?? "Happy Dussehra" : "दशहरा की बधाई।", hashtags: [], warnings: [] }; },
    async poster(job) {
      posters.push(job);
      await upsertNode(g, { type: "Recommendation", id: "recommendation:made-hindi", name: "Poster", props: { status: "open" } }, job.now);
      await upsertNode(g, { type: "Approval", id: "approval:made-hindi", name: "content_draft: Poster", props: { status: "pending", kind: "content_draft", title: "Poster", payload: "{}" } }, job.now);
      return { approvalId: "approval:made-hindi", recommendationId: "recommendation:made-hindi", hfCredits: 0, notes: [] };
    },
  };
}

const ctx = (d: Drafters) => ({ tenant: TENANT, businessId: BIZ, businessName: "Kestrel & Oak", now: NOW, turnId: "standup-test", drafters: d, paidLeft: 1 });

describe("Hindi on posters", () => {
  it("without a Devanagari font in the library the Hindi headline is not settable, so it is asked again in English before anything is paid", async () => {
    const check = standupFontCheck(g, { store });
    expect(await check({ tenant: TENANT, businessId: BIZ, texts: [HINDI], now: NOW })).toBe(false);
    expect(await check({ tenant: TENANT, businessId: BIZ, texts: ["Happy Dussehra"], now: NOW })).toBe(true);
    const d = drafters([HINDI, "Happy Dussehra"], check);
    const item = await draftPick(g, { ...pick, key: "season:dussehra-test-1" }, ctx(d));
    expect(d.asked.filter((t) => t.kind === "headline").map((t) => /English/.test(t.brief))).toEqual([false, true]);
    expect(d.posters[0]).toMatchObject({ headline: "Happy Dussehra", paid: true });
    expect(item.status).toBe("drafted");
  });

  it("with Mukta in the brand library, Hindi words are set in it and the poster keeps the Hindi headline", async () => {
    await addMukta();
    const kit = await loadComposeKit(g, BIZ, { store, tenant: TENANT, businessId: BIZ, now: NOW, cover: [HINDI, "Dussehra"] });
    expect(pairCovers(kit.brand.heading, [HINDI])).toBe(true);
    expect(kit.notes.join(" ")).toMatch(/set in Mukta from your brand library/);
    const plain = await loadComposeKit(g, BIZ, { store, tenant: TENANT, businessId: BIZ, now: NOW, cover: ["Happy Dussehra"] });
    expect(plain.notes.join(" ")).not.toMatch(/Mukta/); // the brand font stays when it has every letter

    const d = drafters([HINDI], standupFontCheck(g, { store }));
    await draftPick(g, { ...pick, key: "season:dussehra-test-2" }, ctx(d));
    expect(d.asked.filter((t) => t.kind === "headline")).toHaveLength(1);
    expect(d.posters[0]!.headline).toBe(HINDI);
  });
});

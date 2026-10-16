// The stand-up's wiring: the morning schedule, the API (run now, read today's), and the production writer held to the
// business's voice and record. Test-only FalkorDB; FakeVision stands in for Claude, fake drafters for the creating tools.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertNode } from "../../src/graph/upsert.js";
import { FakeVision } from "../../src/studio/vision.js";
import { runStandup, type Standup } from "../../src/proactive/standup.js";
import { localHour, standupHourFromEnv, standupsDue } from "../../src/proactive/schedule.js";
import { standupTextDrafter, skillsFor } from "../../src/proactive/wiring.js";
import type { Drafters } from "../../src/proactive/draft.js";
import { writeBrief } from "../../src/insights/brief.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { harness, post, TENANT, type Harness } from "../server/harness.js";

const NOW = SEED_NOW + 3_600_000; // the harness clock: 2026-10-15 06:30 in Raipur
const drafters: Drafters = { async text(job) { return { ok: true, text: `Draft ${job.kind} for ${job.agent}`, hashtags: [], warnings: [] }; } };

let h: Harness;
beforeAll(async () => {
  h = await harness();
  // a festival is coming: the stand-up has something worth doing
  await upsertNode(h.g, { type: "Business", id: TENANT.businessId, name: "Aamdani", props: { city: "Raipur", industry: "jobs" } }, SEED_NOW);
}, 90_000);
afterAll(async () => h.cleanup());

describe("the morning schedule", () => {
  it("reads the hour in the business's own time zone", () => {
    expect(localHour(Date.parse("2026-10-15T02:40:00Z"), "Asia/Kolkata")).toBe(8);
    expect(localHour(Date.parse("2026-10-15T02:40:00Z"), "Europe/London")).toBe(3);
    expect(standupHourFromEnv({ ALLEVIA_STANDUP_HOUR: "7" })).toBe(7);
    expect(standupHourFromEnv({ ALLEVIA_STANDUP_HOUR: "x" })).toBe(8);
  });

  it("runs a business once its morning has come, once a day", async () => {
    const ran: string[] = [];
    const deps = {
      tenants: async () => [{ slug: "mini", businessId: TENANT.businessId, timeZone: "Asia/Kolkata" }],
      openGraph: async () => h.g,
      run: async (t: { slug: string }) => { ran.push(t.slug); await runStandup(t.slug, { graph: h.g, now: Date.parse("2026-10-15T03:00:00Z"), drafters }); },
    };
    expect(await standupsDue({ ...deps, now: () => Date.parse("2026-10-15T01:00:00Z") })).toEqual([]); // 06:30 in Raipur
    expect(await standupsDue({ ...deps, now: () => Date.parse("2026-10-15T03:00:00Z") })).toEqual(["mini"]); // 08:30
    expect(await standupsDue({ ...deps, now: () => Date.parse("2026-10-15T05:00:00Z") })).toEqual([]); // already met today
    expect(ran).toEqual(["mini"]);
  });
});

describe("the API", () => {
  it("POST /standup/run runs it now and GET /standup serves today's; public mode refuses the run", async () => {
    const app = h.make({
      standup: async (slug, g) => {
        const standup = await runStandup(slug, { graph: g, now: NOW, drafters, force: true });
        return { standup, brief: await writeBrief(slug, { graph: g, now: NOW }) };
      },
    });
    const r = await app.request("/api/mini/standup/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status, await r.clone().text()).toBe(200);
    const body = (await r.json()) as { standup: Standup; brief: { text: string } };
    expect(body.brief.text).toContain(body.standup.heading);
    const got = await app.request("/api/mini/standup");
    expect(got.status).toBe(200);
    expect(((await got.json()) as Standup).id).toBe(body.standup.id);
    expect((await h.app.request("/api/mini/standup/run", { method: "POST" })).status).toBe(501);
    expect((await post(h.make({ publicMode: true }), "/api/mini/standup/run", {})).status).toBe(403);
    expect((await app.request("/api/mini/standup?date=2020-01-01")).status).toBe(404);
  });
});

describe("the production writer", () => {
  it("writes as the person who owns the job, with their skill, and flags claims our record does not hold", async () => {
    const vision = new FakeVision({ "ops-manager": { text: "Hi Ravi, thank you! We are rated the best in Raipur. Call us on 98765 43210.", hashtags: ["x"] } });
    const skills = await skillsFor(h.g);
    const skill = skills!("ops-manager", "follow-up-drafts");
    expect(skill?.guidance.length).toBeGreaterThan(100);
    const text = standupTextDrafter(h.g, TENANT.businessId, vision);
    const d = await text({ agent: "ops-manager", kind: "reply", brief: "Purpose: show we listen. Draft a reply to Ravi.", facts: ["Review text: nobody called back"], question: "Reply to Ravi", ...(skill ? { skill } : {}) });
    expect(d.ok).toBe(true);
    expect(d.text).not.toContain("!");
    expect(d.hashtags).toEqual([]); // a reply has none
    expect(d.warnings.join(" ")).toMatch(/not in our record/);
    expect(vision.calls[0]!.system).toContain("Vikram");
    expect(vision.calls[0]!.system).toContain(skill!.name);
  });

  it("keeps Hindi hashtags whole (vowel signs are part of the word)", async () => {
    const text = standupTextDrafter(h.g, TENANT.businessId, new FakeVision({ "content-strategist": { text: "दशहरा की शुभकामनाएं।", hashtags: ["नौकरी", "#दशहरा"] } }));
    expect((await text({ agent: "content-strategist", kind: "post", brief: "Purpose: x.", facts: [], question: "x" })).hashtags).toEqual(["#नौकरी", "#दशहरा"]);
  });

  it("says plainly when the writer cannot run", async () => {
    const text = standupTextDrafter(h.g, TENANT.businessId, new FakeVision({}));
    expect(await text({ agent: "content-strategist", kind: "post", brief: "Purpose: x.", facts: [], question: "x" })).toMatchObject({ ok: false, why: "the writer could not run just now" });
  });
});

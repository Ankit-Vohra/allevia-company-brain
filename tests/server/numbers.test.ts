// "Add your numbers" over HTTP: the preview says what it found in plain words, the import writes it, and the goal that
// said "We'll know after your first full week" reads a number. Uploads bypass the 64 KB body limit but have their own.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProgramScorecard } from "../../shared/contracts.js";
import { ensureAgentNode } from "../../src/actions/shared.js";
import type { ImportResult } from "../../src/connectors/upload/import.js";
import type { Preview } from "../../src/connectors/upload/types.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { templateFor } from "../../src/onboard/templates.js";
import { baselinesWrite, programAndGoalsWrite, programGoals } from "../../src/program/program.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { harness, TENANT, type Harness } from "./harness.js";

vi.setConfig({ testTimeout: 90_000 }); // a loaded suite needs room

const NOW = SEED_NOW + 3_600_000; // the harness clock: 15 Oct 2026, 05:30 in India
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// fourteen days of signups, 1 to 14 Oct
const csv = (rows = 14, extra = "") => ["Date,Signups,Spend note", ...Array.from({ length: rows }, (_, i) => `${iso(Date.UTC(2026, 9, 1) + i * DAY)},${10 + i},ok${extra}`)].join("\n");

const form = (file: Buffer | string, name = "signups.csv", plan?: unknown): FormData => {
  const f = new FormData();
  f.set("file", new File([typeof file === "string" ? Buffer.from(file) : new Uint8Array(file)], name));
  if (plan !== undefined) f.set("plan", typeof plan === "string" ? plan : JSON.stringify(plan));
  return f;
};

describe("server: add your numbers (integration)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    for (const o of ["growth-marketer", "content-strategist", "data-analyst"]) await ensureAgentNode(h.g, o, NOW);
    const p = await programAndGoalsWrite(h.g, { slug: "mini", businessId: TENANT.businessId, businessName: "Aamdani", template: templateFor("jobs"), now: NOW - 14 * DAY, startDate: "2026-10-01", timeZone: "Asia/Kolkata" });
    expect((await writeBatch(h.g, p.write, NOW)).errors).toEqual([]);
    const b = await baselinesWrite(h.g, { goals: await programGoals(h.g, p.program), businessId: TENANT.businessId, today: "2026-10-01" });
    expect((await writeBatch(h.g, b.write, NOW)).errors).toEqual([]);
  }, 90_000);
  afterAll(async () => h.cleanup());

  const preview = async (body: FormData, app = h.app) => app.request("/api/mini/numbers/preview", { method: "POST", body });
  const goals = async () => ((await (await h.app.request("/api/mini/program")).json()) as ProgramScorecard).goals;

  it("previews in plain words, with our guess for each column and the goal it would fill in", async () => {
    const res = await preview(form(csv()));
    expect(res.status, await res.clone().text()).toBe(200);
    const p = (await res.json()) as Preview;
    expect(p.headline).toBe("This looks like daily signups, from 1 Oct to 14 Oct. OK?");
    expect(p.columns.map((c) => [c.letter, c.header, c.guess.metric])).toEqual([["B", "Signups", "new_accounts"]]);
    expect(p.leftOut).toEqual([{ index: 2, header: "Spend note", reason: "not numbers" }]);
    expect(p.feedsGoals).toEqual([{ id: "goal:weekly-signups", name: "Weekly signups" }]);
    expect(p.questions).toEqual([]);
    // nothing was written by a preview
    expect(await h.g.roQuery<{ c: number }>("MATCH (o:Observation {metric:'new_accounts'}) RETURN count(o) AS c")).toEqual([{ c: 0 }]);
  });

  it("imports the confirmed plan: the goal reads a number and where it started is fixed from the file", async () => {
    const p = (await (await preview(form(csv()))).json()) as Preview;
    const res = await h.app.request("/api/mini/numbers/import", { method: "POST", body: form(csv(), "signups.csv", p.plan) });
    expect(res.status, await res.clone().text()).toBe(200);
    const r = (await res.json()) as ImportResult;
    expect(r).toMatchObject({ status: "imported", written: 14, from: "2026-10-01", to: "2026-10-14" });
    expect(r.sentences[0]).toBe("Added signups for 14 days, 1 Oct to 14 Oct 2026.");
    const g = (await goals()).find((x) => x.metricKey === "new_accounts")!;
    // the last 7 complete days are 8 to 14 Oct: 17 + 18 + ... + 23
    expect(g).toMatchObject({ current: 17 + 18 + 19 + 20 + 21 + 22 + 23, currentAt: "2026-10-14", baselineConf: "reported", status: expect.not.stringMatching(/no_data/) });
    // started: the 7 days that ended on or before the day it joined (1 Oct) do not exist in the file, so the newest week is its starting point
    expect(g.baseline).toBe(17 + 18 + 19 + 20 + 21 + 22 + 23);
    expect(r.goals.find((x) => x.id === "goal:weekly-signups")).toMatchObject({ newlyMeasured: true });
    const list = (await (await h.app.request("/api/mini/numbers")).json()) as { uploads: Array<{ fileName: string; rows: number; replaced: boolean }> };
    expect(list.uploads).toEqual([expect.objectContaining({ fileName: "signups.csv", rows: 14, replaced: false })]);
  });

  it("sending the same file again says so and changes nothing", async () => {
    const p = (await (await preview(form(csv()))).json()) as Preview;
    const res = await h.app.request("/api/mini/numbers/import", { method: "POST", body: form(csv(), "signups.csv", p.plan) });
    expect(((await res.json()) as ImportResult).status).toBe("already_added");
  });

  it("takes a file well over the 64 KB body limit, and refuses one over 20 MB", async () => {
    const big = csv(3000).replace(/ok/g, "okokokokokokokokokokokokokokokokok");
    expect(big.length).toBeGreaterThan(64 * 1024);
    expect((await preview(form(big))).status).toBe(200);
    const huge = Buffer.alloc(21 * 1024 * 1024, 0x61);
    const res = await preview(form(huge));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/under 20 MB/);
  });

  it("answers in plain sentences when the file or the plan is wrong", async () => {
    const noFile = await h.app.request("/api/mini/numbers/preview", { method: "POST", body: new FormData() });
    expect(noFile.status).toBe(400);
    const noDate = await preview(form("Product,Price\nTea,3\nCoffee,4\n"));
    expect(noDate.status).toBe(400);
    expect(((await noDate.json()) as { error: string }).error).toMatch(/couldn't find a date/);
    const personal = await preview(form("Date,Customer email,Orders\n2026-10-01,a@example.com,1\n2026-10-02,b@example.com,2\n"));
    expect(personal.status).toBe(400);
    expect(((await personal.json()) as { error: string }).error).toMatch(/Customer email/);
    const badPlan = await h.app.request("/api/mini/numbers/import", { method: "POST", body: form(csv(), "x.csv", "not json") });
    expect(badPlan.status).toBe(400);
    const unanswered = await h.app.request("/api/mini/numbers/import", { method: "POST", body: form(csv(), "x.csv", { dateColumn: 0, dateOrder: "dmy", cadence: "day", weekAnchor: "start", columns: [{ index: 1, metric: null }] }) });
    expect(unanswered.status).toBe(400);
    expect(((await unanswered.json()) as { error: string }).error).toMatch(/Tell us what column B/);
  });

  it("is refused in public mode, and unknown businesses are a 404", async () => {
    const pub = h.make({ publicMode: true });
    expect((await preview(form(csv()), pub)).status).toBe(403);
    expect((await h.app.request("/api/nobody/numbers/preview", { method: "POST", body: form(csv()) })).status).toBe(404);
  });
});

// The first customer data path, end to end on a throwaway graph: a clinic that onboarded from its website (goals read
// "We'll know after your first full week") drops a spreadsheet of weekly numbers and the goals read real numbers, with
// where it started fixed from the file. Provenance, idempotence, corrections, connectors, privacy, isolation and caps.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, openGraphByName, type GraphHandle } from "../../../src/graph/client.js";
import { businessId as bizIdOf } from "../../../src/graph/tenants.js";
import { upsertNode, writeBatch } from "../../../src/graph/upsert.js";
import { importNumbers, UPLOAD_CONF, type ImportResult } from "../../../src/connectors/upload/import.js";
import { previewTable } from "../../../src/connectors/upload/analyse.js";
import { MAX_VALUES } from "../../../src/connectors/upload/limits.js";
import { readTable } from "../../../src/connectors/upload/table.js";
import type { UploadPlan } from "../../../src/connectors/upload/types.js";
import { scanGraph } from "../../../src/ingest/privacy.js";
import { onboard } from "../../../src/onboard/onboard.js";
import { getProgram } from "../../../src/program/scorecard.js";
import { testGraph } from "../../helpers/graph.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-15T09:00:00Z");           // 10:00 in London
const ENROLLED = NOW - 21 * DAY;                           // the clinic joined on 24 Sep
const MONDAY = Date.UTC(2026, 6, 6);                       // 6 Jul 2026

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// Fourteen weeks from 6 Jul; the last one (5 to 11 Oct) closed before today.
const weeklyCsv = (over: Record<number, number> = {}, skip: number[] = []): string =>
  ["Week starting,Enquiries,Phone calls", ...Array.from({ length: 14 }, (_, i) => i)
    .filter((i) => !skip.includes(i)).map((i) => `${iso(MONDAY + i * 7 * DAY)},${over[i] ?? 10 + i},${4 + i}`)].join("\n");

async function planFor(csv: string, name = "numbers.csv"): Promise<{ bytes: Buffer; plan: UploadPlan }> {
  const bytes = Buffer.from(csv);
  const p = previewTable(readTable(bytes, name), { fileName: name, fileHash: "x", country: "GB" });
  expect(p.questions).toEqual([]);
  return { bytes, plan: p.plan };
}

describe("spreadsheet upload (integration)", () => {
  let g: GraphHandle;
  let other: GraphHandle;
  let cleanup: () => Promise<void>;
  let cleanupOther: () => Promise<void>;
  let slug: string;
  let biz: string;
  let metaGraph: string;

  const q = <T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);
  const upload = async (csv: string, name = "numbers.csv", at = NOW): Promise<ImportResult> => {
    const { bytes, plan } = await planFor(csv, name);
    return importNumbers({ g, businessId: biz, fileName: name, bytes, plan, now: at });
  };
  const count = async (cypher: string, params: Record<string, unknown> = {}) => (await q<{ c: number }>(cypher, params))[0]!.c;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    ({ g: other, cleanup: cleanupOther } = await testGraph());
    await upsertNode(other, { type: "Business", id: "business:other-shop", name: "Other Shop" }, ENROLLED); // another tenant, its own graph
    slug = g.name.replace(/^allevia_/, "");
    biz = bizIdOf(slug);
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    await upsertNode(g, { type: "Business", id: biz, name: "Kestrel Dental" }, ENROLLED);
    await onboard({ name: "Kestrel Dental", slug, website: false, industry: "dental clinic", country: "United Kingdom", domain: "kestrel.example" }, () => undefined,
      { tenantOpts: { metaGraph }, now: () => ENROLLED, dataDir: `/tmp/${slug}-unused`, model: "haiku" });
  }, 90_000);

  afterAll(async () => {
    await cleanup();
    await cleanupOther();
    await (await openGraphByName(metaGraph)).drop().catch(() => undefined);
    await closeAll();
  });

  it("before the file: every goal waits, nothing is measured, the capability is not connected", async () => {
    const p = (await getProgram(g, { now: NOW, businessId: biz }))!;
    expect(p.goals.map((x) => [x.name, x.baseline, x.current, x.status])).toEqual([
      ["New booking enquiries per month", null, null, "no_data"], ["Search clicks", null, null, "no_data"], ["Calls and directions from Google", null, null, "no_data"],
    ]);
    expect(p.goals.every((x) => x.baselineConf === "unknown")).toBe(true);
    expect(p.capabilities.items.find((c) => c.key === "gbp")?.accessMode).not.toBe("upload");
  });

  it("imports a weekly file: a goal flips to a real reading and where it started is fixed from the file", async () => {
    const r = await upload(weeklyCsv(), "Kestrel numbers.csv");
    expect(r).toMatchObject({ status: "imported", from: "2026-07-06", to: "2026-10-11", written: 28, corrected: 0, retired: 0, leftAlone: 0 });
    expect(r.metrics).toEqual([{ key: "enquiries", label: "Enquiries", count: 14 }, { key: "gbp_actions", label: "Calls and directions from Google", count: 14 }]);

    const p = (await getProgram(g, { now: NOW, businessId: biz }))!;
    const enq = p.goals.find((x) => x.metricKey === "enquiries")!;
    // the newest 28 days: weeks of 14 Sep, 21 Sep, 28 Sep and 5 Oct = 20 + 21 + 22 + 23
    expect(enq).toMatchObject({ current: 86, currentAt: "2026-10-11", baselineConf: "reported" });
    // where it started: the 28 days that ended on or before the day it joined (24 Sep): the weeks of 24 Aug .. 14 Sep = 17 + 18 + 19 + 20
    expect(enq).toMatchObject({ baseline: 74, baselineAt: "2026-09-20", targetBasis: "baseline", target: 111 });
    expect(enq.status).not.toBe("no_data");
    const calls = p.goals.find((x) => x.metricKey === "gbp_actions")!;
    // phone calls are 4 + the week number: 14 + 15 + 16 + 17 now, 11 + 12 + 13 + 14 when it started
    expect(calls).toMatchObject({ current: 62, baseline: 50, baselineConf: "reported" });
    // a goal with no matching column stays honest
    expect(p.goals.find((x) => x.metricKey === "gsc_clicks")).toMatchObject({ baseline: null, current: null, status: "no_data" });
    expect(r.goals.find((x) => x.id === enq.id)).toMatchObject({ newlyMeasured: true, current: 86, baseline: 74 });
    expect(r.sentences.join(" ")).toMatch(/New booking enquiries per month: 86 enquiries a month, you started at 74/);
  });

  it("moves the matching capability up the ladder, and says so", async () => {
    const p = (await getProgram(g, { now: NOW, businessId: biz }))!;
    expect(p.capabilities.items.find((c) => c.key === "gbp")?.accessMode).toBe("upload");
    expect(p.capabilities.items.find((c) => c.key === "ga4")?.accessMode).not.toBe("upload"); // visits were not in the file
  });

  it("stores provenance: a Document for the file, every number sourced from it, uploaded, with the real dates", async () => {
    const [d] = await q<{ id: string; kind: string; mode: string; status: string; rows: number; first: string; last: string; name: string }>(
      "MATCH (d:Document {kind:'upload'}) RETURN d.id AS id, d.kind AS kind, d.accessMode AS mode, d.status AS status, d.rows AS rows, d.firstDate AS first, d.lastDate AS last, d.name AS name");
    expect(d).toMatchObject({ kind: "upload", mode: "upload", status: "active", rows: 14, first: "2026-07-06", last: "2026-10-11", name: "Numbers you uploaded: Kestrel numbers.csv" });
    const obs = await q<{ id: string; ws: string; we: string; asOf: string; conf: number; src: string; unit: string }>(
      `MATCH (o:Observation {metric:'enquiries'})-[m:MEASURES]->(b:Business {id:$b}), (o)-[s:SOURCED_FROM]->(doc:Document {id:$d})
       WHERE m.until IS NULL AND s.until IS NULL RETURN o.id AS id, o.windowStart AS ws, o.windowEnd AS we, o.asOf AS asOf, o.conf AS conf, o.src AS src, o.unit AS unit ORDER BY o.windowEnd, o.id`,
      { b: biz, d: d!.id });
    expect(obs).toHaveLength(14);
    expect(obs[0]).toMatchObject({ ws: "2026-07-06", we: "2026-07-12", asOf: "2026-10-15", conf: UPLOAD_CONF, src: d!.id, unit: "enquiries" });
    expect(obs[13]).toMatchObject({ ws: "2026-10-05", we: "2026-10-11" });
    const ev = await q<{ e: string }>("MATCH (o:Observation {metric:'enquiries', windowEnd:'2026-10-11'}) RETURN o.evidence AS e");
    expect(ev[0]!.e).toBe("From your file “Kestrel numbers.csv”, column “Enquiries”.");
  });

  it("the same file again changes nothing", async () => {
    const nodes = await count("MATCH (n) RETURN count(n) AS c");
    const versions = await count("MATCH (v:Version) RETURN count(v) AS c");
    const r = await upload(weeklyCsv(), "Kestrel numbers.csv", NOW + 3_600_000);
    expect(r).toMatchObject({ status: "already_added", written: 0 });
    expect(r.sentences[0]).toMatch(/already added this file/);
    expect(await count("MATCH (n) RETURN count(n) AS c")).toBe(nodes);
    expect(await count("MATCH (v:Version) RETURN count(v) AS c")).toBe(versions);
  });

  it("a corrected file supersedes: values updated with the old kept, dropped rows retired, the old file marked replaced", async () => {
    // week 13 was 23: the owner fixes it to 30; week 2 (20 to 26 Jul) was a mistake and is gone
    const r = await upload(weeklyCsv({ 13: 30 }, [2]), "Kestrel numbers (fixed).csv", NOW + DAY);
    expect(r).toMatchObject({ status: "imported", corrected: 1, retired: 2 }); // week 2 of enquiries and of calls
    const [w13] = await q<{ v: number; src: string }>("MATCH (o:Observation {id:'obs:enquiries:" + biz + ":2026-10-11'}) RETURN o.value AS v, o.src AS src");
    expect(w13!.v).toBe(30);
    expect(w13!.src).not.toBe((await q<{ id: string }>("MATCH (d:Document) WHERE d.filename = 'Kestrel numbers.csv' RETURN d.id AS id"))[0]!.id);
    // the earlier value is kept as a Version
    const hist = await q<{ props: string }>("MATCH (:Observation {id:'obs:enquiries:" + biz + ":2026-10-11'})-[:HAD_VERSION]->(v:Version) RETURN v.props AS props");
    expect(hist.map((h) => (JSON.parse(h.props) as { value: number }).value)).toContain(23);
    // the dropped week is no longer current, but is still on record
    const w2 = await q<{ until: number | null }>("MATCH (o:Observation {id:'obs:enquiries:" + biz + ":2026-07-26'})-[m:MEASURES]->(:Business) RETURN m.until AS until");
    expect(w2).toHaveLength(1);
    expect(w2[0]!.until).not.toBeNull();
    expect(await count("MATCH (:Observation {metric:'enquiries'})-[m:MEASURES]->(:Business {id:$b}) WHERE m.until IS NULL RETURN count(m) AS c", { b: biz })).toBe(13);
    // the first file has nothing current left
    const [old] = await q<{ status: string; by: string }>("MATCH (d:Document) WHERE d.filename = 'Kestrel numbers.csv' RETURN d.status AS status, d.replacedBy AS by");
    expect(old!.status).toBe("replaced");
    // goals follow the corrected number; where it started does not move
    const enq = (await getProgram(g, { now: NOW + DAY, businessId: biz }))!.goals.find((x) => x.metricKey === "enquiries")!;
    expect(enq).toMatchObject({ current: 93, baseline: 74 });
    // sending the old file again does not undo the correction
    const again = await upload(weeklyCsv(), "Kestrel numbers.csv", NOW + 2 * DAY);
    expect(again.status).toBe("replaced_earlier");
    expect(again.sentences[0]).toMatch(/newer file has replaced/);
  });

  it("a number retired by one file and given by a later one is current again", async () => {
    await upload(weeklyCsv({ 13: 30 }), "Kestrel numbers (with week 2).csv", NOW + 3 * DAY);
    expect(await count("MATCH (:Observation {metric:'enquiries'})-[m:MEASURES]->(:Business {id:$b}) WHERE m.until IS NULL RETURN count(m) AS c", { b: biz })).toBe(14);
  });

  it("never overwrites a day a connector reads: the connector's number stays, and it is said", async () => {
    // a live reading (no conf: measured by a connector) for the week of 28 Sep to 4 Oct, a week the file also has
    await writeBatch(g, {
      nodes: [{ type: "Document", id: "document:ga-sync", name: "connector sync", props: { kind: "snapshot" }, asOf: "2026-10-19" }],
      observations: [{ subject: biz, metric: "enquiries", value: 99, windowStart: "2026-09-28", windowEnd: "2026-10-04", asOf: "2026-10-19", src: "document:ga-sync" }],
    }, NOW + 4 * DAY);
    const r = await upload(weeklyCsv({ 13: 31 }), "Kestrel numbers v4.csv", NOW + 4 * DAY);
    expect(r.leftAlone).toBe(1);
    expect(r.sentences.join(" ")).toMatch(/already read straight from a connected account/);
    const [v] = await q<{ v: number; src: string }>("MATCH (o:Observation {id:'obs:enquiries:" + biz + ":2026-10-04'}) RETURN o.value AS v, o.src AS src");
    expect(v).toEqual({ v: 99, src: "document:ga-sync" });
  });

  it("a number for today is not final, and is left out in words", async () => {
    const r = await upload(`Date,Visits\n2026-10-13,50\n2026-10-14,60\n2026-10-15,70\n`, "visits.csv", NOW);
    expect(r.leftOut.today).toBe(1);
    expect(r.sentences.join(" ")).toMatch(/1 number for today or later was left out/);
    expect(await count("MATCH (o:Observation {metric:'ga4_sessions'}) RETURN count(o) AS c")).toBe(2);
    // and the website analytics capability moves up too
    expect(r.capabilities.map((c) => [c.key, c.to])).toContainEqual(["ga4", "upload"]);
  });

  it("refuses a file of nothing but today and later", async () => {
    await expect(upload(`Date,Visits\n2026-10-15,70\n2026-10-16,80\n`, "later.csv")).rejects.toMatchObject({ code: "future_only" });
  });

  it("refuses personal data before storing anything, and a file name with an address is redacted", async () => {
    const docs = await count("MATCH (d:Document {kind:'upload'}) RETURN count(d) AS c");
    const bytes = Buffer.from("Date,Customer email,Orders\n2026-10-01,jane@example.com,3\n2026-10-02,bob@example.com,4\n");
    await expect(importNumbers({ g, businessId: biz, fileName: "orders.csv", bytes, plan: { dateColumn: 0, dateOrder: "dmy", cadence: "day", weekAnchor: "start", columns: [{ index: 2, metric: "orders" }] }, now: NOW }))
      .rejects.toMatchObject({ code: "personal" });
    expect(await count("MATCH (d:Document {kind:'upload'}) RETURN count(d) AS c")).toBe(docs);
    await upload(`Date,Orders\n2026-10-01,3\n2026-10-02,4\n`, "jane@example.com orders.csv");
    const [d] = await q<{ name: string; file: string }>("MATCH (d:Document {kind:'upload'}) WHERE d.name CONTAINS 'orders' RETURN d.name AS name, d.filename AS file");
    expect(d!.name).not.toMatch(/jane@example\.com/);
    expect(await scanGraph(g)).toEqual([]);
  });

  it("each business has its own graph: another tenant sees none of it", async () => {
    expect(await other.roQuery<{ c: number }>("MATCH (o:Observation) RETURN count(o) AS c")).toEqual([{ c: 0 }]);
    expect(await other.roQuery<{ c: number }>("MATCH (d:Document) RETURN count(d) AS c")).toEqual([{ c: 0 }]);
  });

  it("does not guess: a column left unanswered, or two columns for one number, is refused", async () => {
    const csv = "Date,Orders,Extras\n2026-10-01,3,1\n2026-10-02,4,2\n";
    const bytes = Buffer.from(csv);
    const base = { dateColumn: 0, dateOrder: "dmy" as const, cadence: "day" as const, weekAnchor: "start" as const };
    const go = (columns: UploadPlan["columns"], cadence: UploadPlan["cadence"] = "day") => importNumbers({ g, businessId: biz, fileName: "x.csv", bytes, plan: { ...base, cadence, columns }, now: NOW });
    await expect(go([{ index: 1, metric: "orders" }])).rejects.toMatchObject({ code: "needs_answer", message: expect.stringMatching(/column C \(“Extras”\)/) });
    await expect(go([{ index: 1, metric: "orders" }, { index: 2, metric: null }])).rejects.toMatchObject({ code: "needs_answer" });
    await expect(go([{ index: 1, metric: "orders" }, { index: 2, metric: "orders" }])).rejects.toMatchObject({ code: "bad_plan", message: expect.stringMatching(/Columns B and C/) });
    await expect(go([{ index: 1, metric: "skip" }, { index: 2, metric: "skip" }])).rejects.toMatchObject({ code: "needs_answer" });
    await expect(go([{ index: 1, metric: "orders" }, { index: 2, metric: "skip" }], null)).rejects.toMatchObject({ code: "needs_answer" });
    await expect(go([{ index: 1, metric: "teleports" }, { index: 2, metric: "skip" }])).rejects.toMatchObject({ code: "bad_plan" });
  });

  it("keeps a number we have no name for under the owner's own name", async () => {
    const bytes = Buffer.from(`Date,Pints sold\n2026-10-01,30\n2026-10-02,41\n`);
    const done = await importNumbers({ g, businessId: biz, fileName: "pints.csv", bytes, now: NOW,
      plan: { dateColumn: 0, dateOrder: "dmy", cadence: "day", weekAnchor: "start", columns: [{ index: 1, metric: "other", label: "Pints sold" }] } });
    expect(done.metrics).toEqual([{ key: "custom_pints_sold", label: "Pints sold", count: 2 }]);
    expect(await count("MATCH (o:Observation {metric:'custom_pints_sold'}) RETURN count(o) AS c")).toBe(2);
  });

  it("caps the numbers one file may write, before writing any", async () => {
    const rows = Array.from({ length: Math.ceil(MAX_VALUES / 5) + 1 }, (_, i) => `${iso(Date.UTC(2010, 0, 1) + i * DAY)},1,2,3,4,5`).join("\n");
    const bytes = Buffer.from(`Date,Orders,Enquiries,Bookings,Sessions,Signups\n${rows}\n`);
    const p = previewTable(readTable(bytes, "big.csv"), { fileName: "big.csv", fileHash: "x" });
    const before = await count("MATCH (o:Observation) RETURN count(o) AS c");
    await expect(importNumbers({ g, businessId: biz, fileName: "big.csv", bytes, plan: p.plan, now: NOW })).rejects.toMatchObject({ code: "too_many_values", message: expect.stringMatching(/more numbers than we take/) });
    expect(await count("MATCH (o:Observation) RETURN count(o) AS c")).toBe(before);
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { decideApproval } from "../../src/actions/approvals.js";
import { writeBatch } from "../../src/graph/upsert.js";
import {
  applyRule, applyRules, editDistance, editFragment, extractRules, guideCards, learnFromEdit, ruleUse, wordDiff, words,
  type ActiveRule, type LearnedEvent, type RuleOp, type RuleSpec,
} from "../../src/actions/learning.js";
import type { Candidate } from "../../src/insights/detectors.js";
import { writeRecommendation } from "../../src/insights/recommend.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";

describe("word diff and rule extraction (deterministic)", () => {
  it("diffs words, ignoring case, punctuation and emoji", () => {
    expect(words("A stunning Villa, in Raipur! 🎉")).toEqual(["a", "stunning", "villa", "in", "raipur"]);
    expect(wordDiff(words("A stunning villa in Raipur"), words("A home in Raipur"))).toEqual([{ del: ["stunning", "villa"], ins: ["home"], delAt: [1, 2], insAt: [1] }]);
  });

  // Content trial 2026-10-15: the owner rewrote "where the day begins" as "where our day begins"; the loop learned "say our, not the"
  // and applied it to the whole caption ("beside our window of our room"). A bare article or preposition swapped for a word
  // is a rewrite of one sentence, not a style.
  it("never learns to swap a bare article or preposition for a word", () => {
    expect(extractRules("A desk where the day begins slowly.", "The desk where our day begins.").rules.map((r) => r.id)).toEqual([]);
    expect(extractRules("Dark stone beside the window", "Dark stone beside our window").rules).toEqual([]);
    expect(extractRules("Dark stone and a small tree", "Dark stone and a bonsai").rules.map((r) => r.id)).toEqual(["rule:learned-say-bonsai-not-small-tree"]);
  });

  it("learns a substitution, and a hype word cut next to it", () => {
    const { rules, complex } = extractRules("Tour this stunning villa in Raipur", "Tour this home in Raipur");
    expect(complex).toBe(false);
    expect(rules.map((r) => [r.id, r.op, r.text])).toEqual([
      ["rule:learned-say-home-not-villa", "replace", 'Say "home", not "villa".'],
      ["rule:learned-avoid-stunning", "avoid_words", 'Avoid hype words: "stunning".'],
    ]);
    expect(rules[0]).toMatchObject({ find: "villa", replace: "home", confidence: 0.6 });
  });

  it("keeps the replacement as the owner wrote it (proper nouns stay capitalised)", () => {
    const { rules } = extractRules("Draft one reel this week.", "Draft one reel by Friday.");
    expect(rules).toEqual([expect.objectContaining({ find: "this week", replace: "by Friday", text: 'Say "by Friday", not "this week".' })]);
    expect(applyRule("Post it this week. This week works.", rules[0]!)).toBe("Post it by Friday. By Friday works.");
    expect(extractRules("Reel for Instagram", "Reel for IG").rules[0]).toMatchObject({ find: "instagram", replace: "IG", text: 'Say "IG", not "Instagram".' });
  });

  it("a substitution made twice in one edit is more confident", () => {
    const { rules } = extractRules("The villa kitchen. The villa garden.", "The home kitchen. The home garden.");
    expect(rules).toEqual([expect.objectContaining({ id: "rule:learned-say-home-not-villa", confidence: 0.7 })]);
  });

  it("learns no emoji and no exclamation marks", () => {
    const { rules } = extractRules("New jobs today! 🎉🔥 Apply now", "New jobs today. Apply now");
    expect(rules.map((r) => r.op).sort()).toEqual(["no_exclaim", "remove_emoji"]);
  });

  it("learns a length limit when the owner cuts the draft hard", () => {
    const long = "We design homes in Raipur that keep the afternoon sun out and let the breeze in, with courtyards, deep verandas and local stone that stays cool all summer long.";
    const { rules } = extractRules(long, "Homes in Raipur that stay cool: courtyards, verandas, local stone.");
    expect(rules).toContainEqual(expect.objectContaining({ op: "max_words", max: 10, text: "Keep it under 10 words." }));
  });

  it("learns nothing from a corrected number or a full rewrite (the rewrite is flagged for the optional model)", () => {
    expect(extractRules("Fees start at ₹500 a month", "Fees start at ₹600 a month").rules).toEqual([]);
    const r = extractRules("Our team builds calm modern homes for families", "Call us today for a free site visit next week");
    expect(r.rules).toEqual([]);
    expect(r.complex).toBe(true);
  });

  it("normalised word-level edit distance", () => {
    expect(editDistance("a b c d", "a b c d")).toBe(0);
    expect(editDistance("a b c d", "a b x d")).toBe(0.25);
    expect(editDistance("", "x")).toBe(1);
  });

  it("applies deterministic rules, keeping case, whole words only", () => {
    const r = { op: "replace" as const, find: "villa", replace: "home" };
    expect(applyRule("Villa tours. A VILLA. The villas stay.", r)).toBe("Home tours. A HOME. The villas stay.");
    expect(applyRule("Hi 🎉 there 🔥!", { op: "remove_emoji" })).toBe("Hi there!");
    expect(applyRule("Apply now!!", { op: "no_exclaim" })).toBe("Apply now.");
    const rules: ActiveRule[] = [
      { id: "rule:a", kind: "learned", text: 'Say "home"', op: "replace", find: "villa", replace: "home", confidence: 0.6, appliedCount: 0 },
      { id: "rule:b", kind: "learned", text: "No emojis.", op: "remove_emoji", confidence: 0.7, appliedCount: 0 },
      { id: "rule:c", kind: "learned", text: "Keep it short.", op: "max_words", max: 40, confidence: 0.5, appliedCount: 0 },
    ];
    const out = applyRules({ title: "Villa tour", body: "Come see it" }, rules);
    expect(out).toMatchObject({ title: "Home tour", body: "Come see it" });
    expect(out.applied.map((x) => x.id)).toEqual(["rule:a"]);  // the emoji rule changed nothing
    expect(out.instructions.map((x) => x.id)).toEqual(["rule:c"]);
  });
});

describe("the learning loop, end to end", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dataDir: string;
  const events: LearnedEvent[] = [];
  const deps = () => ({ tenant: "test", executors: { config: { dataDir } }, onLearned: (e: LearnedEvent) => events.push(e) });
  const count = async (q: string, p: Record<string, unknown> = {}) => (await g.roQuery<{ c: number }>(q, p))[0]?.c ?? 0;
  const draft = (key: string, title: string, body: string): Candidate => ({
    key, detector: "content.hook_outliers", area: "content", agent: "content-strategist", title, why: "Synthetic test finding.",
    evidence: ["channel:instagram"], numbers: {}, score: 0.5, confidence: 0.5,
    suggestedAction: { kind: "content_draft", payload: { title, body, format: "post", channelId: "channel:instagram", target: "Instagram" } },
  });

  beforeAll(async () => {
    ({ g, cleanup } = await seededGraph());
    dataDir = mkdtempSync(join(tmpdir(), "allevia-drafts-"));
  });
  afterAll(async () => {
    await cleanup?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("draft -> owner edits villa to home -> a rule is learned -> the next draft says home, with USES_RULE -> first-pass moves", async () => {
    // 1. Tara's first draft says "villa".
    const first = await writeRecommendation(g, draft("test:draft-1", "Villa tour in Raipur", "Tour this villa in Raipur: light from three sides."), { now: SEED_NOW });
    expect(first.approvalId).toBeDefined();

    // 2. The owner edits "villa" to "home" and approves.
    const t1 = SEED_NOW + 3_600_000;
    const r1 = await decideApproval(g, {
      approvalId: first.approvalId!, decision: "approve", now: t1,
      editedPayload: { title: "Home tour in Raipur", body: "Tour this home in Raipur: light from three sides." },
    }, deps());
    expect(r1.approval).toMatchObject({ status: "executed", firstPass: false, decisionMs: 3_600_000, decision: "approve" });
    expect(r1.approval.editDistance).toBeGreaterThan(0);

    // 3. A rule is learned: LEARNED_FROM the approval, APPLIES_TO Tara and Instagram, PRODUCED by Dev, announced.
    expect(r1.learned?.map((r) => r.text)).toEqual(['Say "home", not "villa".']);
    const ruleId = "rule:learned-say-home-not-villa";
    expect(events).toEqual([{ type: "learned", ruleId, text: 'Say "home", not "villa".', fromApprovalId: first.approvalId }]);
    expect(await count(`MATCH (r:Rule {id:$r})-[:LEARNED_FROM]->(:Approval {id:$a}) WHERE r.kind = 'learned' AND r.status = 'active' AND r.appliedCount = 0 RETURN count(*) AS c`,
      { r: ruleId, a: first.approvalId })).toBe(1);
    expect(await count(`MATCH (:Rule {id:$r})-[:APPLIES_TO]->(x) WHERE x.id IN ['agent:allevia-content-strategist', 'channel:instagram'] RETURN count(*) AS c`, { r: ruleId })).toBe(2);
    expect(await count("MATCH (:Agent {id:'agent:allevia-copy-editor'})-[:PRODUCED]->(:Rule {id:$r}) RETURN count(*) AS c", { r: ruleId })).toBe(1);
    expect(r1.metrics).toMatchObject({ firstPassRate: 0, learnedRules: 1, deliverablesApproved: 1 });
    // ... and the rule says where it came from: the approval as its src, the day, the confidence, and the words before and after
    const [lf] = await g.roQuery<Record<string, unknown>>(
      `MATCH (r:Rule {id:$r})-[e:LEARNED_FROM]->(:Approval {id:$a}) RETURN e.src AS src, e.asOf AS asOf, e.conf AS conf, e.before AS before, e.after AS after, e.op AS op, r.src AS ruleSrc, r.asOf AS ruleAsOf, r.confidence AS confidence`,
      { r: ruleId, a: first.approvalId });
    expect(lf).toEqual({ src: first.approvalId, asOf: new Date(t1).toISOString().slice(0, 10), conf: 0.7, before: "villa", after: "home", op: "replace", ruleSrc: first.approvalId, ruleAsOf: new Date(t1).toISOString().slice(0, 10), confidence: 0.7 });

    // 4. The next draft says "villa" again; the card already shows "home" ...
    const second = await writeRecommendation(g, draft("test:draft-2", "Before and after: a villa kitchen", "This villa kitchen got a skylight."), { now: t1 });
    const [card] = await g.roQuery<{ payload: string }>("MATCH (a:Approval {id:$id}) RETURN a.payload AS payload", { id: second.approvalId });
    expect(JSON.parse(card!.payload)).toMatchObject({ title: "Before and after: a home kitchen", body: "This home kitchen got a skylight.", rulesApplied: [ruleId] });

    // The card is GUIDED_BY the rule that rewrote it (both the idea and the card), and says what it swapped.
    const guided = await g.roQuery<Record<string, unknown>>(
      `MATCH (c:Entity)-[e:GUIDED_BY]->(r:Rule {id:$r}) WHERE c.id IN [$rec, $ap] AND e.until IS NULL RETURN c.id AS card, e.how AS how, e.find AS find, e.replace AS replace, e.src AS src ORDER BY card`,
      { r: ruleId, rec: second.id, ap: second.approvalId });
    expect(guided).toEqual([
      { card: second.approvalId, how: "rewrote", find: "villa", replace: "home", src: second.id },
      { card: second.id, how: "rewrote", find: "villa", replace: "home", src: second.id },
    ]); // "approval:" sorts before "recommendation:"
    // the first card was drafted before the rule existed: nothing guided it
    expect(await count("MATCH (:Entity {id:$ap})-[e:GUIDED_BY]->() WHERE ID(e) >= 0 RETURN count(e) AS c", { ap: first.approvalId })).toBe(0);

    // ... so the owner approves it as it is: first pass.
    const t2 = SEED_NOW + 7_200_000;
    const r2 = await decideApproval(g, { approvalId: second.approvalId!, decision: "approve", now: t2 }, deps());
    expect(r2.approval).toMatchObject({ status: "executed", firstPass: true, editDistance: 0 });
    expect(r2.learned).toBeUndefined();
    const contentId = r2.action!.produced[0]!;
    expect(await count("MATCH (c:Content {id:$c})-[:USES_RULE]->(:Rule {id:$r}) WHERE c.status = 'draft' RETURN count(*) AS c", { c: contentId, r: ruleId })).toBe(1);
    const [uses] = await g.roQuery<Record<string, unknown>>("MATCH (:Content {id:$c})-[e:USES_RULE]->(:Rule {id:$r}) RETURN e.applied AS applied, e.how AS how, e.find AS find, e.replace AS replace", { c: contentId, r: ruleId });
    expect(uses).toEqual({ applied: true, how: "rewrote", find: "villa", replace: "home" });
    expect(await count("MATCH (r:Rule {id:$r}) WHERE r.appliedCount = 1 RETURN count(*) AS c", { r: ruleId })).toBe(1);
    const [c2] = await g.roQuery<{ path: string; title: string }>("MATCH (c:Content {id:$c}) RETURN c.draftPath AS path, c.title AS title", { c: contentId });
    expect(c2!.title).toBe("Before and after: a home kitchen");
    const md = readFileSync(join(dataDir, c2!.path), "utf8");
    expect(md).toContain("This home kitchen got a skylight.");
    expect(md).toContain('Say "home", not "villa".');
    expect(md).not.toMatch(/villa kitchen/);

    // 5. The KPI moved: first-pass 0 -> 1/2, with the earlier reading kept as a Version.
    expect(r2.metrics).toMatchObject({ firstPassRate: 0.5, decided30d: 2, firstPass30d: 1, learnedRules: 1, deliverablesApproved: 2 });
    const [obs] = await g.roQuery<{ v: number; versions: number }>(
      `MATCH (o:Observation {metric:'allevia.first_pass_rate'})-[:MEASURES]->(:Business {id:'business:aamdani'})
       OPTIONAL MATCH (o)-[:HAD_VERSION]->(ver:Version) WITH o, count(ver) AS versions RETURN o.value AS v, versions`);
    expect(obs).toEqual({ v: 0.5, versions: 1 });
    expect(await count("MATCH (o:Observation {metric:'allevia.learned_rules'}) WHERE o.value = 1 RETURN count(o) AS c")).toBe(1);
    expect(await count("MATCH (o:Observation {metric:'allevia.deliverables_approved'}) WHERE o.value = 2 RETURN count(o) AS c")).toBe(1);
  });

  it("the same lesson again reinforces the rule; reversing it retires the old rule", async () => {
    const now = SEED_NOW + 10_800_000;
    const again = await learnFromEdit(g, { approvalId: "approval:t-001-1", original: { title: "Villa", body: "" }, edited: { title: "Home", body: "" }, agentId: "content-strategist", now });
    expect(again).toEqual([expect.objectContaining({ id: "rule:learned-say-home-not-villa", created: false, confidence: 0.8 })]);
    const back = await learnFromEdit(g, { approvalId: "approval:t-001-1", original: { title: "Home", body: "" }, edited: { title: "Villa", body: "" }, now });
    expect(back[0]).toMatchObject({ id: "rule:learned-say-villa-not-home", retired: ["rule:learned-say-home-not-villa"] });
    expect(await count("MATCH (r:Rule {id:'rule:learned-say-home-not-villa'})-[:HAD_VERSION]->(v:Version) WHERE r.status = 'retired' RETURN count(v) AS c")).toBe(2); // one Version for the reinforcement (confidence 0.7 to 0.8), one for the retirement
    expect(await count("MATCH (:Rule {id:'rule:learned-say-villa-not-home'})-[:CONTRADICTS]->(:Rule {id:'rule:learned-say-home-not-villa'}) RETURN count(*) AS c")).toBe(1);
  });

  it("a complex rewrite asks the optional model, and a failing model learns nothing", async () => {
    const now = SEED_NOW + 14_400_000;
    const original = { title: "Our studio", body: "Our team builds calm modern homes for families" };
    const edited = { title: "Our studio", body: "Call us today for a free site visit next week" };
    const ok = await learnFromEdit(g, { approvalId: "approval:t-001-1", original, edited, now },
      { llm: { structured: async () => ({ rules: ["End with one clear next step for the reader."] }) } });
    expect(ok.map((r) => [r.op, r.text])).toEqual([["instruction", "End with one clear next step for the reader."]]);
    const bad = await learnFromEdit(g, { approvalId: "approval:t-001-1", original, edited, now }, { llm: { structured: async () => { throw new Error("offline"); } } });
    expect(bad).toEqual([]);
    expect(await learnFromEdit(g, { approvalId: "approval:t-001-1", original, edited, now })).toEqual([]); // no model: nothing
  });
});

describe("a card is GUIDED_BY the rules that shaped it", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const rows = <T>(q: string, p: Record<string, unknown> = {}) => g.roQuery<T>(q, p);
  const rule = (id: string, op: ActiveRule["op"], extra: Partial<ActiveRule> = {}): ActiveRule => ({ id, kind: "learned", text: id, op, confidence: 0.7, appliedCount: 0, ...extra });

  beforeAll(async () => {
    ({ g, cleanup } = await seededGraph());
    const s = await writeBatch(g, { nodes: [
      { type: "Recommendation", id: "recommendation:guided", name: "A guided idea", props: { status: "open" } },
      { type: "Approval", id: "approval:guided", name: "content_draft: guided", props: { status: "pending" } },
      { type: "Rule", id: "rule:learned-swap", name: "Say home", props: { kind: "learned", status: "active", op: "replace", find: "villa", replace: "home" } },
      { type: "Rule", id: "rule:learned-short", name: "Keep it short", props: { kind: "learned", status: "active", op: "max_words", max: 30 } },
      { type: "BrandRule", id: "brand-rule:warm", name: "Warm voice", props: { text: "Sound warm." } },
    ] }, SEED_NOW);
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => { await cleanup?.(); });

  it("a rule the code applied 'rewrote' the text (with what it swapped); any other 'instructed' the writer", () => {
    expect(ruleUse({ op: "replace", find: "villa", replace: "home" })).toEqual({ how: "rewrote", find: "villa", replace: "home" });
    expect(ruleUse({ op: "remove_emoji" })).toEqual({ how: "rewrote" });
    expect(ruleUse({ op: "max_words" })).toEqual({ how: "instructed" });
    expect(ruleUse({ op: "instruction" })).toEqual({ how: "instructed" });
    expect(ruleUse({})).toEqual({ how: "instructed" }); // a brand rule
  });

  it("writes GUIDED_BY from the idea and the card to each rule, to a brand rule too, and closes one that stops applying", async () => {
    const swap = rule("rule:learned-swap", "replace", { find: "villa", replace: "home" });
    const short = rule("rule:learned-short", "max_words", { max: 30 });
    const brand: ActiveRule = { id: "brand-rule:warm", kind: "brand", text: "Sound warm.", op: "instruction", confidence: 1, appliedCount: 0 };
    await guideCards(g, ["recommendation:guided", "approval:guided"], [swap, short, brand], SEED_NOW, "recommendation:guided");
    const now = await rows<{ card: string; rule: string; how: string; find: string | null; src: string; asOf: string }>(
      `MATCH (c:Entity)-[e:GUIDED_BY]->(r:Entity) WHERE c.id IN ['recommendation:guided', 'approval:guided'] AND e.until IS NULL
       RETURN c.id AS card, r.id AS rule, e.how AS how, e.find AS find, e.src AS src, e.asOf AS asOf ORDER BY card, rule`);
    expect(now.map((r) => [r.card, r.rule, r.how, r.find])).toEqual([
      ["approval:guided", "brand-rule:warm", "instructed", null], ["approval:guided", "rule:learned-short", "instructed", null], ["approval:guided", "rule:learned-swap", "rewrote", "villa"],
      ["recommendation:guided", "brand-rule:warm", "instructed", null], ["recommendation:guided", "rule:learned-short", "instructed", null], ["recommendation:guided", "rule:learned-swap", "rewrote", "villa"],
    ]);
    expect(now.every((r) => r.src === "recommendation:guided" && r.asOf === new Date(SEED_NOW).toISOString().slice(0, 10))).toBe(true);

    // a re-run where only the swap still applies: the others are closed (kept as history), the swap stays, nothing doubles
    await guideCards(g, ["recommendation:guided", "approval:guided"], [swap], SEED_NOW + 1000, "recommendation:guided");
    const after = await rows<{ rule: string; open: number; closed: number }>(
      `MATCH (:Entity {id:'approval:guided'})-[e:GUIDED_BY]->(r:Entity) WITH r, sum(CASE WHEN e.until IS NULL THEN 1 ELSE 0 END) AS open, sum(CASE WHEN e.until IS NULL THEN 0 ELSE 1 END) AS closed
       RETURN r.id AS rule, open, closed ORDER BY rule`);
    expect(after).toEqual([{ rule: "brand-rule:warm", open: 0, closed: 1 }, { rule: "rule:learned-short", open: 0, closed: 1 }, { rule: "rule:learned-swap", open: 1, closed: 0 }]);
  });

  it("LEARNED_FROM keeps the fragment of the edit: emoji, an exclamation sentence, hype words, length", () => {
    const spec = (op: RuleOp, extra: Partial<RuleSpec> = {}): RuleSpec => ({ id: `rule:x-${op}`, op, text: "x", confidence: 0.6, ...extra });
    expect(editFragment(spec("remove_emoji"), "New jobs today 🎉🔥 apply", "New jobs today apply")).toEqual({ before: "🎉🔥", after: "" });
    expect(editFragment(spec("no_exclaim"), "Hello there. New jobs today! Apply now.", "x")).toEqual({ before: "New jobs today!", after: "New jobs today." });
    expect(editFragment(spec("avoid_words", { words: ["stunning", "amazing"] }), "", "")).toEqual({ before: "stunning, amazing", after: "" });
    expect(editFragment(spec("max_words"), "one two three four five six", "one two three")).toEqual({ before: "6 words", after: "3 words" });
    expect(editFragment(spec("instruction"), "a", "b")).toEqual({});
  });
});

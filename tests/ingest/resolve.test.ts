import { describe, it, expect } from "vitest";
import type { EntityType } from "../../src/graph/schema.js";
import {
  FOUNDER_ID, MERGE_SIMILARITY, normName, rememberWrite, resolveExtraction, type Extraction, type KnownEntity, type ResolveContext,
} from "../../src/ingest/extract.js";
import type { GraphWrite } from "../../src/ingest/types.js";

const DOC = "document:note-1";
const TEXT = `Search Console shows the jobs page slipping. As of 28 Sep reels drove 90% of reach.
We decided to pause Facebook posts. Decided by Ankit. Instagram (IG) is where seekers find us.`;

const ent = (type: EntityType, name: string, summary = `${name}.`, aliases?: string[]) => ({ type, name, summary, ...(aliases ? { aliases } : {}) });
const ex = (p: Partial<Extraction>): Extraction => ({ entities: [], relations: [], observations: [], ...p });
const known = (...ks: KnownEntity[]) => new Map(ks.map((k) => [k.id, k]));
const ctx = (p: Partial<ResolveContext> = {}): ResolveContext => ({ docId: DOC, asOf: "2026-09-30", existing: new Map(), text: TEXT, ...p });

const ids = (w: GraphWrite) => w.nodes.map((n) => n.id).sort();
const edges = (w: GraphWrite, type?: string) => w.edges.filter((e) => !type || e.type === type).map((e) => `${e.from} -${e.type}-> ${e.to}`).sort();

const GSC: KnownEntity = { id: "system:google-search-console", type: "System", name: "Google Search Console" };

describe("normName", () => {
  it("ignores case, punctuation and a leading 'the'", () => {
    expect(normName("The  Founder!")).toBe("founder");
    expect(normName("Google Search-Console")).toBe("google search console");
    expect(normName("कितने नए users")).toBe("कितने नए users");
  });
});

describe("resolveExtraction: entities", () => {
  it("creates new entities with deterministic ids, SOURCED_FROM the doc and MENTIONED by it", async () => {
    const { write, dropped } = await resolveExtraction(ex({ entities: [ent("Channel", "Instagram", "Where seekers find us.", ["IG"])] }), ctx());
    expect(dropped).toEqual([]);
    expect(write.nodes).toEqual([{
      type: "Channel", id: "channel:instagram", name: "Instagram", summary: "Where seekers find us.", props: { aliases: ["IG"] },
      src: DOC, asOf: "2026-09-30",
    }]);
    expect(edges(write)).toEqual([`channel:instagram -SOURCED_FROM-> ${DOC}`, `${DOC} -MENTIONS-> channel:instagram`]);
    expect(write.edges.every((e) => e.src === DOC && e.asOf === "2026-09-30" && e.functional === false)).toBe(true);
  });

  it("merges 'Search Console' into 'Google Search Console' through a known alias", async () => {
    const existing = known({ ...GSC, aliases: ["Search Console", "GSC"] });
    const { write } = await resolveExtraction(ex({ entities: [ent("System", "Search Console")] }), ctx({ existing }));
    expect(ids(write)).toEqual([]); // nothing new to say about the node itself: no rename, no summary overwrite
    expect(edges(write)).toEqual([`${DOC} -MENTIONS-> ${GSC.id}`, `${GSC.id} -SOURCED_FROM-> ${DOC}`]);
  });

  it("merges through similar() only at or above the threshold, and records a near miss on the MENTIONS edge", async () => {
    const existing = known(GSC);
    const at = (score: number) => ctx({ existing, similar: async (type, name) => (type === "System" && name === "Search Console" ? { id: GSC.id, score } : null) });

    const merged = await resolveExtraction(ex({ entities: [ent("System", "Search Console")] }), at(MERGE_SIMILARITY));
    expect(edges(merged.write, "MENTIONS")).toEqual([`${DOC} -MENTIONS-> ${GSC.id}`]);
    // the merge teaches the existing node the new name, without renaming it
    expect(merged.write.nodes).toEqual([{ type: "System", id: GSC.id, name: "Google Search Console", props: { aliases: ["Search Console"] } }]);

    const near = await resolveExtraction(ex({ entities: [ent("System", "Search Console")] }), at(0.85));
    expect(ids(near.write)).toEqual(["system:search-console"]);
    const m = near.write.edges.find((e) => e.type === "MENTIONS")!;
    expect(m).toMatchObject({ to: "system:search-console", props: { maybeSameAs: GSC.id } });
    expect(m.conf).toBeLessThan(0.6);

    const far = await resolveExtraction(ex({ entities: [ent("System", "Search Console")] }), at(0.5));
    expect(ids(far.write)).toEqual(["system:search-console"]);
    expect(far.write.edges.find((e) => e.type === "MENTIONS")!.props).toBeUndefined();
  });

  it("does not merge 'Search Console' with 'Google Search Console' on its own", async () => {
    const { write } = await resolveExtraction(ex({ entities: [ent("System", "Search Console")] }), ctx({ existing: known(GSC) }));
    expect(ids(write)).toEqual(["system:search-console"]);
  });

  it("matches only within the same type, and ignores a similar() hit of another type", async () => {
    const existing = known({ id: "channel:instagram", type: "Channel", name: "Instagram" });
    const similar = async () => ({ id: "channel:instagram", score: 0.99 });
    const { write } = await resolveExtraction(ex({ entities: [ent("System", "Instagram")] }), ctx({ existing, similar }));
    expect(ids(write)).toEqual(["system:instagram"]);
  });

  it("resolves the founder's references to person:founder", async () => {
    const existing = known({ id: FOUNDER_ID, type: "Person", name: "Ankit Vohra" });
    const { write } = await resolveExtraction(ex({
      entities: [ent("Person", "The Founder"), ent("Person", "Ankit"), ent("Decision", "Pause Facebook posts")],
      relations: [{ from: "Ankit", fromType: "Person", type: "DECIDED", to: "Pause Facebook posts", toType: "Decision", evidence: "Decided by Ankit", conf: 0.95 }],
    }), ctx({ existing, founderNames: ["Ankit", "Ankit Vohra"] }));
    expect(ids(write)).toEqual(["decision:pause-facebook-posts"]); // the founder node is not renamed to "The Founder"
    expect(edges(write, "DECIDED")).toEqual([`${FOUNDER_ID} -DECIDED-> decision:pause-facebook-posts`]);
    expect(edges(write, "MENTIONS")).toContain(`${DOC} -MENTIONS-> ${FOUNDER_ID}`);

    // "the founder" works without founderNames, and creates the node when the graph has none yet
    const fresh = await resolveExtraction(ex({ entities: [ent("Person", "founder")] }), ctx());
    expect(fresh.write.nodes.map((n) => [n.id, n.type])).toEqual([[FOUNDER_ID, "Person"]]);
  });

  it("merges duplicate entities within one document", async () => {
    const { write } = await resolveExtraction(ex({
      entities: [ent("Channel", "Instagram", "Where seekers find us."), ent("Channel", "instagram", "", ["IG"]), ent("Channel", "Insta", "", ["Instagram"])],
    }), ctx());
    expect(write.nodes).toHaveLength(1);
    expect(write.nodes[0]).toMatchObject({ id: "channel:instagram", name: "Instagram", summary: "Where seekers find us.", props: { aliases: ["IG", "Insta"] } });
    expect(edges(write, "MENTIONS")).toEqual([`${DOC} -MENTIONS-> channel:instagram`]);
  });

  it("never emits types outside the extractable set", async () => {
    const { write, dropped } = await resolveExtraction(ex({
      entities: [ent("Document" as EntityType, "Some note"), ent("Page" as EntityType, "Jobs page"), ent("Observation" as EntityType, "x")],
    }), ctx());
    expect(write.nodes).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual(Array(3).fill(expect.stringMatching(/not extractable/)));
  });

  it("never emits Allevia's own agents or teams", async () => {
    const existing = known({ id: "agent:allevia-chief-of-staff", type: "Agent", name: "Meera" });
    const { write, dropped } = await resolveExtraction(ex({
      entities: [ent("Agent", "Allevia Librarian"), ent("Team", "Allevia Marketing"), ent("Agent", "Meera"), ent("Agent", "Jarvis"), ent("Task", "Fix sitemap")],
      relations: [{ from: "Meera", fromType: "Agent", type: "OWNS", to: "Fix sitemap", toType: "Task", evidence: "Search Console shows the jobs page slipping", conf: 0.9 }],
    }), ctx({ existing }));
    const all = [...write.nodes.map((n) => n.id), ...write.edges.flatMap((e) => [e.from, e.to])];
    expect(all.some((id) => /^(agent|team):allevia/.test(id))).toBe(false);
    expect(ids(write)).toEqual(["agent:jarvis", "task:fix-sitemap"]);
    expect(dropped.filter((d) => /reserved/.test(d.reason))).toHaveLength(4); // 3 entities + the OWNS edge from Meera
  });
});

describe("resolveExtraction: relations", () => {
  const base = [ent("Decision", "Pause Facebook posts"), ent("Channel", "Facebook"), ent("Channel", "Instagram")];

  it("keeps allowed relations with evidence and conf, drops the rest with a reason", async () => {
    const { write, dropped } = await resolveExtraction(ex({
      entities: base,
      relations: [
        { from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "Facebook", toType: "Channel", evidence: "We decided to pause Facebook posts.", conf: 0.93 },
        { from: "Facebook", fromType: "Channel", type: "OWNS", to: "Pause Facebook posts", toType: "Decision", evidence: "We decided to pause Facebook posts.", conf: 0.9 },
        { from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "Instagram", toType: "Channel", evidence: "Instagram (IG) is where seekers find us.", conf: 0.3 },
        { from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "WhatsApp", toType: "Channel", evidence: "We decided to pause Facebook posts.", conf: 0.9 },
        { from: "Pause Facebook posts", fromType: "Decision", type: "MENTIONS", to: "Instagram", toType: "Channel", evidence: "We decided to pause Facebook posts.", conf: 0.9 },
        { from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "Instagram", toType: "Channel", evidence: "Reels will save us money", conf: 0.9 },
        { from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "Instagram", toType: "Channel", evidence: "", conf: 0.9 },
      ],
    }), ctx());
    expect(edges(write, "AFFECTS")).toEqual(["decision:pause-facebook-posts -AFFECTS-> channel:facebook"]);
    const kept = write.edges.find((e) => e.type === "AFFECTS")!;
    expect(kept).toMatchObject({ conf: 0.93, props: { evidence: "We decided to pause Facebook posts." }, src: DOC, asOf: "2026-09-30", functional: false });
    expect(kept.since).toBe(Date.parse("2026-09-30"));
    expect(dropped.map((d) => d.reason)).toEqual([
      expect.stringMatching(/Channel -\[OWNS\]-> Decision is not allowed/),
      expect.stringMatching(/conf/),
      expect.stringMatching(/unknown.*WhatsApp/),
      expect.stringMatching(/MENTIONS is not extractable/),
      expect.stringMatching(/evidence not found/),
      expect.stringMatching(/no evidence/),
    ]);
  });

  it("resolves an endpoint the model did not list when the graph already knows it", async () => {
    const existing = known({ id: "business:crumb-co", type: "Business", name: "Crumb & Co." });
    const { write } = await resolveExtraction(ex({
      entities: [ent("Audience", "Job seekers")],
      relations: [{ from: "Crumb & Co.", fromType: "Business", type: "TARGETS", to: "Job seekers", toType: "Audience", evidence: "Instagram (IG) is where seekers find us.", conf: 0.8 }],
    }), ctx({ existing }));
    expect(edges(write, "TARGETS")).toEqual(["business:crumb-co -TARGETS-> audience:job-seekers"]);
    expect(ids(write)).toEqual(["audience:job-seekers"]);
  });

  it("clips long evidence and keeps the most confident duplicate", async () => {
    const long = `${TEXT} ${TEXT}`.replace(/\n/g, " ");
    const { write } = await resolveExtraction(ex({
      entities: base,
      relations: [
        { from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "Facebook", toType: "Channel", evidence: "We decided to pause Facebook posts.", conf: 0.7 },
        { from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "Facebook", toType: "Channel", evidence: "We decided to pause Facebook posts.", conf: 0.9 },
        { from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "Instagram", toType: "Channel", evidence: long, conf: 0.8 },
      ],
    }), ctx({ text: long }));
    const affects = write.edges.filter((e) => e.type === "AFFECTS");
    expect(affects.map((e) => e.conf)).toEqual([0.9, 0.8]);
    expect(String(affects[1]!.props!.evidence).length).toBeLessThanOrEqual(200);
  });
});

describe("resolveExtraction: observations", () => {
  it("inherits the document date, keeps an explicit one, slugs the metric and links BASED_ON by ref", async () => {
    const { write, dropped } = await resolveExtraction(ex({
      entities: [ent("Channel", "Instagram"), ent("Decision", "Pause Facebook posts")],
      observations: [
        { ref: "o1", metric: "Share of reach", subject: "Instagram", subjectType: "Channel", value: 90, unit: "%", asOf: "2026-09-28", evidence: "reels drove 90% of reach" },
        { ref: "o2", metric: "followers", subject: "Instagram", subjectType: "Channel", value: 1200, evidence: "Instagram (IG) is where seekers find us." },
        { ref: "o3", metric: "reach", subject: "TikTok", subjectType: "Channel", value: 5, evidence: "reels drove 90% of reach" },
        { ref: "o4", metric: "reach", subject: "Instagram", subjectType: "Channel", value: 5, asOf: "28 Sep", evidence: "reels drove 90% of reach" },
      ],
      relations: [
        { from: "Pause Facebook posts", fromType: "Decision", type: "BASED_ON", to: "o1", toType: "Observation", evidence: "As of 28 Sep reels drove 90% of reach.", conf: 0.9 },
        { from: "Pause Facebook posts", fromType: "Decision", type: "BASED_ON", to: "o9", toType: "Observation", evidence: "As of 28 Sep reels drove 90% of reach.", conf: 0.9 },
      ],
    }), ctx());
    expect(write.observations).toEqual([
      { subject: "channel:instagram", metric: "share_of_reach", value: 90, unit: "%", asOf: "2026-09-28", src: DOC, evidence: "reels drove 90% of reach" },
      { subject: "channel:instagram", metric: "followers", value: 1200, asOf: "2026-09-30", src: DOC, evidence: "Instagram (IG) is where seekers find us." },
    ]);
    expect(edges(write, "BASED_ON")).toEqual(["decision:pause-facebook-posts -BASED_ON-> obs:share_of_reach:channel:instagram:2026-09-28"]);
    expect(dropped.map((d) => d.reason)).toEqual([
      expect.stringMatching(/unknown.*TikTok/),
      expect.stringMatching(/date/),
      expect.stringMatching(/observation o9/),
    ]);
  });

  it("drops a number with no date anywhere, and keeps a stated window", async () => {
    const o = { metric: "signups", subject: "Instagram", subjectType: "Channel" as const, value: 55, evidence: "reels drove 90% of reach" };
    const { write, dropped } = await resolveExtraction(ex({
      entities: [ent("Channel", "Instagram")],
      observations: [o, { ...o, metric: "weekly signups", windowStart: "2026-09-29", windowEnd: "2026-10-05" }],
    }), ctx({ asOf: undefined }));
    expect(dropped.map((d) => d.reason)).toEqual([expect.stringMatching(/no date/)]);
    expect(write.observations).toEqual([expect.objectContaining({ metric: "weekly_signups", windowStart: "2026-09-29", windowEnd: "2026-10-05", asOf: "2026-10-05" })]);
  });
});

describe("rememberWrite", () => {
  it("adds written entities to the known map so the next document resolves to them", async () => {
    const existing = new Map<string, KnownEntity>();
    const first = await resolveExtraction(ex({ entities: [ent("System", "Google Search Console", "Google's tool.", ["GSC"])] }), ctx({ existing }));
    rememberWrite(existing, first.write);
    expect(existing.get("system:google-search-console")).toEqual({ id: "system:google-search-console", type: "System", name: "Google Search Console", aliases: ["GSC"] });
    const second = await resolveExtraction(ex({ entities: [ent("System", "GSC")] }), ctx({ existing, docId: "document:note-2" }));
    expect(edges(second.write, "MENTIONS")).toEqual(["document:note-2 -MENTIONS-> system:google-search-console"]);
  });
});

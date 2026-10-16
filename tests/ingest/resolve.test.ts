import { describe, it, expect } from "vitest";
import { ONTOLOGY_VERSION, type EntityType } from "../../src/graph/schema.js";
import {
  EXTRACTED_OBSERVATION_CONF, FOUNDER_ID, MERGE_SIMILARITY, namesAgree, normName, normQuote, numberProblem, numbersIn, quoteProblem, rememberWrite, resolveExtraction,
  type Extraction, type KnownEntity, type ResolveContext,
} from "../../src/ingest/extract.js";
import type { GraphWrite } from "../../src/ingest/types.js";

const DOC = "document:note-1";
const TEXT = `Search Console shows the jobs page slipping. As of 28 Sep reels drove 90% of reach.
We decided to pause Facebook posts. Decided by Ankit. Instagram (IG) is where seekers find us.
Instagram has 1,200 followers. 55 new users signed up between 29 Sep and 5 Oct.
Partners: Priya Shah and Rahul Mehta founded the studio. The "Riverside House" project won an award.`;

const ent = (type: EntityType, name: string, summary = `${name}.`, aliases?: string[]) => ({ type, name, summary, ...(aliases ? { aliases } : {}) });
const ex = (p: Partial<Extraction>): Extraction => ({ entities: [], relations: [], observations: [], ...p });
const known = (...ks: KnownEntity[]) => new Map(ks.map((k) => [k.id, k]));
const ctx = (p: Partial<ResolveContext> = {}): ResolveContext => ({ docId: DOC, asOf: "2026-09-30", existing: new Map(), text: TEXT, ...p });

const ids = (w: GraphWrite) => w.nodes.map((n) => n.id).sort();
const edges = (w: GraphWrite, type?: string) => w.edges.filter((e) => !type || e.type === type).map((e) => `${e.from} -${e.type}-> ${e.to}`).sort();

const GSC: KnownEntity = { id: "system:google-search-console", type: "System", name: "Google Search Console" };

describe("names", () => {
  it("normName ignores case, punctuation and a leading 'the'", () => {
    expect(normName("The  Founder!")).toBe("founder");
    expect(normName("Google Search-Console")).toBe("google search console");
    expect(normName("कितने नए users")).toBe("कितने नए users");
  });

  it("namesAgree: same words, an acronym, or a 2+ word name extended by one word at most", () => {
    expect(namesAgree(["Search Console"], ["Google Search Console"])).toBe(true);
    expect(namesAgree(["console search"], ["Search Console"])).toBe(true);
    expect(namesAgree(["GSC"], ["Google Search Console"])).toBe(true);
    expect(namesAgree(["GA4"], ["Google Analytics 4"])).toBe(true);
    expect(namesAgree(["Jobs app", "Aamdani app"], ["Aamdani Jobs app"])).toBe(true);
  });

  it("namesAgree refuses the merges review found wrong, and other shared-word pairs", () => {
    expect(namesAgree(["Job seekers"], ["Job seekers in Raipur"])).toBe(false);
    expect(namesAgree(["Instagram"], ["Instagram Ads"])).toBe(false);
    expect(namesAgree(["Google"], ["Google Search Console"])).toBe(false);
    expect(namesAgree(["Meta"], ["Metabase"])).toBe(false);
    expect(namesAgree(["Insta"], ["Instagram"])).toBe(false);
    expect(namesAgree(["Instagram"], ["Facebook"])).toBe(false);
    expect(namesAgree(["Pause Facebook posts"], ["Pause Instagram posts"])).toBe(false);
    expect(namesAgree(["Job seekers in Raipur"], ["Job seekers in Bilaspur"])).toBe(false);
    expect(namesAgree(["IG"], ["Instagram"])).toBe(false);
  });
});

describe("evidence", () => {
  const doc = normQuote(TEXT);

  it("needs every part of a quote to be 3+ words found verbatim, up to case, spacing and typography", () => {
    expect(quoteProblem("We decided to pause Facebook posts.", doc)).toBeUndefined();
    expect(quoteProblem("we  DECIDED to pause\nfacebook posts", doc)).toBeUndefined();
    expect(quoteProblem("The “Riverside House” project won", doc)).toBeUndefined();
    expect(quoteProblem("We decided to pause … Decided by Ankit", doc)).toBeUndefined();
    expect(quoteProblem("We decided to pause...Decided by", doc)).toMatch(/shorter than 3 words/);
    expect(quoteProblem("Decided by", doc)).toMatch(/shorter than 3 words/);
    expect(quoteProblem("We decided to stop Facebook posts", doc)).toMatch(/not found/);
    expect(quoteProblem("", doc)).toMatch(/no evidence/);
  });

  it("reads numbers off a quote: digits, Indian grouping, multipliers, words, Devanagari digits", () => {
    expect(numbersIn("Revenue was ₹1.2 lakh")).toContain(120000);
    expect(numbersIn("1,20,000 rupees")).toContain(120000);
    expect(numbersIn("about 55k views")).toContain(55000);
    expect(numbersIn("two lakh impressions")).toContain(200000);
    expect(numbersIn("twenty five new leads")).toContain(25);
    expect(numbersIn("५५ नए users")).toContain(55);
    expect(numbersIn("do it now, teen spirit")).toEqual([]);
    expect(numberProblem(90, "reels drove 90% of reach")).toBeUndefined();
    expect(numberProblem(1300, "Instagram has 1,200 followers")).toMatch(/does not appear/);
    expect(numberProblem(5, "Instagram is where seekers find us")).toMatch(/no number/);
  });

  it("accepts a whole quote found verbatim even when it contains an ellipsis", () => {
    const hinglish = normQuote("Update: Kal 55 naye users aaye... mast. Aaj bhi accha raha.");
    expect(quoteProblem("Kal 55 naye users aaye... mast", hinglish)).toBeUndefined();
    expect(quoteProblem("kal 55 naye users aaye… MAST", hinglish)).toBeUndefined(); // "…" is "..." after NFKC
    // not verbatim as a whole: each part must stand on its own, and "mast" is one word
    expect(quoteProblem("Kal 55 naye users aaye ... mast hai", hinglish)).toMatch(/not found|shorter/);
    expect(quoteProblem("Kal 55 naye users ... mast", hinglish)).toMatch(/"mast" is shorter than 3 words/);
    // the whole quote still needs 3 words
    expect(quoteProblem("aaye... mast", hinglish)).toMatch(/shorter than 3 words/);
  });

  it("lets an observation's 2-word quote through when it contains the value, as in a table row", () => {
    const table = normQuote("| Channel | Followers |\n|---|---|\n| Instagram | 1,200 |\n| Facebook | 300 |");
    expect(quoteProblem("| Instagram | 1,200 |", table, { value: 1200 })).toBeUndefined();
    expect(quoteProblem("Instagram | 1,200", table, { value: 1200 })).toBeUndefined();
    expect(quoteProblem("| Instagram | 1,200 |", table, { value: 300 })).toMatch(/shorter than 3 words/);
    expect(quoteProblem("| Instagram | 1,200 |", table)).toMatch(/shorter than 3 words/); // relations need 3 words
    expect(quoteProblem("| 1,200 |", table, { value: 1200 })).toMatch(/shorter/); // one word is never enough
    expect(quoteProblem("| Instagram | 1,300 |", table, { value: 1300 })).toMatch(/not found/);
  });

  it("reads multiplier suffixes and words: L, M, K, cr, hundred, Devanagari lakh/crore/hazaar", () => {
    expect(numbersIn("revenue 1.5L this month")).toContain(150000);
    expect(numbersIn("1.2M impressions")).toContain(1200000);
    expect(numbersIn("55K views")).toContain(55000);
    expect(numbersIn("₹2cr pipeline")).toContain(20000000);
    expect(numbersIn("₹1.2 लाख की बिक्री")).toContain(120000);
    expect(numbersIn("3 \u0915\u0930\u094B\u095C")).toContain(30000000); // करोड़ with the nukta, precomposed…
    expect(numbersIn("3 \u0915\u0930\u094B\u0921\u093C")).toContain(30000000); // …or as ड + nukta
    expect(numbersIn("3 \u0915\u0930\u094B\u0921")).toContain(30000000); // and without it
    expect(numbersIn("5 \u0939\u095B\u093E\u0930")).toContain(5000); // हज़ार, precomposed nukta
    expect(numbersIn("5 \u0939\u091C\u093E\u0930")).toContain(5000); // हजार, no nukta
    expect(numbersIn("4 hazar log")).toContain(4000);
    expect(numbersIn("two hundred orders")).toContain(200);
    expect(numbersIn("3 hundred orders")).toContain(300);
    expect(numbersIn("twenty five lakh")).toContain(2500000);
  });

  it("reads Hinglish small numbers only right before a multiplier", () => {
    expect(numbersIn("do hazaar followers")).toContain(2000);
    expect(numbersIn("teen lakh ka order")).toContain(300000);
    expect(numbersIn("char hazaar")).toContain(4000);
    expect(numbersIn("paanch lakh")).toContain(500000);
    expect(numbersIn("dedh lakh revenue")).toContain(150000);
    expect(numbersIn("dhai hazaar")).toContain(2500);
    expect(numbersIn("sawa lakh")).toContain(125000);
    expect(numbersIn("saade teen lakh")).toContain(350000);
    expect(numbersIn("sawa do lakh")).toContain(225000);
    expect(numbersIn("दो लाख")).toContain(200000);
    expect(numbersIn("डेढ़ लाख")).toContain(150000);
    expect(numbersIn("साढ़े तीन लाख")).toContain(350000);
    // not numbers on their own
    expect(numbersIn("do it now, teen spirit, char grill, sawa kya hai")).toEqual([]);
    expect(numbersIn("dedh baje aana")).toEqual([]);
    expect(numberProblem(2000, "do hazaar naye followers")).toBeUndefined();
    expect(numberProblem(150000, "Sale dedh lakh ki hui")).toBeUndefined();
  });

  it("reads Hinglish tens; the ones that are English words (bees, tees, saath) only before a multiplier", () => {
    expect(numbersIn("das naye leads")).toContain(10);
    expect(numbersIn("chalis orders aaye")).toContain(40);
    expect(numbersIn("chaalis")).toContain(40);
    expect(numbersIn("pachas log")).toContain(50);
    expect(numbersIn("pachaas")).toContain(50);
    expect(numbersIn("sattar")).toContain(70);
    expect(numbersIn("assi")).toContain(80);
    expect(numbersIn("nabbe")).toContain(90);
    expect(numbersIn("bees hazaar views")).toContain(20000);
    expect(numbersIn("tees lakh")).toContain(3000000);
    expect(numbersIn("saath hazaar")).toContain(60000);
    expect(numbersIn("bees buzz near the tees, unke saath")).toEqual([]);
  });

  it("reads sau as a multiplier and the karod/karor, hajar/hajaar, laakh spellings", () => {
    expect(numbersIn("paanch sau orders")).toContain(500);
    expect(numbersIn("do sau")).toContain(200);
    expect(numbersIn("dedh sau")).toContain(150);
    expect(numbersIn("sau log aaye")).toContain(100);
    expect(numbersIn("2 karod")).toContain(20000000);
    expect(numbersIn("2 karor")).toContain(20000000);
    expect(numbersIn("5 hajar")).toContain(5000);
    expect(numbersIn("5 hajaar")).toContain(5000);
    expect(numbersIn("3 laakh")).toContain(300000);
    expect(numbersIn("do laakh")).toContain(200000);
  });

  it("adds up compound amounts with falling multipliers", () => {
    expect(numbersIn("1 lakh 20 thousand")).toContain(120000);
    expect(numbersIn("₹2 crore 50 lakh")).toContain(25000000);
    expect(numbersIn("do lakh pachas hazaar")).toContain(250000);
    expect(numbersIn("do hazaar paanch sau")).toContain(2500);
    expect(numbersIn("1 lakh 20 hazaar 500")).toContain(120500);
    expect(numbersIn("1 lakh aur 20 hazaar")).toContain(120000);
    expect(numberProblem(120000, "Revenue 1 lakh 20 thousand this month")).toBeUndefined();
    // a rising multiplier or a word in between starts a new amount
    expect(numbersIn("20 thousand 1 lakh")).not.toContain(120000);
    expect(numbersIn("1 lakh, 20 thousand")).toContain(120000); // punctuation is not a break: a harmless extra candidate
    expect(numbersIn("1 lakh users, 20 thousand orders")).not.toContain(120000);
    expect(numbersIn("1 lakh users and then 20 thousand")).not.toContain(120000);
    expect(numbersIn("1 lakh or 20 thousand")).not.toContain(120000);
  });

  it("counts a one-letter multiplier only straight after the digits", () => {
    expect(numbersIn("5 m tall")).toEqual([5]);
    expect(numbersIn("a 2 l bottle")).toEqual([2]);
    expect(numbersIn("3 k steps")).toEqual([3]);
    expect(numbersIn("5km run")).toEqual([5]);
    expect(numbersIn("10ml")).toEqual([10]);
    expect(numbersIn("55k views")).toContain(55000);
    expect(numbersIn("₹2 cr")).toContain(20000000);
    expect(numbersIn("2 Cr")).toContain(20000000);
    expect(numbersIn("2cr")).toContain(20000000);
    expect(numberProblem(5000000, "the sign is 5 m tall")).toMatch(/does not appear/);
    expect(numberProblem(200000, "a 2 l bottle")).toMatch(/does not appear/);
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

  it("merges through similar() only at or above the threshold", async () => {
    const existing = known(GSC);
    const at = (score: number) => ctx({ existing, similar: async (type, name) => (type === "System" && name === "Search Console" ? { id: GSC.id, score } : null) });

    const merged = await resolveExtraction(ex({ entities: [ent("System", "Search Console")] }), at(MERGE_SIMILARITY));
    expect(edges(merged.write, "MENTIONS")).toEqual([`${DOC} -MENTIONS-> ${GSC.id}`]);
    // the merge teaches the existing node the new name, without renaming it
    expect(merged.write.nodes).toEqual([{ type: "System", id: GSC.id, name: "Google Search Console", props: { aliases: ["Search Console"] } }]);

    const below = await resolveExtraction(ex({ entities: [ent("System", "Search Console")] }), at(0.91));
    expect(ids(below.write)).toEqual(["system:search-console"]);
    expect(below.write.edges.find((e) => e.type === "MENTIONS")!.props).toBeUndefined();
  });

  it("merges an acronym, but not a high-scoring name that disagrees (e5 puts Instagram and Facebook at 0.96)", async () => {
    const existing = known(GSC, { id: "channel:instagram-ads", type: "Channel", name: "Instagram Ads" });
    const similar = async (type: EntityType) => (type === "System" ? { id: GSC.id, score: 0.93 } : { id: "channel:instagram-ads", score: 0.97 });
    const { write } = await resolveExtraction(ex({ entities: [ent("System", "GSC"), ent("Channel", "Instagram")] }), ctx({ existing, similar }));
    expect(edges(write, "MENTIONS")).toEqual([`${DOC} -MENTIONS-> channel:instagram`, `${DOC} -MENTIONS-> ${GSC.id}`]);
    expect(ids(write)).toEqual(["channel:instagram", GSC.id]); // the new channel, and GSC learning its acronym
    // the disagreement is kept for the librarian: a low-confidence MENTIONS with maybeSameAs
    const m = write.edges.find((e) => e.type === "MENTIONS" && e.to === "channel:instagram")!;
    expect(m.props).toEqual({ maybeSameAs: "channel:instagram-ads" });
    expect(m.conf).toBeLessThan(0.6);
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

  it("resolves the founder's names and unnamed references to person:founder", async () => {
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
    expect(fresh.write.nodes.map((n) => [n.id, n.type, n.name])).toEqual([[FOUNDER_ID, "Person", "Founder"]]);
  });

  it("keeps named partners as their own people; a founder alias alone does not make someone the founder", async () => {
    const partners = ex({
      entities: [ent("Person", "Priya Shah", "Partner.", ["the founder"]), ent("Person", "Rahul Mehta", "Partner.", ["founder"]), ent("Person", "the owner")],
    });
    const plain = await resolveExtraction(partners, ctx());
    expect(ids(plain.write)).toEqual([FOUNDER_ID, "person:priya-shah", "person:rahul-mehta"]);
    expect(plain.write.nodes.find((n) => n.id === "person:priya-shah")!.props).toBeUndefined(); // a role word is not an alias
    // founderNames win: the configured founder is person:founder, the other partner stays themselves
    const configured = await resolveExtraction(partners, ctx({ founderNames: ["Priya Shah"] }));
    expect(ids(configured.write)).toEqual([FOUNDER_ID, "person:rahul-mehta"]);
    expect(configured.write.nodes.find((n) => n.id === FOUNDER_ID)!.name).toBe("Priya Shah");
  });

  it("merges duplicate entities within one document", async () => {
    const { write } = await resolveExtraction(ex({
      entities: [ent("Channel", "Instagram", "Where seekers find us."), ent("Channel", "instagram", "", ["IG"]), ent("Channel", "Insta", "", ["Instagram"])],
    }), ctx());
    expect(write.nodes).toHaveLength(1);
    expect(write.nodes[0]).toMatchObject({ id: "channel:instagram", name: "Instagram", summary: "Where seekers find us.", props: { aliases: ["IG", "Insta"] } });
    expect(edges(write, "MENTIONS")).toEqual([`${DOC} -MENTIONS-> channel:instagram`]);
  });

  it("keeps a Content format such as a portfolio project, and ignores it elsewhere", async () => {
    const { write } = await resolveExtraction(ex({
      entities: [{ ...ent("Content", "Riverside House"), format: "project" }, { ...ent("Content", "Monsoon reel"), format: "tiktok" }, { ...ent("Channel", "Instagram"), format: "reel" }],
    }), ctx());
    expect(write.nodes.map((n) => [n.id, n.props?.format])).toEqual([
      ["content:riverside-house", "project"], ["content:monsoon-reel", undefined], ["channel:instagram", undefined],
    ]);
  });

  it("never emits types outside the extractable set", async () => {
    const { write, dropped } = await resolveExtraction(ex({
      entities: [ent("Document" as EntityType, "Some note"), ent("Page" as EntityType, "Jobs page"), ent("Observation" as EntityType, "x")],
    }), ctx());
    expect(write.nodes).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual(Array(3).fill(expect.stringMatching(/not extractable/)));
  });

  it("never emits Allevia's own agent or team ids, but plain names are the business's own", async () => {
    const existing = known(
      { id: "agent:allevia-chief-of-staff", type: "Agent", name: "Meera" },
      { id: "team:allevia-marketing", type: "Team", name: "Marketing" },
    );
    const similar = async (type: EntityType) => (type === "Team" ? { id: "team:allevia-marketing", score: 0.99 } : null);
    const { write, dropped } = await resolveExtraction(ex({
      entities: [ent("Agent", "Allevia Librarian"), ent("Team", "Allevia Content Studio"), ent("Agent", "Meera"), ent("Team", "Marketing"), ent("Task", "Fix sitemap")],
      relations: [{ from: "Meera", fromType: "Agent", type: "OWNS", to: "Fix sitemap", toType: "Task", evidence: "Search Console shows the jobs page slipping", conf: 0.9 }],
    }), ctx({ existing, similar }));
    const all = [...write.nodes.map((n) => n.id), ...write.edges.flatMap((e) => [e.from, e.to])];
    expect(all.some((id) => /^(agent|team):allevia/.test(id))).toBe(false);
    expect(ids(write)).toEqual(["agent:meera", "task:fix-sitemap", "team:marketing"]);
    expect(edges(write, "OWNS")).toEqual(["agent:meera -OWNS-> task:fix-sitemap"]);
    expect(dropped.map((d) => d.reason)).toEqual([expect.stringMatching(/reserved id agent:allevia-librarian/), expect.stringMatching(/reserved id team:allevia-content-studio/)]);
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
        { from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "Instagram", toType: "Channel", evidence: "pause Facebook", conf: 0.9 },
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
      expect.stringMatching(/shorter than 3 words/),
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

describe("resolveExtraction: who said it", () => {
  const input = ex({
    entities: [ent("Decision", "Pause Facebook posts"), ent("Channel", "Facebook")],
    relations: [{ from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "Facebook", toType: "Channel", evidence: "We decided to pause Facebook posts.", conf: 0.93 }],
  });

  it("with a model, every edge the extraction writes records extractedBy and the ontology version (G17c)", async () => {
    const { write } = await resolveExtraction(input, ctx({ model: "haiku" }));
    expect(write.edges.length).toBeGreaterThanOrEqual(5);
    for (const e of write.edges) expect(e.props, `${e.from} -${e.type}-> ${e.to}`).toMatchObject({ extractedBy: "haiku", ontologyVersion: ONTOLOGY_VERSION });
    // the relation keeps its evidence beside them
    expect(write.edges.find((e) => e.type === "AFFECTS")!.props).toEqual({ evidence: "We decided to pause Facebook posts.", extractedBy: "haiku", ontologyVersion: ONTOLOGY_VERSION });
  });

  it("a maybe-the-same mention keeps its marker next to them", async () => {
    const similar = async () => ({ id: "channel:facebook", score: 0.95 });
    const { write } = await resolveExtraction(ex({ entities: [ent("Channel", "Insta")] }), ctx({ model: "haiku", existing: known({ id: "channel:facebook", type: "Channel", name: "Facebook" }), similar }));
    const m = write.edges.find((e) => e.type === "MENTIONS" && e.props?.maybeSameAs)!;
    expect(m.props).toMatchObject({ maybeSameAs: "channel:facebook", extractedBy: "haiku", ontologyVersion: ONTOLOGY_VERSION });
  });

  it("without one (a caller that does not know), the edges are exactly what they were", async () => {
    const { write } = await resolveExtraction(input, ctx());
    expect(write.edges.filter((e) => e.props && "extractedBy" in e.props)).toEqual([]);
    expect(write.edges.find((e) => e.type === "AFFECTS")!.props).toEqual({ evidence: "We decided to pause Facebook posts." });
  });
});

describe("resolveExtraction: observations", () => {
  it("inherits the document date, keeps an explicit one, slugs the metric and links BASED_ON by ref", async () => {
    const { write, dropped } = await resolveExtraction(ex({
      entities: [ent("Channel", "Instagram"), ent("Decision", "Pause Facebook posts")],
      observations: [
        { ref: "o1", metric: "Share of reach", subject: "Instagram", subjectType: "Channel", value: 90, unit: "%", asOf: "2026-09-28", evidence: "reels drove 90% of reach" },
        { ref: "o2", metric: "followers", subject: "Instagram", subjectType: "Channel", value: 1200, evidence: "Instagram has 1,200 followers." },
        { ref: "o3", metric: "reach", subject: "TikTok", subjectType: "Channel", value: 90, evidence: "reels drove 90% of reach" },
        { ref: "o4", metric: "reach", subject: "Instagram", subjectType: "Channel", value: 90, asOf: "28 Sep", evidence: "reels drove 90% of reach" },
        { ref: "o5", metric: "followers_new", subject: "Instagram", subjectType: "Channel", value: 1300, evidence: "Instagram has 1,200 followers." },
        { ref: "o6", metric: "seekers", subject: "Instagram", subjectType: "Channel", value: 3, evidence: "Instagram (IG) is where seekers find us." },
      ],
      relations: [
        { from: "Pause Facebook posts", fromType: "Decision", type: "BASED_ON", to: "o1", toType: "Observation", evidence: "As of 28 Sep reels drove 90% of reach.", conf: 0.9 },
        { from: "Pause Facebook posts", fromType: "Decision", type: "BASED_ON", to: "o9", toType: "Observation", evidence: "As of 28 Sep reels drove 90% of reach.", conf: 0.9 },
      ],
    }), ctx());
    expect(write.observations).toEqual([
      // conf < 1: a number reported in a document never replaces one a connector measured (graph/observations.ts)
      { subject: "channel:instagram", metric: "share_of_reach", value: 90, unit: "%", asOf: "2026-09-28", src: DOC, evidence: "reels drove 90% of reach", conf: EXTRACTED_OBSERVATION_CONF },
      { subject: "channel:instagram", metric: "followers", value: 1200, asOf: "2026-09-30", src: DOC, evidence: "Instagram has 1,200 followers.", conf: EXTRACTED_OBSERVATION_CONF },
    ]);
    expect(EXTRACTED_OBSERVATION_CONF).toBeGreaterThan(0);
    expect(EXTRACTED_OBSERVATION_CONF).toBeLessThan(1);
    expect(write.observations.map((o) => o.conf)).toEqual([EXTRACTED_OBSERVATION_CONF, EXTRACTED_OBSERVATION_CONF]);
    expect(edges(write, "BASED_ON")).toEqual(["decision:pause-facebook-posts -BASED_ON-> obs:share_of_reach:channel:instagram:2026-09-28"]);
    expect(dropped.map((d) => d.reason)).toEqual([
      expect.stringMatching(/unknown.*TikTok/),
      expect.stringMatching(/date/),
      expect.stringMatching(/value 1300 does not appear/),
      expect.stringMatching(/no number/),
      expect.stringMatching(/observation o9/),
    ]);
  });

  it("keeps a number quoted from a table row", async () => {
    const table = "Followers by channel\n\n| Channel | Followers |\n|---|---|\n| Instagram | 1,200 |\n| Facebook | 300 |";
    const { write, dropped } = await resolveExtraction(ex({
      entities: [ent("Channel", "Instagram"), ent("Channel", "Facebook")],
      observations: [
        { ref: "o1", metric: "followers", subject: "Instagram", subjectType: "Channel", value: 1200, evidence: "| Instagram | 1,200 |" },
        { ref: "o2", metric: "followers", subject: "Facebook", subjectType: "Channel", value: 3000, evidence: "| Facebook | 300 |" },
      ],
    }), ctx({ text: table }));
    expect(write.observations).toEqual([expect.objectContaining({ subject: "channel:instagram", metric: "followers", value: 1200 })]);
    expect(dropped.map((d) => d.reason)).toEqual([expect.stringMatching(/shorter than 3 words/)]);
  });

  it("drops a number with no date anywhere, and keeps a stated window", async () => {
    const o = { metric: "signups", subject: "Instagram", subjectType: "Channel" as const, value: 55, evidence: "55 new users signed up" };
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

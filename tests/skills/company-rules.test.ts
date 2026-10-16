// The rules an owner tells the team reach the business's skills whole (Aamdani, issue #25): the palette lost its cream and
// forest colours to a 170-character cut, and every rule printed its own name and then its text again.
import { afterAll, describe, expect, it } from "vitest";
import { companyFacts, companySkills, companySlug, type CompanyFacts } from "../../src/agent/skills/company.js";
import { MAX_BUSINESS_BODY } from "../../src/agent/skills/format.js";
import { closeAll } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of cleanups) await c(); await closeAll(); });

const facts = (over: Partial<CompanyFacts>): CompanyFacts => ({
  slug: companySlug("Shop"), name: "Shop", summary: "A shop.", tone: [], dos: [], donts: [], visual: [], sayInstead: [], audiences: [], needs: [],
  products: [], features: [], hooks: [], worked: [], weakest: [], channels: [], ...over,
});

const PALETTE = "App palette for social assets is olive #4A6741 (primary), gold #C8A23D (call to action), cream #FDFCF6 (paper) and forest #1A3C34 (headings), with the website using a related set of deep greens, cream and a rare brass accent #C5A059.";

describe("rules in a business's skills", () => {
  it("a rule of up to 300 characters is shown whole, so the palette keeps all four colours", () => {
    const voice = companySkills(facts({ visual: [PALETTE] })).find((s) => s.id.endsWith("-brand-voice"))!;
    for (const hex of ["#4A6741", "#C8A23D", "#FDFCF6", "#1A3C34", "#C5A059"]) expect(voice.text).toContain(hex);
    expect(voice.text).toContain("a rare brass accent #C5A059.");
  });

  it("when the rules would not fit a skill, each is cut at 170 characters as before, and no skill is too long", () => {
    const long = (i: number) => `Rule ${i}: ${"word ".repeat(55)}end ${i}.`.slice(0, 295);
    const some = (n: number) => Array.from({ length: n }, (_, i) => long(i));
    // 12 + 12 long rules fit at 170 characters but not at 300
    const mid = companySkills(facts({ dos: some(12), donts: some(12).map((x) => `Never ${x}`), visual: [PALETTE] }));
    for (const s of mid) expect(s.text.length, s.id).toBeLessThanOrEqual(MAX_BUSINESS_BODY);
    const voice = mid.find((s) => s.id.endsWith("-brand-voice"))!;
    expect(voice.text).toContain("Rule 0: word word");
    expect(voice.text).not.toContain("end 0.");           // cut
    expect(voice.text).toMatch(/Rule 0: (?:word ){1,}.{0,10}…/);
    // 25 + 25 long rules do not fit even cut: fewer are listed, and the skill is still not too long
    const most = companySkills(facts({ dos: some(25), donts: some(25).map((x) => `Never ${x}`), visual: [PALETTE] }));
    for (const s of most) expect(s.text.length, s.id).toBeLessThanOrEqual(MAX_BUSINESS_BODY);
    expect(most.find((s) => s.id.endsWith("-brand-voice"))!.text).toContain("Rule 0: word word");
  });

  it("when rules must be cut, the owner's own are cut last: they stay whole while the extracted ones are cut at 170", () => {
    const long = (tag: string) => `${tag} ${"word ".repeat(56)}end ${tag}.`.slice(0, 296).replace(/\s*$/, ` end ${tag}.`);
    const dos = ["told", ...Array.from({ length: 11 }, (_, i) => `ex${i}`)].map(long);
    const donts = Array.from({ length: 12 }, (_, i) => `Never ex${i} ${long(`d${i}`)}`.slice(0, 296)).map((x, i) => `${x.slice(0, 280)} end d${i}.`);
    const voice = companySkills(facts({ dos, donts, told: { dos: 1, donts: 0, visual: 0 } })).find((s) => s.id.endsWith("-brand-voice"))!;
    expect(voice.text).toContain("end told.");           // the owner's rule, whole
    expect(voice.text).not.toContain("end ex3.");        // an extracted one, cut
    expect(voice.text).toContain("word word");
  });

  it("a rule that is a whole sentence carries no label, and a don't stays a don't when its label said so", async () => {
    const { g, cleanup } = await testGraph();
    cleanups.push(cleanup);
    await ensureIndexes(g);
    const s = await writeBatch(g, {
      nodes: [
        { type: "Business", id: "business:shop", name: "Shop" },
        { type: "BrandRule", id: "brand-rule:never-label", name: "Never use X for seekers", props: { kind: "voice", text: "Do not label a job seeker as X." } },
        { type: "BrandRule", id: "brand-rule:dignity", name: "Dignity always", props: { kind: "voice", text: "Nobody is shown helpless or pitied in any picture." } },
        { type: "BrandRule", id: "brand-rule:short", name: "Emoji", props: { kind: "voice", text: "At most two." } },
      ],
    }, NOW);
    expect(s.errors).toEqual([]);
    const f = await companyFacts(g, "shop", NOW);
    expect(f.donts).toContain("Do not label a job seeker as X.");     // the label said "Never", so it is a don't, shown without it
    expect(f.dos).not.toContain("Do not label a job seeker as X.");
    expect(f.dos).toContain("Nobody is shown helpless or pitied in any picture.");
    expect(f.dos).toContain("Emoji: At most two.");                    // too short to stand alone: its label stays
  }, 60_000);

  it("what the owner told the team comes first, and a long list of extracted rules does not push it out", async () => {
    const { g, cleanup } = await testGraph();
    cleanups.push(cleanup);
    await ensureIndexes(g);
    const extracted = Array.from({ length: 80 }, (_, i) => ({
      type: "BrandRule" as const, id: `brand-rule:a${String(i).padStart(2, "0")}`, name: `Extracted ${i}`, props: { kind: "voice", text: `Extracted rule number ${i}.` },
    }));
    const s = await writeBatch(g, {
      nodes: [
        { type: "Business", id: "business:shop", name: "Shop" }, ...extracted,
        { type: "BrandRule", id: "brand-rule:owner-z", name: "Told", props: { kind: "voice", text: "Told by the owner, sorts last by id.", origin: "owner" } },
        { type: "BrandRule", id: "brand-rule:owner-old", name: "Retired", props: { kind: "voice", text: "Replaced rule.", origin: "owner", status: "superseded" } },
      ],
    }, NOW);
    expect(s.errors).toEqual([]);
    const f = await companyFacts(g, "shop", NOW);
    expect(f.dos[0]).toBe("Told by the owner, sorts last by id.");
    expect(f.dos.length).toBeGreaterThan(60);                  // more than the old limit of 60 rules
    expect(f.dos.join()).not.toMatch(/Replaced rule/);          // a retired rule stays out
  }, 60_000);

  it("a rule named with its own first words shows its text once", async () => {
    const { g, cleanup } = await testGraph();
    cleanups.push(cleanup);
    await ensureIndexes(g);
    const text = "No missing nukta, so write ख़र्च, ख़ुद, ख़बर, अर्ज़ी, फ़ोन and मुफ़्त in full, and keep idioms whole, like one rupee not at all.";
    const s = await writeBatch(g, {
      nodes: [
        { type: "Business", id: "business:shop", name: "Shop" },
        { type: "BrandRule", id: "brand-rule:cut-name", name: `${text.slice(0, 79)}…`, props: { kind: "voice", text } },          // as the owner's rules are named
        { type: "BrandRule", id: "brand-rule:own-name", name: "Hashtags", props: { kind: "voice", text: "Posts use five hashtags." } }, // a real name stays
      ],
    }, NOW);
    expect(s.errors).toEqual([]);
    const f = await companyFacts(g, "shop", NOW);
    expect(f.donts).toContain(text);                       // a rule that starts "No ..." is a don't
    expect(f.dos).toContain("Hashtags: Posts use five hashtags.");
    expect([...f.dos, ...f.donts].some((d) => d.includes("…:"))).toBe(false);
  }, 60_000);
});

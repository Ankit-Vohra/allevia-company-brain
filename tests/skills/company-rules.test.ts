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

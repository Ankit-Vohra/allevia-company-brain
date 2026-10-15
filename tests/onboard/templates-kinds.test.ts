// Industry templates for businesses that are not a jobs platform or an architecture studio. The web form sends no
// industry, so every site onboarded from its URL used to get the local-business template: a dentist's goals were
// "Enquiries per month, Instagram reach, Search clicks" and a SaaS company's too (docs/onboarding-trials.md).
// Now the site's own profile says what kind of business it is, and that picks the template.
import { describe, it, expect } from "vitest";
import { AGENTS } from "../../shared/roster.js";
import { TEMPLATES, templateByKind, templateFor, type IndustryTemplate } from "../../src/onboard/templates.js";
import { profileBusiness, makeAsk, PROFILE_SCHEMA } from "../../src/ingest/sources/website/index.js";
import { FakeLlm } from "../helpers/fake-llm.js";

describe("templates for kinds of business", () => {
  it("picks a template from the words people use for their business", () => {
    const key = (s: string) => templateFor(s).key;
    expect(key("dental practice")).toBe("health_and_beauty");
    expect(key("family dentistry")).toBe("health_and_beauty");
    expect(key("hair salon")).toBe("health_and_beauty");
    expect(key("physiotherapy clinic")).toBe("health_and_beauty");
    expect(key("coffee shop")).toBe("food_and_drink");
    expect(key("café and kitchen")).toBe("food_and_drink");
    expect(key("bakery")).toBe("food_and_drink");
    expect(key("restaurant")).toBe("food_and_drink");
    expect(key("online shop selling plants")).toBe("online_shop");
    expect(key("ecommerce store")).toBe("online_shop");
    expect(key("web analytics software")).toBe("software_product");
    expect(key("SaaS")).toBe("software_product");
    // what already worked still does
    expect(key("jobs")).toBe("jobs_platform");
    expect(key("architecture and interior design studio")).toBe("architecture_studio");
    // a trade with no template yet keeps the local-business one
    expect(key("plumber")).toBe("local_business");
    expect(key("")).toBe("local_business");
  });

  it("maps the kind the website profile reports to a template, and ignores a kind it does not know", () => {
    expect(templateByKind("food_and_drink")!.key).toBe("food_and_drink");
    expect(templateByKind("architecture_or_design")!.key).toBe("architecture_studio");
    expect(templateByKind("jobs_or_recruitment")!.key).toBe("jobs_platform");
    expect(templateByKind("local_business")!.key).toBe("local_business");
    expect(templateByKind("spaceship")).toBeUndefined();
    expect(templateByKind(undefined)).toBeUndefined();
  });

  it("gives every template one main goal and two more, each with an owner on the team and a way to be measured", () => {
    const roster = new Set(AGENTS.map((a) => a.id));
    for (const t of TEMPLATES as readonly IndustryTemplate[]) {
      expect(t.goals, t.key).toHaveLength(3);
      expect(t.goals.map((g) => g.priority), t.key).toEqual([1, 2, 3]);
      expect(new Set(t.goals.map((g) => g.key)).size, t.key).toBe(3);
      for (const g of t.goals) {
        expect(roster.has(g.owner), `${t.key}/${g.key} owner`).toBe(true);
        expect(g.sources.length, `${t.key}/${g.key} sources`).toBeGreaterThan(0);
        expect(g.minTarget, `${t.key}/${g.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("does not set an Instagram goal for a clinic, or a signups goal for a café", () => {
    const names = (k: string) => templateByKind(k)!.goals.map((g) => g.name);
    expect(names("health_and_beauty").join("|")).not.toMatch(/Instagram/);
    expect(names("food_and_drink").join("|")).not.toMatch(/signups/i);
    expect(names("software_product")[0]).toBe("Weekly signups");
    expect(names("online_shop")[0]).toBe("Orders per month");
  });
});

describe("the website profile reports what kind of business it is", () => {
  const pages = [] as never[];
  it("asks for the kind and an industry label in the same question, and keeps only a known kind", async () => {
    expect(Object.keys(PROFILE_SCHEMA.properties)).toEqual(expect.arrayContaining(["industry", "kind"]));
    const llm = new FakeLlm({ profile: { summary: "A dental practice.", city: "Tiffin", country: "United States", industry: "family dental practice", kind: "health_and_beauty" } });
    const p = await profileBusiness(makeAsk(llm, { model: "haiku" }), { name: "Weininger Family Dentistry" }, pages);
    expect(p).toMatchObject({ industry: "family dental practice", kind: "health_and_beauty" });
    const odd = new FakeLlm({ profile: { summary: "A thing.", city: "", country: "", industry: "", kind: "spaceship" } });
    const q = await profileBusiness(makeAsk(odd, { model: "haiku" }), { name: "Thing" }, pages);
    expect(q.kind).toBeUndefined();
    expect(q.industry).toBeUndefined();
  });
});

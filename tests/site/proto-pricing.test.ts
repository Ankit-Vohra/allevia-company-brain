// The prototype site hides its pricing page for now (the founder's request): no /pricing/ page is built, no Pricing in the top bar or the
// footer, no plans on the home page, while the "Start with a free Brain Snapshot" button stays. The source stays in the repo behind
// ALLEVIA_SITE_PRICING=1, and these tests hold both states.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { protoPages } from "../../site/proto/pages.js";
import { pricingVisible } from "../../site/proto/shared/flags.js";
import { SECTIONS } from "../../site/proto/shared/sections.js";

const PROTO = new URL("../../site/proto/", import.meta.url).pathname;
const PAGE_FOLDERS = ["a", "product", "integrations", "team", "pricing", "security", "faq", "contact"];

/** A page as the build writes it: every `<!-- @section name -->` swapped for the shared section. */
function built(folder: string): string {
  const html = readFileSync(`${PROTO}${folder}/index.html`, "utf8");
  return html.replace(/<!--\s*@section\s+([\w-]+)\s*-->/g, (_m, name: string) => {
    const make = SECTIONS[name];
    if (!make) throw new Error(`no section ${name}`);
    return make(folder);
  });
}

const saved = process.env.ALLEVIA_SITE_PRICING;
beforeEach(() => { delete process.env.ALLEVIA_SITE_PRICING; });
afterEach(() => { if (saved === undefined) delete process.env.ALLEVIA_SITE_PRICING; else process.env.ALLEVIA_SITE_PRICING = saved; });

describe("the pricing page is hidden (the default)", () => {
  it("is off unless ALLEVIA_SITE_PRICING is 1", () => {
    expect(pricingVisible()).toBe(false);
    process.env.ALLEVIA_SITE_PRICING = "true";
    expect(pricingVisible()).toBe(false);
    process.env.ALLEVIA_SITE_PRICING = "1";
    expect(pricingVisible()).toBe(true);
  });

  it("is not in the list of pages that get built", () => {
    expect(protoPages()).not.toContain("pricing");
    expect(protoPages()).toEqual(["index", "a", "product", "integrations", "team", "security", "faq", "contact", "about", "privacy", "terms", "cookies", "data-deletion"]);
  });

  it("has no Pricing in the top bar or the footer", () => {
    for (const page of ["a", "product", "pricing", "team"]) {
      const bar = SECTIONS.nav!(page);
      expect(bar, page).not.toMatch(/pricing/i);
      expect(bar, page).toContain("Get a free Brain Snapshot");
    }
    const foot = SECTIONS.footer!("a");
    expect(foot).not.toMatch(/pricing/i);
    expect(foot).toContain('href="/product/"');
    expect(foot).toContain('href="/security/"');
  });

  it("has no plans on the home page, and keeps the Brain Snapshot button", () => {
    expect(SECTIONS.plans!("a")).toBe("");
    const home = built("a");
    expect(home).not.toMatch(/Simple monthly plans|Start at \$100|id="plans"|pmini/);
    expect(home).toContain("Start with a free Brain Snapshot.");
    expect(home).toContain('href="/contact/#snapshot"');
  });

  it("links to /pricing/ from no page", () => {
    for (const folder of PAGE_FOLDERS.filter((f) => f !== "pricing")) {
      expect(built(folder), folder).not.toMatch(/href="\/pricing\/?"/);
    }
  });

  it("keeps the pricing page's source in the repo so it can come back", () => {
    expect(existsSync(`${PROTO}pricing/index.html`)).toBe(true);
    expect(built("pricing")).toContain("Simple monthly plans.");
  });
});

describe("with ALLEVIA_SITE_PRICING=1 the pricing page comes back everywhere", () => {
  beforeEach(() => { process.env.ALLEVIA_SITE_PRICING = "1"; });

  it("is built, linked from the top bar and the footer, and shown on the home page", () => {
    expect(protoPages()).toContain("pricing");
    expect(SECTIONS.nav!("pricing")).toContain('<a href="/pricing/" aria-current="page">Pricing</a>');
    expect(SECTIONS.footer!("a")).toContain('<a href="/pricing/">Pricing</a>');
    const home = built("a");
    expect(home).toContain("Simple monthly plans.");
    expect(home).toContain('href="/pricing/"');
    expect(home).toContain("Start with a free Brain Snapshot.");
  });
});

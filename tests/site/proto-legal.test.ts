// About and the legal pages are part of the prototype site (site/proto/shared/legal-sections.ts), so every footer link has a page in the
// same design. A company fact the founder has not filled in is said in plain words, never as a TODO mark, and while pricing is hidden the
// terms point to the written plan, not to a Pricing page.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { protoPages } from "../../site/proto/pages.js";
import { publicLegal } from "../../site/proto/shared/legal-sections.js";
import { SECTIONS } from "../../site/proto/shared/sections.js";

const saved = process.env.ALLEVIA_SITE_PRICING;
beforeEach(() => { delete process.env.ALLEVIA_SITE_PRICING; });
afterEach(() => { if (saved === undefined) delete process.env.ALLEVIA_SITE_PRICING; else process.env.ALLEVIA_SITE_PRICING = saved; });

describe("about and the legal pages", () => {
  it("every page the footer links to is built", () => {
    const links = [...SECTIONS.footer!("a").matchAll(/href="\/([\w-]+)\/[^"]*"/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(8);
    for (const page of links) expect(protoPages(), page).toContain(page);
  });

  it("show no TODO mark and no link to the hidden Pricing or demo page", () => {
    for (const name of ["about", "legal-privacy", "legal-terms", "legal-cookies", "legal-data-deletion"]) {
      const html = SECTIONS[name]!(name);
      expect(html, name).not.toMatch(/TODO|<mark class="todo"/);
      expect(html, name).not.toMatch(/href="\/(?:pricing|demo)\//);
    }
  });

  it("name the operator in plain words and point the terms to the written plan", () => {
    expect(SECTIONS["legal-privacy"]!("privacy")).toContain("operated by Allevia AI, with its registered office at");
    const terms = SECTIONS["legal-terms"]!("terms");
    expect(terms).toContain("Payments are taken by a payment provider we will name here before billing opens.");
    expect(terms).toContain("your written plan");
    expect(terms).not.toMatch(/Pricing page/);
  });

  it("keep the Pricing page links when pricing is shown", () => {
    process.env.ALLEVIA_SITE_PRICING = "1";
    expect(SECTIONS["legal-terms"]!("terms")).toContain('href="/pricing/"');
  });

  it("refuse a TODO mark nobody handled", () => {
    expect(() => publicLegal('<p><mark class="todo">TODO(founder): something new</mark></p>')).toThrow(/plain words/);
  });
});

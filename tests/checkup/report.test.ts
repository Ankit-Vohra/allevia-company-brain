import { describe, expect, it } from "vitest";
import { buildVerdict } from "../../src/checkup/fixes.js";
import { ownerReport, verdictLine } from "../../src/checkup/report.js";

const O = "https://shree.example";
const v = buildVerdict({
  site: { origin: O, homeOk: true, https: true, sitemapFound: false, aiCrawlersBlocked: [] }, kind: "local", lighthouse: [],
  conversion: [
    { check: "contact-above-fold-mobile", pass: false, page: `${O}/`, evidence: "no button" },
    { check: "proof", pass: true, page: `${O}/`, evidence: "" },
  ],
});

describe("ownerReport", () => {
  it("leads with the verdict, then numbered fixes with what, why, effort and where", () => {
    const text = ownerReport(v, { progress: ["Your mobile speed went from 41 to 78."] });
    const lines = text.split("\n");
    expect(lines[0]).toBe(verdictLine(v));
    expect(lines[0]).toMatch(/losing enquiries in one place/);
    expect(text).toContain("Since the last check-up:\n- Your mobile speed went from 41 to 78.");
    expect(text).toMatch(/1\. Put a call or WhatsApp button on the first screen on phones\n {3}What to change: .+\n {3}Why: .+\n {3}Effort: about 30 minutes, you can do it in your site editor · Where: home page/);
    expect(text).toContain("Already good: Customer reviews or proof are on the site.");
    expect(text).not.toContain("Show how");
  });
  it("puts the method and the evidence behind Show how", () => {
    const text = ownerReport(v, { showHow: true });
    expect(text).toContain("Show how:");
    expect(text).toMatch(/\[\d+\] Add a sitemap/);
  });
  it("says so plainly when there is nothing to fix", () => {
    const empty = buildVerdict({ site: { origin: O, homeOk: true, https: true, sitemapFound: true, aiCrawlersBlocked: [] }, kind: "online", lighthouse: [], conversion: [] });
    expect(ownerReport(empty).split("\n")[0]).toBe("Your website is in good shape: nothing worth fixing right now.");
  });
});

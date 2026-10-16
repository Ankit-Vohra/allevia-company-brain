import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { band, lhSeverity, parseLhr, runLighthouse, sortLhIssues, type LhIssue } from "../../src/checkup/lighthouse.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/checkup/${name}`, import.meta.url), "utf8"));

describe("parseLhr", () => {
  const r = parseLhr(fixture("lhr-mobile-poor.json"), "mobile", "http://example.test/");

  it("keeps the four category scores as 0-100", () => {
    expect(Object.keys(r.scores).sort()).toEqual(["accessibility", "best-practices", "performance", "seo"]);
    for (const v of Object.values(r.scores)) expect(v).toBeGreaterThanOrEqual(0);
    expect(r.scores.accessibility).toBeLessThan(60);
  });

  it("reads the lab Core Web Vitals", () => {
    expect(r.metrics.lcpMs).toBeGreaterThan(1000);
    expect(r.metrics.cls).toBeTypeOf("number");
    expect(r.metrics.tbtMs).toBeTypeOf("number");
  });

  it("lists failing audits only, never numeric metrics or diagnostics", () => {
    const ids = r.issues.map((i) => i.id);
    expect(ids).toContain("image-alt");
    expect(ids).toContain("color-contrast");
    expect(ids).toContain("meta-description");
    expect(ids).not.toContain("largest-contentful-paint");
    expect(ids).not.toContain("first-contentful-paint");
    expect(new Set(ids).size).toBe(ids.length); // image-alt sits in two categories: listed once
  });

  it("puts the biggest time saving first", () => {
    expect(r.issues[0]!.impactMs ?? 0).toBeGreaterThan(0);
  });

  it("never invents a result from junk", () => {
    const j = parseLhr(null, "desktop", "http://x.test/");
    expect(j.error).toBeTruthy();
    expect(j.issues).toEqual([]);
  });
});

describe("open-seo severity and order", () => {
  it("rates by saving first, then score", () => {
    expect(lhSeverity({ score: 95, impactMs: 400, impactBytes: null })).toBe("critical");
    expect(lhSeverity({ score: 40, impactMs: null, impactBytes: null })).toBe("critical");
    expect(lhSeverity({ score: 95, impactMs: null, impactBytes: 60_000 })).toBe("warning");
    expect(lhSeverity({ score: 70, impactMs: null, impactBytes: null })).toBe("warning");
    expect(lhSeverity({ score: 95, impactMs: 10, impactBytes: 10 })).toBe("info");
  });
  it("sorts by saving then by score", () => {
    const i = (id: string, impactMs: number | null, score: number | null): LhIssue =>
      ({ id, title: id, category: "performance", score, impactMs, impactBytes: null, severity: "info", items: [] });
    expect(sortLhIssues([i("a", null, 50), i("b", 300, 80), i("c", null, 0)]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("bands", () => {
  it("uses the Core Web Vitals thresholds", () => {
    expect(band("lcpMs", 2400)).toBe("good");
    expect(band("lcpMs", 3600)).toBe("needs work");
    expect(band("lcpMs", 5000)).toBe("poor");
    expect(band("cls", 0.3)).toBe("poor");
  });
});

describe("runLighthouse", () => {
  it("refuses a private address before opening a browser", async () => {
    let ran = 0;
    const out = await runLighthouse([{ url: "http://10.0.0.5/", strategy: "mobile" }, { url: "file:///etc/passwd", strategy: "mobile" }],
      { runner: async () => { ran++; return {}; } });
    expect(ran).toBe(0);
    expect(out.every((x) => x.error)).toBe(true);
  });
  it("refuses a public name that resolves to a private address", async () => {
    const out = await runLighthouse([{ url: "https://sneaky.example/", strategy: "mobile" }],
      { runner: async () => fixture("lhr-mobile-poor.json"), resolve: async () => ["127.0.0.1"] });
    expect(out[0]!.error).toMatch(/private or local/);
  });
  it("runs each page and keeps going after a failure", async () => {
    const out = await runLighthouse([{ url: "https://a.example/", strategy: "mobile" }, { url: "https://b.example/", strategy: "desktop" }], {
      resolve: async () => ["8.8.8.8"],
      runner: async (url) => { if (url.includes("a.")) throw new Error("timed out"); return fixture("lhr-desktop-poor.json"); },
    });
    expect(out[0]!.error).toBe("timed out");
    expect(out[1]!.scores.performance).toBeGreaterThan(0);
  });
});

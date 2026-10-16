// Holds the home page's scroll story to the code and records it describes, and keeps the vendored engine untouched.
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTROL_NUMBERS, WATERLINE, WORK, ROUTE, PLAN_SAMPLE, WE_DO_NOT, ONE_REQUEST } from "../../site/src/story-content.ts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const home = () => read("site/index.html");

describe("vendored scrollcraft engine", () => {
  it("is byte-identical to the pinned upstream copy", () => {
    const notice = read("site/vendor/scrollcraft/NOTICE.md");
    for (const f of ["scrollcraft.js", "scrollcraft.css"]) {
      const h = createHash("sha256").update(readFileSync(new URL(`../../site/vendor/scrollcraft/${f}`, import.meta.url))).digest("hex");
      expect(notice).toContain(h.slice(0, 16));
    }
    expect(read("site/vendor/scrollcraft/LICENSE")).toContain("MIT License");
  });
});

describe("control numbers match the code that enforces them", () => {
  it("monthly cap and per-edit credit cap", () => {
    expect(read("src/publicdata/ledger.ts")).toMatch(/DEFAULT_MONTHLY_USD\s*=\s*2\b/);
    expect(read("src/studio/credits.ts")).toMatch(/DEFAULT_RUN_CAP\s*=\s*5\b/);
    expect(CONTROL_NUMBERS.find((c) => c.figure === "$2")).toBeTruthy();
    expect(CONTROL_NUMBERS.find((c) => c.figure.startsWith("5"))).toBeTruthy();
  });
  it("invites last 7 days and one use", () => {
    expect(read("docs/discord-hub-setup.md")).toMatch(/7 days/i);
  });
});

describe("words and honesty", () => {
  const all = JSON.stringify([ONE_REQUEST, CONTROL_NUMBERS, WATERLINE, WORK, WE_DO_NOT]);
  it("avoids the words the owner does not use", () => {
    expect(all).not.toMatch(/\bagents?\b|Day 0|baseline/i);
  });
  it("has no em dash in visible copy", () => {
    expect(all).not.toContain("—");
  });
  it("gives every safeguard a 'Without it' line", () => {
    for (const l of WATERLINE) expect(l.without.length).toBeGreaterThan(10);
  });
  it("every piece of footage and poster the page names exists", () => {
    for (const w of WORK) for (const f of [w.img, w.video, w.poster]) if (f) expect(existsSync(new URL(`../../site/public${f}`, import.meta.url)), f).toBe(true);
  });
  it("route stops all have a section on the built page", () => {
    const html = home();
    for (const s of ROUTE) expect(html).toContain(`id="${s.id}"`);
  });
  it("sample numbers are labelled as sample", () => {
    expect(home()).toMatch(/sample numbers/i);
    expect(PLAN_SAMPLE.length).toBe(3);
  });
  it("never claims Allevia posts anything", () => {
    expect(home()).toMatch(/Nothing was posted|saved as a draft/);
  });
});

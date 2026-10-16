// Holds the home page (the v6 scroll story about the company brain) to the records it describes, to the founder's
// words rules and to its own length, and keeps the vendored scroll engine untouched.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import brain from "../../site/src/brain/brain-data.json" with { type: "json" };
import { BLOCKS, PAGE_TOKENS } from "../../site/src/render/blocks.ts";
import { ROUTE, PLAN_SAMPLE, TOOLS } from "../../site/src/home-content.ts";
import { ANSWER, FORM } from "../../site/src/render/home.ts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

/** The page as the build writes it: the blocks swapped in and the tokens filled. */
function rendered(): string {
  let html = read("site/index.html").replace(/<!--\s*@render\s+([\w-]+)\s*-->/g, (_m, name: string) => {
    const block = BLOCKS[name];
    if (!block) throw new Error(`no block ${name}`);
    return block("/");
  });
  for (const [token, value] of Object.entries(PAGE_TOKENS)) html = html.replaceAll(token, value);
  return html.replaceAll("__CONTACT_URL__", "/contact/");
}
const main = () => rendered().match(/<main[\s\S]*<\/main>/)![0];
/** What a reader can read in the page: no pictures' insides, no scripts, no comments, no markup. */
const visible = (html: string) => html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, " ").replace(/<(script|style|svg|desc|title)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const words = (html: string) => visible(html).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

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

describe("the home page is short and plain", () => {
  it("has 250 to 400 words in the story, one idea to a section", () => {
    const n = words(main());
    expect(n).toBeGreaterThanOrEqual(250);
    expect(n).toBeLessThanOrEqual(400);
  });

  it("has one h1 and each act has a heading or a label", () => {
    const html = main();
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    for (const act of html.match(/<section class="act[^>]*>/g) ?? []) expect(act, act).toMatch(/aria-label(ledby)?=/);
  });

  it("uses the owner's words and none of the tells of machine prose", () => {
    const text = visible(main());
    for (const bad of [/\bagents?\b/i, /\bDay 0\b/, /\bbaseline\b/i, /Allevia 90/, /\bAI-powered\b/i, /\bleverag/i, /\bseamless/i, /\bunlock/i, /\belevate/i, /\bempower/i, /\brobust\b/i, /\bcutting-edge\b/i, /\bgame-chang/i, /\brevolution/i, /\bsupercharge/i, /\bstreamline/i, /\bdelve\b/i, /\btapestry\b/i, /\btestament\b/i, /\bin today.s/i, /\bit.s not (just|only|about)\b/i, /\bnot just\b/i, /\bnot only\b/i, /\bmore than just\b/i, /\bhere.s the thing\b/i]) {
      expect(text, String(bad)).not.toMatch(bad);
    }
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/!/);
  });

  it("says Allevia never posts, and labels every sample", () => {
    const html = main();
    expect(visible(html)).toMatch(/Nothing goes out before that/);
    expect(visible(html)).not.toMatch(/Allevia (posts|publishes)/i);
    expect(visible(html)).toMatch(/made-up data/i);
    expect(visible(html)).toMatch(/sample numbers/i);
    expect(visible(html)).toMatch(/sample business/i);
  });
});

describe("the brain is drawn from the real graph and the real run", () => {
  it("draws every thing and link of the export, and the page's counters start at their totals", () => {
    const html = main();
    // the hero, the formation and the ask picture each draw them all
    expect((html.match(/<g class="bn /g) ?? []).length).toBe(brain.counts.nodes * 3);
    expect(html).toContain(`<b data-stat="things">${brain.counts.nodes}</b>`);
    expect(html).toContain(`<b data-stat="links">${brain.counts.edges}</b>`);
  });

  it("is a sample business with made-up data, from the demo graph", () => {
    expect(brain.tenant).toBe("demo_growth");
    expect(brain.note).toMatch(/synthetic/i);
    expect(brain.nodes.some((n: { id: string }) => n.id === "business:shiftly")).toBe(true);
  });

  it("keeps the funnel's readings as the graph held them (18 days, six steps)", () => {
    const spark = brain.spark as Record<string, { day: string; v: number }[]>;
    expect(Object.keys(spark).length).toBe(6);
    for (const days of Object.values(spark)) expect(days.length).toBe(18);
    const phone = spark["feature:seekers-signup-phone-number-entered"]!;
    const before = phone.filter((d) => d.day < "2026-10-07").map((d) => d.v);
    const after = phone.filter((d) => d.day >= "2026-10-07").map((d) => d.v);
    expect(Math.min(...before)).toBeGreaterThan(Math.max(...after));
  });

  it("shows an answer whose figures and path are in the recorded run", () => {
    const run = brain.run as { turnId: string; answer: string; path: { nodes: string[] }; steps: { t: number }[]; doneAt: number };
    expect(run.turnId).toMatch(/^turn:/);
    expect(run.doneAt).toBeGreaterThan(60);
    const said = ANSWER.map((a) => a.text).join(" ");
    for (const n of said.match(/\b\d[\d,.]*\b/g) ?? []) {
      if (n === "2.8.0" || n === "2.8.1" || n === "7") continue;
      expect(run.answer, `the run does not contain ${n}`).toMatch(new RegExp(`\\b${n.replace(/[.]/g, "\\.")}\\b|about ${n}`));
    }
    expect(run.path.nodes[0]).toBe("feature:seekers-signup-phone-number-entered");
    expect(run.path.nodes).toContain("event:sentry-issue-shiftly-41");
    expect(run.path.nodes).toContain("event:release-shiftly-2-8-0");
    const times = run.steps.map((s) => s.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("only routes between things that exist, from people who worked on the run", () => {
    const html = rendered();
    const ids = new Set(brain.nodes.map((n: { id: string }) => n.id));
    for (const m of html.matchAll(/class="br" [^>]*data-id="([^"]+)"/g)) expect(ids.has(m[1]!.replace(/&amp;/g, "&")), m[1]).toBe(true);
    for (const m of html.matchAll(/data-agent="([^"]+)"/g)) expect(["chief-of-staff", "data-analyst", "oncall-engineer", "qa-release", "librarian", "tech-lead", "coe-lead"]).toContain(m[1]);
  });

  it("times the formation inside the act, tools in order, and gives every tool a logo file", () => {
    const docks = Object.values(FORM.dock);
    expect([...docks].sort((a, b) => a - b)).toEqual(docks);
    expect(docks.every((d) => d > FORM.site.to)).toBe(true);
    for (const t of TOOLS) expect(existsSync(new URL(`../../site/public/img/tool-${t.id}.webp`, import.meta.url)), t.id).toBe(true);
  });
});

describe("what the page links and shows exists", () => {
  it("has every picture and clip it names", () => {
    const html = rendered();
    for (const m of html.matchAll(/(?:src|data-sc-src|data-mp4)="(\/(?:media|img)\/[^"]+)"/g)) expect(existsSync(new URL(`../../site/public${m[1]}`, import.meta.url)), m[1]).toBe(true);
    for (const f of ["office-loop.mp4", "office-loop-poster.webp", "ask-office.mp4"]) expect(existsSync(new URL(`../../site/public/media/${f}`, import.meta.url)), f).toBe(true);
  });

  it("gives every route stop a section", () => {
    const html = rendered();
    for (const s of ROUTE) expect(html).toContain(`id="${s.id}"`);
  });

  it("keeps the plan's sample numbers as the app's own (web/src/mock/program.ts)", () => {
    expect(PLAN_SAMPLE.length).toBe(3);
    const mock = read("web/src/mock/program.ts");
    const us = (n: number) => n.toLocaleString("en-US").replace(/,/g, "_");
    for (const g of PLAN_SAMPLE) for (const n of [g.from, g.now, g.goal]) expect(mock, `${g.name} ${n}`).toContain(us(n));
  });

  it("keeps the scrubbed clip small and the home page light", () => {
    const clip = readFileSync(new URL("../../site/public/media/ask-office.mp4", import.meta.url));
    expect(clip.length).toBeLessThan(3_500_000);
    expect(rendered().length).toBeLessThan(200_000);
  });
});

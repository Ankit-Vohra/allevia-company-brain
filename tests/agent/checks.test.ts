import { describe, it, expect } from "vitest";
import { checkTurn, extractCitations, findNumbers } from "../../src/agent/checks.js";
import { TouchedSet } from "../../src/agent/tool.js";
import type { NodeRef, ToolResult } from "../../shared/contracts.js";

const NOW = Date.parse("2026-10-15T06:00:00Z");

function touched(data: unknown, nodes: Partial<NodeRef>[] = [], extra: Partial<ToolResult> = {}): TouchedSet {
  const t = new TouchedSet();
  t.add({
    data,
    nodes: nodes.map((n) => ({ id: n.id ?? "x", label: n.label ?? "Metric", name: n.name ?? n.id ?? "x", ...n })),
    edges: [],
    sources: [],
    ...extra,
  });
  return t;
}

const raws = (text: string) => findNumbers(text).map((m) => m.raw);

describe("extractCitations", () => {
  it("returns unique [[id]] citations in order of appearance, ignoring a |label part", () => {
    expect(extractCitations("a [[metric:signups]] b [[page:x.ai/jobs|Jobs]] c [[metric:signups]]")).toEqual(["metric:signups", "page:x.ai/jobs"]);
  });
  it("returns [] when there are none", () => {
    expect(extractCitations("no citations here [not one]")).toEqual([]);
  });
});

describe("findNumbers", () => {
  it("ignores ISO dates, '5 Oct', 'Oct 5', 'October 5, 2026' and 'Oct 2026'", () => {
    expect(raws("Up on 2026-10-05, again 5 Oct and Oct 5, also October 5, 2026 and Oct 2026: 55 signups")).toEqual(["55"]);
  });
  it("ignores times, standalone years and list ordinals at line start", () => {
    expect(raws("1. At 10:30 IST and 9am in 2026 we saw 12\n2) then 14\n- 3. bullet")).toEqual(["12", "14"]);
  });
  it("ignores numbers inside [[ids]], bare ids, URLs and letter-attached names like GA4 or Q3", () => {
    expect(raws("See [[obs:signups:2026-10-05]] and obs:clicks:2026-10-01, https://x.ai/p/123, GA4 and Q3: 7 pages")).toEqual(["7"]);
  });
  it("ignores ordinals (1st, 2nd) and 'last 7 days' style windows", () => {
    expect(raws("the 2nd post in the last 7 days had 40 likes; over the past 28 days, 90")).toEqual(["40", "90"]);
  });
  it("reads currency, percentages, Indian grouping and multipliers", () => {
    const ms = findNumbers("₹1,23,456 spent, CTR 1.2%, 55k views, ₹1.2 lakh budget, Rs. 500 fee, 2.3x outlier");
    expect(ms.map((m) => [m.raw, m.value, m.percent, m.scale])).toEqual([
      ["₹1,23,456", 123456, false, 1],
      ["1.2%", 1.2, true, 1],
      ["55k", 55, false, 1000],
      ["₹1.2 lakh", 1.2, false, 100000],
      ["Rs. 500", 500, false, 1],
      ["2.3", 2.3, false, 1],
    ]);
  });
  it("reads Devanagari digits and ignores Hindi dates", () => {
    expect(findNumbers("५ अक्टूबर को ५५ साइनअप हुए, ₹१,२०० खर्च").map((m) => m.value)).toEqual([55, 1200]);
  });
  it("keeps a year-looking number that carries a currency, a comma or a percent", () => {
    expect(raws("₹2026 and 2,026 and 2026% but not 2026")).toEqual(["₹2026", "2,026", "2026%"]);
  });
});

describe("checkTurn: citations", () => {
  it("flags a cited id that no tool returned", () => {
    const t = touched({}, [{ id: "metric:signups" }]);
    const c = checkTurn("Signups rose [[metric:signups]] because of [[page:made-up]].", t, { now: NOW });
    expect(c.citationsValid).toBe(false);
    expect(c.invalidCitations).toEqual(["page:made-up"]);
  });
  it("accepts source ids as citations", () => {
    const t = touched({}, [], { sources: [{ id: "document:pending", title: "PENDING.md" }] });
    expect(checkTurn("Per [[document:pending]].", t, { now: NOW }).citationsValid).toBe(true);
  });
});

describe("checkTurn: numbers", () => {
  const t = touched({ metric: "signups", value: 55, ctr: 0.968, spend: 123456, clicks: "1,234", share: 96.8 });

  it("'55 signups' passes when 55 is in a tool result", () => {
    const c = checkTurn("We got 55 signups as of 2026-10-05.", t, { now: NOW });
    expect(c.numbersGrounded).toBe(true);
    expect(c.ungroundedNumbers).toEqual([]);
  });
  it("'56 signups' fails", () => {
    const c = checkTurn("We got 56 signups.", t, { now: NOW });
    expect(c.numbersGrounded).toBe(false);
    expect(c.ungroundedNumbers).toEqual(["56"]);
  });
  it("dates in the answer are never flagged", () => {
    expect(checkTurn("On 2026-10-05 (5 Oct, Oct 5) we got 55.", t, { now: NOW }).numbersGrounded).toBe(true);
  });
  it("a percentage matches a fraction (97% ~ 0.968) or a rounded value (97 ~ 96.8)", () => {
    expect(checkTurn("CTR was 97%.", t, { now: NOW }).numbersGrounded).toBe(true);
    expect(checkTurn("CTR was 96.8%.", t, { now: NOW }).numbersGrounded).toBe(true);
    expect(checkTurn("Share 97.", t, { now: NOW }).numbersGrounded).toBe(true);
    expect(checkTurn("CTR was 95%.", t, { now: NOW }).ungroundedNumbers).toEqual(["95%"]);
  });
  it("55 matches 55.0 and 1234 matches '1,234'", () => {
    const t2 = touched({ v: "55.0 signups", clicks: "1,234" });
    expect(checkTurn("55 signups, 1234 clicks, 1,234 again", t2, { now: NOW }).numbersGrounded).toBe(true);
  });
  it("₹ amounts with Indian grouping and lakh multipliers are grounded by value", () => {
    expect(checkTurn("Spend was ₹1,23,456 (about ₹1.2 lakh).", t, { now: NOW }).numbersGrounded).toBe(true);
    expect(checkTurn("Spend was ₹1,50,000.", t, { now: NOW }).ungroundedNumbers).toEqual(["₹1,50,000"]);
  });
  it("Hindi text with Devanagari digits is checked like English", () => {
    expect(checkTurn("५ अक्टूबर तक ५५ साइनअप हुए।", t, { now: NOW }).numbersGrounded).toBe(true);
    expect(checkTurn("५ अक्टूबर तक ५७ साइनअप हुए।", t, { now: NOW }).ungroundedNumbers).toEqual(["५७"]);
  });
  it("numbers that appear in the question are allowed (\"3 reel ideas\")", () => {
    const t3 = touched({});
    expect(checkTurn("Here are 3 reel ideas.", t3, { now: NOW }).numbersGrounded).toBe(false);
    expect(checkTurn("Here are 3 reel ideas.", t3, { now: NOW, question: "give me 3 reel ideas" }).numbersGrounded).toBe(true);
  });
  it("a down-move matches a negative delta in the data", () => {
    const t4 = touched({ delta: -12 });
    expect(checkTurn("Clicks fell 12 week on week.", t4, { now: NOW }).numbersGrounded).toBe(true);
  });
  it("an answer with no numbers is grounded", () => {
    expect(checkTurn("Nothing recorded on that.", touched({}), { now: NOW }).numbersGrounded).toBe(true);
  });
  it("reports each ungrounded number once", () => {
    expect(checkTurn("77 and 77 and 78", touched({}), { now: NOW }).ungroundedNumbers).toEqual(["77", "78"]);
  });
});

describe("checkTurn: simulated and freshness", () => {
  it("a simulated node touched without the word 'simulated' fails; with it, passes", () => {
    const t = touched({}, [{ id: "campaign:x", label: "Campaign", simulated: true }]);
    expect(checkTurn("Pause the campaign.", t, { now: NOW }).simulatedDisclosed).toBe(false);
    expect(checkTurn("Pause the (simulated) campaign.", t, { now: NOW }).simulatedDisclosed).toBe(true);
  });
  it("no simulated nodes: disclosed trivially", () => {
    expect(checkTurn("ok", touched({}, [{ id: "a" }]), { now: NOW }).simulatedDisclosed).toBe(true);
  });
  it("data newer than 7 days needs no 'as of'", () => {
    const t = touched({}, [{ id: "obs:a", asOf: "2026-10-10" }]);
    expect(checkTurn("55 signups", t, { now: NOW }).freshnessDisclosed).toBe(true);
  });
  it("stale data needs 'as of <date>' in the answer", () => {
    const t = touched({}, [{ id: "obs:a", asOf: "2026-09-01" }, { id: "obs:b", asOf: "2026-09-20" }]);
    expect(checkTurn("55 signups", t, { now: NOW }).freshnessDisclosed).toBe(false);
    expect(checkTurn("55 signups as of 20 Sep 2026", t, { now: NOW }).freshnessDisclosed).toBe(true);
  });
  it("no asOf anywhere: fresh by default", () => {
    expect(checkTurn("ok", touched({}, [{ id: "a" }]), { now: NOW }).freshnessDisclosed).toBe(true);
  });
});

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
    expect(raws("₹2026 and 2,026 and 2026% but not in 2026")).toEqual(["₹2026", "2,026", "2026%"]);
  });
  it("a number from 1990 to 2100 is a year only next to a date or a year word; otherwise it is a quantity", () => {
    expect(raws("We had 2045 sessions and 1999 clicks")).toEqual(["2045", "1999"]);
    for (const t of ["in 2026", "since 2019", "until 2030", "the year 2026", "FY 2026", "Q3 2026", "end of 2025", "2025-2026", "2025 to 2026",
      "2026's best week", "the 2026 budget", "Oct, 2026", "2026 में"]) expect(raws(`${t}: 40`), t).toEqual(["40"]);
  });
  it("ignores slash dates, week numbers and 'top N'", () => {
    expect(raws("Updated 2026/10/12 and 12/10/2026: in week 41 (wk 40) the top 3 pages had 5 signups")).toEqual(["5"]);
  });
  it("reads lowercase m/b multipliers only after a currency, and the currencies of every market", () => {
    expect(findNumbers("£2.5m, $1.2b, US$1,200, A$3k, AED 1,500, Dhs 200, 5m away").map((m) => [m.raw, m.value * m.scale])).toEqual([
      ["£2.5m", 2_500_000], ["$1.2b", 1_200_000_000], ["US$1,200", 1200], ["A$3k", 3000], ["AED 1,500", 1500], ["Dhs 200", 200], ["5", 5],
    ]);
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
  it("dates in tool data never ground a number: '12%' is not grounded by 2026-10-12", () => {
    const dated = touched({ week: "2026-10-12", at: "2026-10-12T10:30:00Z", label: "2026/10/12", uk: "12/10/2026", value: 41 });
    expect(dated.numbers().has("12")).toBe(false);
    expect(dated.numbers().has("-10")).toBe(false);
    expect(checkTurn("Signups fell 12% to 41.", dated, { now: NOW }).ungroundedNumbers).toEqual(["12%"]);
    expect(checkTurn("Signups were 41 in the week to 2026-10-12.", dated, { now: NOW }).numbersGrounded).toBe(true);
  });
  it("a hyphen after a digit is not a minus sign (a range in tool data), but a leading minus is", () => {
    const t5 = touched({ range: "10-12", delta: "-7", id: "abc-3" });
    expect([...t5.numbers()].sort()).toEqual(["-7", "10", "12", "3"]);
  });
  it("currency multipliers: £2.5m, $1.2k, $1.2bn are grounded by the full value", () => {
    const money = touched({ revenue: 2500000, spend: 1200, big: 1200000000 });
    expect(checkTurn("Revenue was £2.5m, spend $1.2k and $1.2bn overall.", money, { now: NOW }).numbersGrounded).toBe(true);
    expect(checkTurn("Revenue was £3.5m.", money, { now: NOW }).ungroundedNumbers).toEqual(["£3.5m"]);
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
    // the owner's word for it (docs/owner-words.md) counts as saying it
    expect(checkTurn("Pause the campaign (sample numbers).", t, { now: NOW }).simulatedDisclosed).toBe(true);
    expect(checkTurn("These are sample figures from a stand-in campaign.", t, { now: NOW }).simulatedDisclosed).toBe(true);
    expect(checkTurn("Pause the campaign; here is a sample of the ads.", t, { now: NOW }).simulatedDisclosed).toBe(false);
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
  it("'as of' counts only with an actual date after it ('as of now' or 'as of today' doesn't)", () => {
    const t = touched({}, [{ id: "obs:a", asOf: "2026-09-01" }]);
    for (const a of ["As of now, 5 signups.", "As of today signups are fine", "as of the latest data, 5"]) {
      expect(checkTurn(a, t, { now: NOW }).freshnessDisclosed, a).toBe(false);
    }
    for (const a of ["Signups as of 1 Sep 2026", "as of 2026-09-01: 5", "As of Sept 1, 5", "as of 01/09/2026, 5", "as at 1 September 2026, 5",
      "as of the week to 2026-09-01, 5", "१ सितंबर २०२६ तक की स्थिति: ५", "2026-09-01 के अनुसार ५"]) {
      expect(checkTurn(a, t, { now: NOW }).freshnessDisclosed, a).toBe(true);
    }
  });
  it("newestAsOf compares instants, not strings", () => {
    const t = touched({}, [{ id: "a", asOf: "2026-10-15" }, { id: "b", asOf: "2026-10-14T23:00:00-05:00" }]);
    expect(t.newestAsOf()).toBe("2026-10-14T23:00:00-05:00");
  });
  it("no asOf anywhere: fresh by default", () => {
    expect(checkTurn("ok", touched({}, [{ id: "a" }]), { now: NOW }).freshnessDisclosed).toBe(true);
  });
});

describe("checkTurn: access mode (capability ladder)", () => {
  const caps = [
    { key: "search_console" as const, name: "Google Search Console", accessMode: "public" as const },
    { key: "ads" as const, name: "Ads", accessMode: "benchmark" as const },
    { key: "ga4" as const, name: "GA4", accessMode: "api" as const },
    { key: "instagram_insights" as const, name: "Instagram insights", accessMode: "public" as const },
  ];
  const t = touched({ pages: 2 }, [
    { id: "rule:seo-check-meta-description", label: "Rule" }, { id: "rule:benchmark-meta-ads-ctr", label: "Rule" },
    { id: "obs:ga4_sessions:channel:website:2026-10-13", label: "Observation" }, { id: "channel:instagram", label: "Channel" },
  ]);
  it("an answer citing a public-mode capability must say so", () => {
    expect(checkTurn("2 pages lack a description [[rule:seo-check-meta-description]].", t, { now: NOW, capabilities: caps }).modeDisclosed).toBe(false);
    expect(checkTurn("From a crawl of your public site, 2 pages lack a description [[rule:seo-check-meta-description]].", t, { now: NOW, capabilities: caps }).modeDisclosed).toBe(true);
  });
  it("citing a channel (a source, not its data) needs nothing", () => {
    expect(checkTurn("If the token expires, Instagram [[channel:instagram]] stops posting.", t, { now: NOW, capabilities: caps }).modeDisclosed).toBe(true);
  });
  it("a benchmark must be called one", () => {
    expect(checkTurn("A good CTR is above 1% [[rule:benchmark-meta-ads-ctr]].", t, { now: NOW, capabilities: caps }).modeDisclosed).toBe(false);
    expect(checkTurn("The benchmark CTR is above 1% [[rule:benchmark-meta-ads-ctr]].", t, { now: NOW, capabilities: caps }).modeDisclosed).toBe(true);
  });
  it("live (api) data, uncited ids, made-up ids and no ladder need nothing", () => {
    expect(checkTurn("Sessions rose [[obs:ga4_sessions:channel:website:2026-10-13]].", t, { now: NOW, capabilities: caps }).modeDisclosed).toBe(true);
    expect(checkTurn("Nothing cited here.", t, { now: NOW, capabilities: caps }).modeDisclosed).toBe(true);
    expect(checkTurn("Made up [[channel:instagram-x]].", t, { now: NOW, capabilities: caps }).modeDisclosed).toBe(true);
    expect(checkTurn("2300 followers [[channel:instagram]].", t, { now: NOW }).modeDisclosed).toBe(true);
  });
});

// The review's probe-checks.ts, as a table: each answer against its tool data.
describe("checkTurn: the review's probe cases", () => {
  const cases: Array<[string, unknown, string, boolean, string[]?]> = [
    ["GBP m lowercase", { revenue: 2500000 }, "Revenue was £2.5m in September.", true],
    ["USD M upper", { revenue: 2500000 }, "Revenue was $2.5M in September.", true],
    ["USD bn", { revenue: 1200000000 }, "Revenue was $1.2bn.", true],
    ["USD k lowercase", { spend: 12500 }, "Spend was $12.5k.", true],
    ["a year-like quantity is checked", { sessions: 2010 }, "We had 2045 sessions last week.", false, ["2045"]],
    ["a year-like quantity in the data", { sessions: 2045 }, "We had 2045 sessions last week.", true],
    ["slash ISO date", { x: 1 }, "Updated 2026/10/12.", true],
    ["a small number is not grounded by a date", { week: "2026-10-12", value: 41 }, "Signups fell 12% to 41.", false, ["12%"]],
    ["pct points", { ctr: 0.034 }, "CTR was 3.4%.", true],
    ["pct as 3.4 in data", { ctr: 3.4 }, "CTR was 3.4%.", true],
    ["£1,234.56", { amt: 1234.56 }, "Paid £1,234.56.", true],
    ["week 41", { v: 5 }, "In week 41 we had 5 signups.", true],
    ["UK date", { v: 5 }, "5 signups on 12/10/2026.", true],
    ["range en dash", { a: 10, b: 12 }, "between 10–12 signups", true],
    ["Q3 FY26", { v: 1 }, "Q3 FY26 results", true],
    ["2.4x", { mult: 2.4 }, "a 2.4x outlier", true],
    ["timezone BST", { v: 1 }, "at 10:30 BST", true],
    ["US$", { v: 1200 }, "US$1,200 spent", true],
    ["1.2 million", { v: 1200000 }, "1.2 million impressions", true],
    ["top 3", { v: 1 }, "Top 3 pages", true],
  ];
  for (const [name, data, answer, grounded, ungrounded] of cases) {
    it(name, () => {
      const c = checkTurn(answer, touched(data), { now: NOW });
      expect(c.numbersGrounded).toBe(grounded);
      if (ungrounded) expect(c.ungroundedNumbers).toEqual(ungrounded);
    });
  }
});

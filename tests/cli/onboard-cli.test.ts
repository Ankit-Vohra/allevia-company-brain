// The operator's `onboard <url>` command without a database: its arguments, the onboarding input it hands to onboard() (the same
// one the web app's form makes), its progress lines, the public reads it plans and their quote, and that it stops before any
// public read when public data is off or the quote passes --max-usd.
import { describe, expect, it } from "vitest";
import { parseOnboardArgs } from "../../src/cli/onboard.js";
import { nameFromUrl, onboardInput, ONBOARDING_QUOTE_USD, parseRival, planExtras, progressLine, runOperatorOnboard } from "../../src/onboard/operator.js";
import type { OnboardResult } from "../../src/onboard/onboard.js";
import { FakePublicData } from "../publicdata/fakes.js";

const done: OnboardResult = { tenant: "bluetokai", ok: true, pages: 3, counts: {}, stats: { nodesCreated: 0, nodesUpdated: 0, versions: 0, edgesCreated: 0, edgesClosed: 0, observations: 0, writeErrors: 0 }, errors: [] };

describe("onboard <url>: arguments", () => {
  it("reads the url and the flags into the same input the web form makes", () => {
    const a = parseOnboardArgs(["https://bluetokaicoffee.com", "--slug", "bluetokai", "--name", "Blue Tokai Coffee Roasters", "--country", "India",
      "--industry", "specialty coffee roaster", "--vertical", "online shop", "--rival", "Rival Roasters|rivalroasters|rivalroasters.example", "--rival", "Second Cup"]);
    expect(a).toMatchObject({ url: "https://bluetokaicoffee.com", slug: "bluetokai", extras: true, maxUsd: 1, rivals: [{ name: "Rival Roasters", instagram: "rivalroasters", domain: "rivalroasters.example" }, { name: "Second Cup" }] });
    expect(onboardInput(a, "bluetokai")).toEqual({
      name: "Blue Tokai Coffee Roasters", slug: "bluetokai", url: "https://bluetokaicoffee.com", country: "India", industry: "specialty coffee roaster", vertical: "online shop",
    });
  });

  it("refuses a bad slug, a missing url, a bad budget and a rival with no name", () => {
    expect(() => parseOnboardArgs([])).toThrow(/Usage/);
    expect(() => parseOnboardArgs(["example.com", "--slug", "Blue-Tokai"])).toThrow(/--slug/);
    expect(() => parseOnboardArgs(["example.com", "--max-usd", "lots"])).toThrow(/--max-usd/);
    expect(() => parseRival("|handle")).toThrow(/name/);
    expect(nameFromUrl("https://www.bluetokaicoffee.com/")).toBe("Bluetokaicoffee");
  });

  it("prints a line per stage, page and error, as the web page shows them", () => {
    expect(progressLine({ type: "stage", stage: "crawl", text: "Reading bluetokaicoffee.com" }, 0, 1500, false)).toBe("1.5s [crawl] Reading bluetokaicoffee.com");
    expect(progressLine({ type: "nodes", nodes: [], edges: [] }, 0, 0, false)).toBeNull();
    expect(progressLine({ type: "error", message: "We could not read the brand", soft: true }, 0, 0, false)).toBe("0.0s note: We could not read the brand");
  });
});

describe("onboard <url>: the public reads", () => {
  it("quotes them before anything runs: own Instagram and ads, then each rival's", () => {
    const p = planExtras({ name: "Blue Tokai Coffee Roasters", domain: "bluetokaicoffee.com", instagram: "bluetokaicoffee", rivals: [{ name: "Rival Roasters", instagram: "rivalroasters", domain: "rivalroasters.example" }] });
    // Instagram 0.007 + 0.017; ads 0.11 + 0.11; the same again for the rival
    expect(p.quoteUsd).toBeCloseTo(0.488, 3);
    expect(p.lines).toHaveLength(4);
    expect(ONBOARDING_QUOTE_USD).toBeCloseTo(0.134, 3); // the Google listing with ten reviews, and the blocked-site reader if needed
  });

  const args = (extra: string[] = []) => parseOnboardArgs(["https://bluetokaicoffee.com", "--slug", "bluetokai", "--name", "Blue Tokai Coffee Roasters", ...extra]);
  const noGraph = async () => { throw new Error("no graph needed"); };

  it("with public data off, runs onboarding only and says why nothing else was read", async () => {
    const out: string[] = [];
    const off = { enabled: false, quote: () => 0, run: async () => ({ ok: false as const, reason: "off" as const, why: "off" }), budget: () => ({ spentThisMonth: 0, monthly: 2, spentToday: 0, daily: 3 }) };
    const r = await runOperatorOnboard(args(), "bluetokai", { onboardFn: async () => done, deps: { publicData: off }, openGraph: noGraph, out: (l) => out.push(l) });
    expect(r.extras).toEqual({ skipped: "public data is off (no APIFY_TOKEN)" });
    expect(out[0]).toMatch(/public data off \(no APIFY_TOKEN\)/);
  });

  it("over --max-usd, reads nothing more and says what it would have cost", async () => {
    const out: string[] = [];
    const pd = new FakePublicData({});
    const g = { roQuery: async () => [{ h: "bluetokaicoffee" }] } as never;
    const r = await runOperatorOnboard(args(["--rival", "Rival Roasters|rivalroasters|rivalroasters.example", "--max-usd", "0.2"]), "bluetokai", {
      onboardFn: async () => done, deps: { publicData: pd }, openGraph: async () => g, tools: {} as never, out: (l) => out.push(l),
    });
    expect(r.extras).toMatchObject({ skipped: expect.stringMatching(/over --max-usd 0\.2/) });
    expect(pd.runs).toEqual([]);
  });
});

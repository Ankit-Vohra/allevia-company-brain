// Discord formatting: message splitting under 2,000 characters, citation labels, check badges, the path-view link,
// thread names and the live work log text.
import { describe, expect, it } from "vitest";
import type { AgentEvent, TurnChecks } from "../../shared/contracts.js";
import {
  DISCORD_MAX, badges, pathViewUrl, renderAnswer, renderCitations, splitMessage, threadName,
} from "../../src/discord/format.js";
import { WorkLogState } from "../../src/discord/worklog.js";

const OK: TurnChecks = { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true };

describe("splitMessage", () => {
  it("keeps a short message whole", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
    expect(splitMessage("x".repeat(DISCORD_MAX))).toEqual(["x".repeat(DISCORD_MAX)]);
  });

  it("splits long text at paragraph, then line, then word boundaries, every part within the limit", () => {
    const para = (n: number) => `Paragraph ${n}. ${"word ".repeat(120).trim()}`;
    const text = Array.from({ length: 8 }, (_, i) => para(i)).join("\n\n");
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(DISCORD_MAX);
      expect(p.trim()).toBe(p.replace(/^\n+/, "").replace(/\n+$/, "")); // no blank lines at the edges
      expect(p.startsWith("Paragraph")).toBe(true); // cut between paragraphs
    }
    expect(parts.join("\n\n")).toBe(text);
  });

  it("cuts one huge line at a space, and a huge word anywhere, without losing characters", () => {
    const line = "abc ".repeat(1500).trim();
    const parts = splitMessage(line);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MAX);
    expect(parts.join(" ")).toBe(line);
    const word = "y".repeat(4500);
    const w = splitMessage(word);
    expect(w.map((p) => p.length)).toEqual([2000, 2000, 500]);
    expect(w.join("")).toBe(word);
  });

  it("closes a code block at a cut and reopens it in the next part", () => {
    const code = "```ts\n" + Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`).join("\n") + "\n```";
    const parts = splitMessage(code);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(DISCORD_MAX);
      expect((p.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(1500); // 3,000 UTF-16 units
    const parts = splitMessage(text);
    for (const p of parts) expect(p).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    expect(parts.join("")).toBe(text);
  });
});

describe("answer rendering", () => {
  const names = new Map([["decision:007-pause-daily-stories", "Pause daily stories"], ["document:adr-007", "ADR 007: Pause daily stories and put the time into reels"]]);

  it("turns [[id]] citations into short labels, falling back to the id's slug", () => {
    const out = renderCitations("We paused [[decision:007-pause-daily-stories]] per [[document:adr-007]] and [[metric:weekly-signups]].", names);
    expect(out).toBe("We paused `Pause daily stories` per `ADR 007: Pause daily stories and put th…` and `weekly signups`.");
    expect(renderCitations("x [[a:b]][[a:b]]", new Map())).toBe("x `b`");
  });

  it("badges: sources verified when citations and numbers check out; a warning per failed check", () => {
    expect(badges(OK)).toBe("✅ sources verified");
    expect(badges({ ...OK, numbersGrounded: false, ungroundedNumbers: ["55", "4"] })).toBe("⚠️ unverified numbers: 55, 4");
    expect(badges({ ...OK, citationsValid: false, invalidCitations: ["metric:x"] })).toBe("⚠️ unverified source: metric:x");
    expect(badges({ ...OK, simulatedDisclosed: false, freshnessDisclosed: false }))
      .toBe("✅ sources verified · ⚠️ uses simulated data without saying so · ⚠️ may be out of date");
  });

  it("links to the web path view for the thread, with the tenant", () => {
    expect(pathViewUrl("http://127.0.0.1:8787/", "aamdani", "session:2026-10-15-ab12cd34"))
      .toBe("http://127.0.0.1:8787/ask/session:2026-10-15-ab12cd34?tenant=aamdani");
  });

  it("puts the labelled answer, the badges and the link together, split for Discord", () => {
    const parts = renderAnswer({
      answer: "We paused daily stories [[decision:007-pause-daily-stories]].", checks: OK, names,
      url: "http://127.0.0.1:8787/ask/session:s?tenant=mini",
    });
    expect(parts).toEqual(["We paused daily stories `Pause daily stories`.\n\n✅ sources verified · Path view: <http://127.0.0.1:8787/ask/session:s?tenant=mini>"]);
    const long = renderAnswer({ answer: "Long answer. ".repeat(400), checks: OK, names, url: "http://x.example/ask/s" });
    expect(long.length).toBe(3);
    expect(long.at(-1)).toContain("Path view");
  });

  it("says plainly when there is no answer", () => {
    const [p] = renderAnswer({ answer: "", checks: OK, names, url: "http://x.example/ask/s", error: "The Chief of Staff could not write the answer." });
    expect(p).toContain("I couldn't finish this one: The Chief of Staff could not write the answer.");
  });
});

describe("thread names", () => {
  it("are the question on one line, mentions removed, at most 100 characters", () => {
    expect(threadName("<@123456> What breaks if the\nInstagram token expires?")).toBe("What breaks if the Instagram token expires?");
    expect(threadName("q".repeat(300)).length).toBe(100);
    expect(threadName("   ")).toBe("Question");
  });
});

describe("work log text", () => {
  it("shows who is working and their current step, then who finished", () => {
    const w = new WorkLogState();
    const feed = (e: AgentEvent) => w.apply(e);
    feed({ type: "session", tenant: "t", sessionId: "s", turnId: "t1", question: "q" });
    expect(w.render()).toContain("Meera · Reading the question");
    feed({ type: "plan", by: "chief-of-staff", rationale: "", steps: [{ agent: "data-analyst", task: "Explain signups" }, { agent: "librarian", task: "Find the decision", after: ["data-analyst"] }] });
    feed({ type: "agent_start", agent: "data-analyst", task: "Explain signups" });
    feed({ type: "agent_status", agent: "data-analyst", text: "Checking the signups trend" });
    const mid = w.render();
    expect(mid).toContain("Kabir · Checking the signups trend");
    expect(mid).toContain("Sara · waiting: Find the decision");
    feed({ type: "agent_done", agent: "data-analyst", ms: 3100, ok: true });
    feed({ type: "text", agent: "chief-of-staff", delta: "Signups" });
    const late = w.render();
    expect(late).toContain("Kabir · done in 3.1s");
    expect(late).toContain("Meera · Writing the answer");
    feed({ type: "final", turnId: "t1", answer: "a", citations: [], checks: OK, agents: ["chief-of-staff", "data-analyst"], ms: 41_000 });
    expect(w.render()).toMatch(/^\*\*Work log\*\* · done in 41s · Meera, Kabir/);
    expect(w.render().length).toBeLessThanOrEqual(DISCORD_MAX);
  });
});

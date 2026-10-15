// GitHub issues source on a synthetic fixture (tests/fixtures/github/issues.ndjson, shaped like the `gh api --jq` output):
// read-only fetch through an injected runner, then Task(kind=issue) with status and labels, the assignee's OWNS, and
// MENTIONS by entity-name match. Pull requests and issues with a sensitive title or label are skipped.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fetchIssues, mapIssues, ISSUE_JQ, issueTaskId, type GhIssue } from "../../src/ingest/sources/github.js";
import type { KnownEntity } from "../../src/ingest/resolve-names.js";

const NDJSON = readFileSync(new URL("../fixtures/github/issues.ndjson", import.meta.url), "utf8");
const REPO = "Widget-Org/widget-brain";

const known: KnownEntity[] = [
  { id: "agent:scout", type: "Agent", name: "Scout" },
  { id: "system:instagram", type: "System", name: "Instagram connector" },
  { id: "channel:instagram", type: "Channel", name: "Instagram" },
  { id: "system:google-search-console", type: "System", name: "Google Search Console", aliases: ["Search Console"] },
  { id: "team:content", type: "Team", name: "Content" },
  { id: "team:tech", type: "Team", name: "Tech" },
  { id: "business:widget-co", type: "Business", name: "Widget Co" },
  { id: "agent:ops", type: "Agent", name: "Ops" },
];

describe("fetchIssues", () => {
  it("asks gh for every issue of the repo (state=all, paginated) and parses one JSON object per line", async () => {
    const calls: string[][] = [];
    const issues = await fetchIssues(REPO, async (args) => { calls.push(args); return NDJSON; });
    expect(calls).toEqual([["api", `repos/${REPO}/issues?state=all&per_page=100`, "--paginate", "--jq", ISSUE_JQ]]);
    expect(issues).toHaveLength(6);
    expect(issues[0]).toMatchObject({ number: 12, state: "open", labels: ["dept:content", "founder-action"], isPr: false });
  });

  it("refuses a repo name that is not owner/name", async () => {
    await expect(fetchIssues("--paginate", async () => "")).rejects.toThrow(/owner\/name/);
    await expect(fetchIssues("a/b; rm -rf", async () => "")).rejects.toThrow(/owner\/name/);
  });
});

describe("mapIssues", () => {
  const issues = NDJSON.trim().split("\n").map((l) => JSON.parse(l) as GhIssue);
  const r = mapIssues(issues, { repo: REPO, founderLogins: ["Widget-Founder"], known, businessId: "business:widget-co" });
  const node = (id: string) => r.write.nodes.find((n) => n.id === id);
  const has = (from: string, type: string, to: string) => r.write.edges.some((e) => e.from === from && e.type === type && e.to === to);
  const t12 = issueTaskId(REPO, 12);
  const t11 = issueTaskId(REPO, 11);

  it("maps an issue to a Task with status, labels and its own Document", () => {
    expect(t12).toBe("task:issue-widget-brain-12");
    expect(node(t12)).toMatchObject({
      type: "Task", name: "Instagram reels: add Hindi captions to every reel", asOf: "2026-10-12",
      props: { kind: "issue", status: "open", ref: "widget-brain#12", repo: REPO, number: 12, labels: ["dept:content", "founder-action"] },
    });
    expect(node(t11)).toMatchObject({ props: { status: "closed", closedAt: "2026-10-05T06:30:00Z" } });
    const docId = node(t12)!.src!;
    expect(node(docId)).toMatchObject({ type: "Document", props: { kind: "issue", url: "https://github.com/Widget-Org/widget-brain/issues/12" } });
    expect(has(t12, "SOURCED_FROM", docId)).toBe(true);
  });

  it("gives the Task an owner: the first assignee, else the founder for a founder-action label", () => {
    expect(has("person:founder", "OWNS", t12)).toBe(true);
    expect(has("person:octo-dev", "OWNS", t11)).toBe(true);
    expect(node("person:octo-dev")).toMatchObject({ type: "Person", name: "octo-dev", props: { githubLogin: "octo-dev" } });
    const t7 = issueTaskId(REPO, 7);
    expect(r.write.edges.filter((e) => e.type === "OWNS" && e.to === t7).map((e) => e.from)).toEqual(["person:founder"]);
  });

  it("MENTIONS known entities by name (whole words; single words case-sensitive) and the teams in dept: labels", () => {
    const m12 = r.write.edges.filter((e) => e.type === "MENTIONS" && e.from === t12).map((e) => e.to).sort();
    expect(m12).toEqual(["agent:scout", "channel:instagram", "system:instagram", "team:content"]);
    const m11 = r.write.edges.filter((e) => e.type === "MENTIONS" && e.from === t11).map((e) => e.to).sort();
    expect(m11).toEqual(["system:google-search-console", "team:tech"]); // "instagramming" is not Instagram
    expect(r.write.edges.some((e) => e.to === "business:widget-co")).toBe(false); // the business itself is not news
  });

  it("skips pull requests and issues whose title or labels are sensitive", () => {
    const ids = r.write.nodes.map((n) => n.id);
    for (const n of [8, 9, 10]) expect(ids).not.toContain(issueTaskId(REPO, n));
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.ref, s.reason]));
    expect(reasons[`${REPO}#8`]).toMatch(/pull request/);
    expect(reasons[`${REPO}#9`]).toMatch(/sensitive/);
    expect(reasons[`${REPO}#10`]).toMatch(/sensitive/);
    expect(JSON.stringify(r.write)).not.toMatch(/token|usual place/i);
  });

  it("keeps a short summary of the body, with sensitive sections dropped and contact details redacted", () => {
    const s = node(t12)!.summary!;
    expect(s).toContain("The Scout agent drafts them.");
    expect(s).not.toMatch(/password|help@widget/);
    expect(r.redactions.email).toBe(1);
  });

  it("is self-contained apart from MENTIONS of known entities", () => {
    const ids = new Set([...r.write.nodes.map((n) => n.id), ...known.map((k) => k.id)]);
    expect(r.write.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to))).toEqual([]);
  });
});

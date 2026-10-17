// Folding repeats (web/src/lib/group.ts): the same idea drafted on several mornings is one row with a count, the newest leads,
// and a week-old item sits under "Older". Presentation only: every item stays in a group.
import { describe, expect, it } from "vitest";
import { draftRows, groupDrafts, groupIdeas, groupThreads, nearSameTitle, splitOlder, subjectOf } from "../../web/src/lib/group.js";

const d = (id: string, title: string, createdAt: string, slug?: string) => ({ id, title, createdAt, status: "pending", ...(slug ? { recommendationId: `recommendation:${slug}` } : {}) });

// the shape of aamdani's real waiting list on 17 Oct
const AAMDANI = [
  d("1", "Funnel: 80% drop at job applied (Seekers)", "2026-10-15T01:44:00Z", "insight-funnel-biggest-drop-audience-seekers-seeker-signup-funnel-0b6da1"),
  d("2", "Funnel: 72.7% drop at activated (Seekers)", "2026-10-15T01:44:00Z", "insight-funnel-biggest-drop-audience-seekers-signup-funnel-a6bbe0"),
  d("3", "A follow-up message: Seekers signup funnel: 80% drop from onboarding setup compl", "2026-10-16T06:57:00Z", "standup-finding-funnel-biggest-drop-audience-seekers-seeke-d2453f-20261016"),
  d("4", "A follow-up message: Seekers signup funnel: 72.7% drop from setup completed to a", "2026-10-16T06:57:00Z", "standup-finding-funnel-biggest-drop-audience-seekers-signu-6782a7-20261016"),
  d("5", "Reel for Instagram to end a 10-day gap", "2026-10-15T01:44:00Z", "insight-content-posting-gap-channel-instagram-822af5"),
  d("6", "A Instagram post (none in a while)", "2026-10-16T06:58:00Z", "standup-finding-content-posting-gap-channel-instagram-6c5782-20261016"),
  d("7", "Reel for Facebook to end a 10-day gap", "2026-10-15T01:44:00Z", "insight-content-posting-gap-channel-facebook-4feab1"),
  d("8", "New words for the website: show your opening hours", "2026-10-16T06:59:00Z", "standup-website-rule-allevia-website-checkup-opening-hours-62cfb1-20261016"),
  d("9", "New words for the website: show reviews or proof from customers", "2026-10-16T06:59:00Z", "standup-website-rule-allevia-website-checkup-proof-f2c2f2-20261016"),
  d("10", "Pause or cut budget on YouTube Shorts — brand campaign", "2026-10-15T05:42:00Z", "pause-or-cut-budget-on-youtube-shorts-brand-campaign"),
  d("11", "Pause YouTube Shorts — brand", "2026-10-15T01:44:00Z", "insight-ads-high-cpa-campaign-youtube-shorts-brand-d8d87a"),
];

describe("subjectOf", () => {
  it("drops the source, the hash and the date", () => {
    expect(subjectOf("recommendation:standup-finding-content-posting-gap-channel-instagram-6c5782-20261016")).toBe("content-posting-gap-channel-instagram");
    expect(subjectOf("recommendation:insight-content-posting-gap-channel-instagram-822af5")).toBe("content-posting-gap-channel-instagram");
    expect(subjectOf(undefined)).toBeUndefined();
  });
});

describe("groupDrafts", () => {
  const groups = groupDrafts(AAMDANI);
  const ids = groups.map((g) => g.items.map((a) => a.id).sort());
  it("folds the same finding drafted on two days, newest first", () => {
    expect(ids).toContainEqual(["1", "3"]);
    expect(ids).toContainEqual(["2", "4"]);
    expect(ids).toContainEqual(["5", "6"]);
    expect(groups.find((g) => g.items.length === 2 && g.items.some((a) => a.id === "1"))!.lead.id).toBe("3");
  });
  it("folds near-identical titles", () => {
    expect(ids).toContainEqual(["10", "11"]);
    expect(nearSameTitle("A post in the style of what worked best", "A post in the style of what worked best")).toBe(true);
  });
  it("keeps different findings apart: 80% and 72.7%, Facebook and Instagram, opening hours and proof", () => {
    expect(ids).toContainEqual(["7"]);
    expect(ids).toContainEqual(["8"]);
    expect(ids).toContainEqual(["9"]);
  });
  it("loses nothing, and keeps the list's order by each group's first member", () => {
    expect(groups.flatMap((g) => g.items).length).toBe(AAMDANI.length);
    expect(groups[0]!.items.map((a) => a.id)).toContain("1");
    expect(draftRows(AAMDANI)).toBe(groups.length);
    expect(groups.length).toBe(7);
  });
});

describe("splitOlder", () => {
  it("puts groups whose newest member is over a week old under Older", () => {
    const g = groupIdeas([
      { id: "recommendation:insight-a-long-subject-name-here-aaaaaa", title: "Old one", createdAt: "2026-10-01T00:00:00Z" },
      { id: "recommendation:insight-b-long-subject-name-here-bbbbbb", title: "New one", createdAt: "2026-10-16T00:00:00Z" },
    ]);
    const { recent, older } = splitOlder(g, (r) => r.createdAt, new Date("2026-10-17T12:00:00Z"));
    expect(recent.map((x) => x.lead.title)).toEqual(["New one"]);
    expect(older.map((x) => x.lead.title)).toEqual(["Old one"]);
  });
});

describe("groupThreads", () => {
  it("folds the same question asked again, and nothing else", () => {
    const g = groupThreads([
      { id: "a", title: "What else breaks if the sign-up flow breaks?", lastAt: "2026-10-17T10:00:00Z" },
      { id: "b", title: "What should we post this week?", lastAt: "2026-10-17T09:00:00Z" },
      { id: "c", title: "what else breaks if the sign-up flow breaks", lastAt: "2026-10-16T10:00:00Z" },
      { id: "d", title: "What else breaks if the sign-up flow breaks?", lastAt: "2026-10-15T10:00:00Z" },
    ]);
    expect(g.map((x) => [x.lead.id, x.items.length])).toEqual([["a", 3], ["b", 1]]);
  });
});

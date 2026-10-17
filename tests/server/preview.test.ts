// What a card waiting for the owner's OK carries beyond its text (src/server/preview.ts), and that GET /api/:t/approvals
// serves it: the pictures of a poster with our pick, who an email goes to, when a meeting is and with whom. Issue #43 (Home
// shows each draft's real content so the owner can decide in place).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertNode } from "../../src/graph/upsert.js";
import { oneLine, previewOf } from "../../src/server/preview.js";
import type { ApprovalDto } from "../../src/server/types.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { harness, type Harness } from "./harness.js";

const poster = {
  title: "Diwali poster", body: "Light up your evening. Book a table.", target: "instagram",
  studio: {
    originalId: "asset:o", recommended: "asset:b", altText: "", hashtags: [], credits: 1, voiceRuleIds: [],
    variants: [
      { id: "asset:a", label: "A", badge: "unchanged", note: "Building unchanged · warm light", aiEdited: false },
      { id: "asset:b", label: "B", badge: "unchanged", note: "Changed: gold lettering", aiEdited: true },
      { id: "asset:c", label: "C", badge: "held", note: "Lettering drifted", aiEdited: true },
    ],
    creative: { kind: "poster", aspect: "4:5", channel: "instagram", by: "content-strategist", allowUnchecked: true },
  },
};

describe("previewOf", () => {
  it("a poster: every option, our pick, the one that was held back, and no machine note as the reason", () => {
    const v = previewOf(JSON.stringify(poster), { kind: "content_draft", why: "Miss Influencer: looks usable (kitchen). Variant B recommended; Fact Checker: unchanged." });
    expect(v?.why).toBeUndefined();
    expect(v?.media?.kind).toBe("poster");
    expect(v?.media?.options).toEqual([
      { id: "asset:a", label: "A", note: "warm light", pick: false, held: false },
      { id: "asset:b", label: "B", note: "gold lettering", pick: true, held: false },
      { id: "asset:c", label: "C", note: "Lettering drifted", pick: false, held: true },
    ]);
  });

  it("an email: who it goes to, who is copied, the subject, and whether it is only a draft", () => {
    const sent = previewOf({ title: "Reply", subject: "Your quote", to: ["maya@example.com", "raj@example.com"], cc: ["me@example.com"], body: "Hi", send: true }, { kind: "email_send" });
    expect(sent).toEqual({ to: "maya@example.com, raj@example.com", cc: "me@example.com", subject: "Your quote" });
    expect(previewOf({ subject: "Hello", to: "a@b.co", send: false }, { kind: "email_send" })).toEqual({ to: "a@b.co", subject: "Hello", draftOnly: true });
  });

  it("a meeting: when it starts and ends, in whose time zone, and who is invited", () => {
    const v = previewOf({ title: "Call with Maya", start: "2026-10-21T10:00:00.000Z", end: "2026-10-21T10:30:00.000Z", timeZone: "Asia/Kolkata", attendees: ["maya@example.com"] }, { kind: "calendar_event" });
    expect(v?.when).toEqual({ start: "2026-10-21T10:00:00.000Z", end: "2026-10-21T10:30:00.000Z", timeZone: "Asia/Kolkata", guests: ["maya@example.com"] });
    expect(previewOf({ title: "Call", start: "soon" }, { kind: "calendar_event" })).toBeUndefined();
  });

  it("the reason is one sentence without citation marks; a card with nothing extra has no preview", () => {
    expect(previewOf({ title: "x", body: "y" }, { kind: "github_issue", why: "Your home page has no meta description [[page:home]]. Google shows a random line instead." }))
      .toEqual({ why: "Your home page has no meta description." });
    expect(previewOf({ title: "x", body: "y" }, { kind: "content_draft" })).toBeUndefined();
    expect(previewOf("not json", { kind: "content_draft" })).toBeUndefined();
    expect(previewOf(null, { kind: "email_send" })).toBeUndefined();
    expect(oneLine("  ")).toBeUndefined();
  });

  it("keeps a long list of options to the first six and ignores ones with no id", () => {
    const many = { studio: { recommended: "v1", variants: Array.from({ length: 9 }, (_, i) => ({ id: i === 2 ? "" : `v${i}`, label: String.fromCharCode(65 + i), badge: "unchanged", note: "" })) } };
    expect(previewOf(many, { kind: "content_draft" })?.media?.options.map((o) => o.id)).toEqual(["v0", "v1", "v3", "v4", "v5"]);
  });
});

describe("GET /api/:t/approvals carries the preview", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    await upsertNode(h.g, { type: "Approval", id: "approval:pv-poster", name: "content_draft: Diwali poster", props: {
      status: "pending", kind: "content_draft", title: "Diwali poster", by: "content-strategist", payload: JSON.stringify(poster) } }, SEED_NOW);
    await upsertNode(h.g, { type: "Approval", id: "approval:pv-meet", name: "calendar_event: Call with Maya", props: {
      status: "pending", kind: "calendar_event", title: "Meeting: Call with Maya", payload: JSON.stringify({ title: "Call with Maya", body: "", start: "2026-10-21T10:00:00.000Z", end: "2026-10-21T10:30:00.000Z", timeZone: "Asia/Kolkata", attendees: ["maya@example.com"], target: "Google Calendar" }) } }, SEED_NOW);
    await upsertNode(h.g, { type: "Approval", id: "approval:pv-plain", name: "github_issue: Fix the sitemap", props: {
      status: "pending", kind: "github_issue", title: "Fix the sitemap", payload: JSON.stringify({ title: "Fix the sitemap", body: "Resubmit it." }) } }, SEED_NOW);
  }, 90_000);
  afterAll(async () => h.cleanup());

  it("a poster shows its options, a meeting its time and guest, and a plain card has none", async () => {
    const res = await h.app.request("/api/mini/approvals");
    expect(res.status).toBe(200);
    const list = (await res.json()) as ApprovalDto[];
    const by = (id: string) => list.find((a) => a.id === id)!;
    expect(by("approval:pv-poster").preview?.media?.options.map((o) => [o.label, o.pick])).toEqual([["A", false], ["B", true], ["C", false]]);
    expect(by("approval:pv-poster").payload.body).toBe("Light up your evening. Book a table.");
    expect(by("approval:pv-meet").preview?.when).toMatchObject({ timeZone: "Asia/Kolkata", guests: ["maya@example.com"] });
    expect(by("approval:pv-plain").preview).toBeUndefined();
  });
});

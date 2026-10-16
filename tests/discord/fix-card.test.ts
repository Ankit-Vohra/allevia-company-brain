// Issue #8: a card waiting for the owner's OK on Discord says what it is in plain words. A fix is "a fix for your website"
// and says where it goes (the business's action target), never "GitHub issue" and never Allevia's own repo as its subject.
import { describe, expect, it } from "vitest";
import { approvalCard } from "../../src/discord/bot.js";
import type { ApprovalDto } from "../../src/server/types.js";

const card = (over: Partial<ApprovalDto> = {}): ApprovalDto => ({
  id: "approval:fix-1", kind: "github_issue", status: "pending", by: "tech-lead", title: "Home page: add your phone number to the first screen",
  createdAt: "2026-10-16T08:00:00.000Z", simulated: false,
  payload: { title: "Home page: add your phone number", body: "Visitors on phones can't see how to call you.", target: "https://kestrel.example/" },
  ...over,
} as ApprovalDto);

describe("the fix card on Discord", () => {
  it("says 'a fix for your website' and that it becomes a to-do, by default", () => {
    const { content, buttons } = approvalCard(card());
    expect(content).toContain("a fix for your website");
    expect(content).toContain("If you say OK, it becomes a to-do in your tasks. Nothing on your site changes yet.");
    expect(content).toContain("About: https://kestrel.example/");
    expect(content).not.toMatch(/GitHub issue|Target:/);
    expect(buttons.map((b) => b.label)).toEqual(["Approve", "Change", "No thanks"]);
  });

  it("names the business's own repo when it chose one", () => {
    const { content } = approvalCard(card(), { target: { kind: "github", repo: "kestrel-dental/website-fixes" } });
    expect(content).toContain("If you say OK, it goes to kestrel-dental/website-fixes on GitHub as a to-do.");
  });

  it("never shows a repo name as what the fix is about", () => {
    const { content } = approvalCard(card({ payload: { title: "t", body: "b", target: "Ankit-Vohra/allevia" } }));
    expect(content).not.toContain("Ankit-Vohra/allevia");
  });

  it("drops the 'if you say OK' line once the card is decided", () => {
    const { content } = approvalCard(card({ status: "approved" }), { buttons: false });
    expect(content).not.toContain("If you say OK");
  });

  it("says the other kinds plainly too, and sample numbers as sample numbers", () => {
    expect(approvalCard(card({ kind: "content_draft" })).content).toContain("a draft post");
    expect(approvalCard(card({ kind: "pause_ad", simulated: true })).content).toMatch(/pausing an ad \(sample numbers\)/);
    expect(approvalCard(card({ kind: "discord_post" })).content).toContain("a message to your team chat");
  });
});

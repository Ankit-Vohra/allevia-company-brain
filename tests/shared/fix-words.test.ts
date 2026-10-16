// What a fix card is about (shared/fix-words.ts): the website unless the title says the app, so an app crash is never
// "a fix for your website" (audit #39). The same words reach the web app, the Discord cards and today's note.
import { describe, expect, it } from "vitest";
import { FIX_BUILDER, FIX_LABEL, FIX_UNCHANGED, fixLabelCap, fixSubject } from "../../shared/fix-words.js";
import { approvalCard } from "../../src/discord/bot.js";
import { renderApproval } from "../../src/discord/approval-card.js";
import type { ApprovalDto } from "../../src/server/types.js";

const card = (title: string, target?: string): ApprovalDto => ({
  id: "approval:fix-1", kind: "github_issue", status: "pending", by: "oncall-engineer", title, createdAt: "2026-10-16T08:00:00.000Z",
  payload: { title, body: "Details.", ...(target ? { target } : {}) },
} as ApprovalDto);

describe("fixSubject", () => {
  it("is the website for the site's own fixes, and by default", () => {
    expect(fixSubject('SEO: Home fails "No meta description"')).toBe("website");
    expect(fixSubject("Home page: add your phone number to the first screen", "https://kestrel.example/")).toBe("website");
    expect(fixSubject(undefined)).toBe("website");
  });
  it("is the app for crashes, Android problems and release checks", () => {
    expect(fixSubject('App: fix "TypeError in checkout"', "Sentry")).toBe("app");
    expect(fixSubject("App: look at 3 new errors since 9 Oct")).toBe("app");
    expect(fixSubject("Android: bring crashes under 1.09% (now 2.1%)")).toBe("app");
    expect(fixSubject("Release check: 2 new errors since the build of 9 Oct")).toBe("app");
    expect(fixSubject("Something else", "Sentry")).toBe("app");
  });
  it("does not guess for a funnel drop, which could be either", () => {
    expect(fixSubject("Funnel: 38% drop at checkout (app)")).toBe("other");
  });
});

describe("the words", () => {
  it("name the thing, and who builds it", () => {
    expect(FIX_LABEL).toEqual({ website: "a fix for your website", app: "a fix for your app", other: "a fix to hand over" });
    expect(fixLabelCap("app")).toBe("A fix for your app");
    expect(FIX_BUILDER.app).toBe("whoever builds your app");
    expect(FIX_UNCHANGED.website).toBe("Nothing on your site changes yet.");
    expect(FIX_UNCHANGED.app).toBe("Nothing in your app changes yet.");
  });
});

describe("the Discord card says it too", () => {
  it("an app crash is a fix for your app, in both card builders, and nothing changes in the app yet", () => {
    const c = card('App: fix "TypeError in checkout"', "Sentry");
    const plain = approvalCard(c).content;
    expect(plain).toContain("a fix for your app");
    expect(plain).not.toContain("your website");
    expect(plain).toContain("Nothing in your app changes yet.");
    const rich = renderApproval(c).first.content;
    expect(rich).toContain("a fix for your app");
    expect(rich).not.toContain("a fix for your website");
  });
  it("a website fix still says website", () => {
    expect(approvalCard(card("SEO: rewrite the title of /jobs", "https://x.example/jobs")).content).toContain("a fix for your website");
    expect(renderApproval(card("SEO: rewrite the title of /jobs", "https://x.example/jobs")).first.content).toContain("a fix for your website");
  });
});

// What each draft is called and what saying OK does (web/src/lib/approval-words.ts): the same words on the Approvals page, in the
// chat and on Home. A fix says website or app; an email the team only drafts says nothing is sent (issues #39, #43).
import { describe, expect, it } from "vitest";
import { ownerJargon } from "../../src/agent/style.js";
import { kindWords } from "../../web/src/lib/approval-words.js";

describe("kindWords", () => {
  it("a fix is for the website unless the card says the app", () => {
    expect(kindWords({ kind: "github_issue", title: "SEO: rewrite the title of /jobs" }).label).toBe("A fix for your website");
    const app = kindWords({ kind: "github_issue", title: 'App: fix "TypeError in checkout"', payload: { target: "Sentry" } });
    expect(app.label).toBe("A fix for your app");
    expect(app.effect()).toBe("If you say OK, this goes to whoever builds your app as a to-do. Nothing in your app changes yet.");
    expect(app.done).toBe("Sent to whoever builds your app.");
    expect(kindWords({ kind: "github_issue", title: "Funnel: 38% drop at checkout" }).label).toBe("A fix to hand over");
  });

  it("an email says it is sent, unless the team only drafts it for the inbox", () => {
    expect(kindWords({ kind: "email_send" }).effect()).toMatch(/sent from your address/);
    const draft = kindWords({ kind: "email_send", preview: { draftOnly: true } });
    expect(draft.label).toBe("An email draft for your inbox");
    expect(draft.effect()).toBe("If you say OK, this is saved as a draft in your inbox. Nothing is sent.");
    expect(draft.done).toBe("Draft saved in your inbox. Nothing was sent.");
  });

  it("every kind has a label, an effect and a done line in the owner's words", () => {
    for (const kind of ["github_issue", "content_draft", "pause_ad", "discord_post", "calendar_event", "email_send", "connection_action"] as const) {
      const k = kindWords({ kind, title: "x" });
      for (const line of [k.label, k.effect("Instagram"), k.done]) expect(ownerJargon(line), `${kind}: ${line}`).toEqual([]);
      expect(k.label).toMatch(/^An? /);
    }
    expect(kindWords({ kind: "discord_post" }).effect("#general")).toBe("If you say OK, this is posted to #general.");
  });
});

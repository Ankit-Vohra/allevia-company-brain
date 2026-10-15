// What the owner is told about Discord (web/src/lib/discord.ts): plain words, and nothing shown without a hub.
import { describe, expect, it } from "vitest";
import { DISCORD_WORDS, viewOfHome, viewOfInfo } from "../../web/src/lib/discord.js";

describe("the Discord card", () => {
  it("shows the join link from the onboarding done event, or says it is coming, or nothing", () => {
    expect(viewOfInfo({ inviteUrl: "https://discord.gg/abc" })).toEqual({ state: "invite", inviteUrl: "https://discord.gg/abc" });
    expect(viewOfInfo({ later: true })).toEqual({ state: "later" });
    expect(viewOfInfo({})).toBeNull();
    expect(viewOfInfo(undefined)).toBeNull(); // a server with no Discord hub
  });

  it("follows the Home endpoint, and shows nothing when the hub is off", () => {
    expect(viewOfHome(undefined)).toBeNull();
    expect(viewOfHome({ enabled: false })).toBeNull();
    expect(viewOfHome({ enabled: true, state: "invite", inviteUrl: "https://discord.gg/abc" })).toEqual({ state: "invite", inviteUrl: "https://discord.gg/abc" });
    expect(viewOfHome({ enabled: true, state: "joined", openUrl: "https://discord.com/channels/1/2" })).toEqual({ state: "joined", openUrl: "https://discord.com/channels/1/2" });
    expect(viewOfHome({ enabled: true, state: "expired" })).toEqual({ state: "expired" });
    expect(viewOfHome({ enabled: true, state: "later" })).toEqual({ state: "later" });
  });

  it("uses the words the founder asked for, and no machinery", () => {
    expect(DISCORD_WORDS.inviteTitle).toBe("Join your team on Discord");
    expect(DISCORD_WORDS.laterLine).toBe("We'll send your Discord link shortly.");
    for (const w of Object.values(DISCORD_WORDS)) expect(w).not.toMatch(/invite|tenant|provision|role|graph|agent|api/i);
  });
});

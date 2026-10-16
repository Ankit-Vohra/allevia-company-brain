// The discord.js side, without a network: the CLI's missing-settings message (names, never values), token redaction,
// the slash command definitions, the invite link, and how a discord.js Message maps to the bot's MessagePort.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageType, type Message } from "discord.js";
import { main } from "../../src/cli.js";
import { SLASH_COMMANDS, inviteUrl, messagePort, redactor } from "../../src/discord/client.js";

describe("discord CLI", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("names the missing settings and exits without starting when the token is not set", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await main(["discord", "--tenant", "demo_seed"]);
    expect(code).toBe(1);
    const out = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("DISCORD_BOT_TOKEN");
    expect(out).toContain("~/.config/allevia/allevia.env");
  });
});

describe("discord.js adapter", () => {
  it("redacts the token from anything it logs", () => {
    const redact = redactor("tok.en-value_123");
    expect(redact("401 for tok.en-value_123 at gateway, tok.en-value_123")).toBe("401 for [token] at gateway, [token]");
    expect(redactor(undefined)("plain")).toBe("plain");
  });

  it("defines /ask (a required question), /brief, /approvals and /checkup", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(["ask", "brief", "approvals", "checkup", "connect"]);
    const ask = SLASH_COMMANDS[0]!;
    expect(ask.options?.[0]).toMatchObject({ name: "question", required: true });
  });

  it("builds an invite link asking for the bot and slash-command scopes", () => {
    const u = new URL(inviteUrl("1234567890"));
    expect(u.searchParams.get("client_id")).toBe("1234567890");
    expect(u.searchParams.get("scope")).toBe("bot applications.commands");
  });

  const fakeMessage = (o: { inThread: boolean; type?: MessageType; system?: boolean; content?: string; authorId?: string }) => ({
    id: "m1", guildId: "g1", channelId: o.inThread ? "t1" : "c1",
    channel: { isThread: () => o.inThread, parentId: "c1", id: o.inThread ? "t1" : "c1", send: async () => ({ id: "x" }) },
    author: { id: o.authorId ?? "owner", bot: false },
    guild: { ownerId: "owner" },
    system: o.system ?? false,
    type: o.type ?? MessageType.Default,
    content: o.content ?? "<@42> What breaks if the Instagram token expires?",
  }) as unknown as Message;

  it("maps a channel message: no thread, the bot's mention removed, the owner recognised", () => {
    const p = messagePort(fakeMessage({ inThread: false }), "42");
    expect(p).toMatchObject({ guildId: "g1", channelId: "c1", threadParentId: null, authorIsOwner: true, system: false });
    expect(p.content).toBe("What breaks if the Instagram token expires?");
    expect(p.thread()).toBeNull();
  });

  it("maps a message in a thread to its parent channel, and flags system messages", () => {
    const p = messagePort(fakeMessage({ inThread: true, authorId: "someone" }), "42");
    expect(p).toMatchObject({ channelId: "t1", threadParentId: "c1", authorIsOwner: false });
    expect(p.thread()?.id).toBe("t1");
    expect(messagePort(fakeMessage({ inThread: false, type: MessageType.ThreadCreated }), "42").system).toBe(true);
    expect(messagePort(fakeMessage({ inThread: false, system: true }), "42").system).toBe(true);
  });
});

// `discord`: the Allevia Discord bot (spec §10) for one tenant, on the demo server only. Runs until Ctrl-C.
// Needs DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID and DISCORD_CHANNEL_ID in
// ~/.config/allevia/allevia.env; it says which are missing (never their values) and exits.
import { parseArgs } from "node:util";
import type { Command } from "./_command.js";

const USAGE = "discord [--tenant aamdani] [--model haiku]";

export const commands: Command[] = [
  {
    name: "discord",
    usage: USAGE,
    summary: "Run the Discord bot on the demo server (threads, live work log, /ask, /brief, /approvals)",
    async run(args) {
      const { values } = parseArgs({ args, options: { tenant: { type: "string" }, model: { type: "string" } } });
      const tenant = values.tenant?.trim() || "aamdani";
      const { loadConfig } = await import("../config.js");
      const { missingDiscordSettings } = await import("../discord/main.js");
      const missing = missingDiscordSettings(loadConfig());
      if (missing.length) {
        console.error(`The Discord bot needs ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"} to ~/.config/allevia/allevia.env (never to the repo) and run again.`);
        return 1;
      }
      const { startDiscordBot } = await import("../discord/main.js");
      const { stop } = await startDiscordBot({ tenant, ...(values.model ? { model: values.model } : {}) });
      const { untilStopped } = await import("../server/main.js");
      await untilStopped(stop);
      return 0;
    },
  },
];

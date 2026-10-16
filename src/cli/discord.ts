      // a 24/7 bot: a database restart is logged and waited out, never a crash (issue #28)
      (await import("../util/crash-guard.js")).installCrashGuard();
// `discord`: the Allevia Discord bot (spec §10) for one tenant, on the demo server only. Runs until Ctrl-C.
// Needs DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID and DISCORD_CHANNEL_ID in
// ~/.config/allevia/allevia.env; it says which are missing (never their values) and exits.
import { parseArgs } from "node:util";
import type { Command } from "./_command.js";

const USAGE = "discord [--tenant aamdani] [--model haiku] [--demo]";

export const commands: Command[] = [
  {
    name: "discord",
    usage: USAGE,
    summary: "Run the Discord bot: the customer hub when DISCORD_HUB_GUILD_ID is set (--demo: the old demo server instead), else the demo server",
    async run(args) {
      const { values } = parseArgs({ args, options: { tenant: { type: "string" }, model: { type: "string" }, demo: { type: "boolean" } } });
      const tenant = values.tenant?.trim() || "aamdani";
      const { loadConfig } = await import("../config.js");
      // Hub mode (every customer, one shared bot) is selected by DISCORD_HUB_GUILD_ID; the single-channel demo is unchanged.
      const { hubSettings } = await import("../discord/hub-service.js");
      const hub = hubSettings(loadConfig());
      if (hub.configured && !values.demo) {
        if (!hub.settings) {
          console.error(`The Discord hub needs ${hub.missing.join(", ")}. Add ${hub.missing.length === 1 ? "it" : "them"} to ~/.config/allevia/allevia.env (never to the repo) and run again.`);
          return 1;
        }
        const { startHubBot } = await import("../discord/hub-main.js");
        const { stop } = await startHubBot({ ...(values.model ? { model: values.model } : {}) });
        const { untilStopped } = await import("../server/main.js");
        await untilStopped(stop);
        return 0;
      }
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

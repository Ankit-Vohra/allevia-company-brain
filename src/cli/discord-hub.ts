// `discord-hub`: staff tools for the customer hub on Discord (docs/discord-hub-setup.md).
//   discord-hub status               read-only: is the bot in the hub with the permissions and switches it needs? PASS / FAIL list
//   discord-hub list                 read-only: every company on the hub with its channels, checked against Discord
//   discord-hub provision <tenant>   set the business's area up (or repair it; safe to run again) and print its join link
//   discord-hub reinvite <tenant>    a fresh single-use join link (the old one stops working)
// Secrets come from ~/.config/allevia/allevia.env and are never printed.
import type { Command } from "./_command.js";

const USAGE = "discord-hub status | list | provision <tenant> | reinvite <tenant>";

async function service() {
  const { loadConfig } = await import("../config.js");
  const { hubSettings, productionHub } = await import("../discord/hub-service.js");
  const cfg = loadConfig();
  const s = hubSettings(cfg);
  if (!s.configured) {
    console.error("The Discord hub is not switched on. Add DISCORD_HUB_GUILD_ID (and the rest, see docs/discord-hub-setup.md) to ~/.config/allevia/allevia.env.");
    return null;
  }
  if (!s.settings) {
    console.error(`The Discord hub needs ${s.missing.join(", ")}. Add ${s.missing.length === 1 ? "it" : "them"} to ~/.config/allevia/allevia.env (never to the repo). \`discord-hub status\` lists everything that is missing.`);
    return null;
  }
  return productionHub({ cfg, log: (l) => console.error(l) });
}

export const commands: Command[] = [
  {
    name: "discord-hub",
    usage: USAGE,
    summary: "Customer hub on Discord: status and list (read-only), provision a business, send a new join link",
    async run(args) {
      const [sub, tenant] = args;
      if (sub === "status") {
        const { hubStatusChecks } = await import("../discord/hub-service.js");
        const { formatChecks } = await import("../discord/hub-check.js");
        const checks = await hubStatusChecks();
        console.log(`Discord hub status (read-only, nothing was created or changed)\n\n${formatChecks(checks)}\n`);
        const failed = checks.filter((c) => !c.ok).length;
        console.log(failed ? `${failed} thing${failed === 1 ? "" : "s"} to fix before customers can join.` : "Everything the hub needs is in place.");
        return failed ? 1 : 0;
      }
      if (sub === "list") {
        const svc = await service();
        if (!svc) return 1;
        const { listCompanies, formatCompanies } = await import("../discord/hub-check.js");
        console.log(formatCompanies(await listCompanies({ hub: svc.deps.hub, store: svc.deps.store })));
        return 0;
      }
      if (sub === "provision" || sub === "reinvite") {
        if (!tenant) { console.error(`Usage: discord-hub ${sub} <tenant>`); return 2; }
        const svc = await service();
        if (!svc) return 1;
        const { provisionCustomer } = await import("../discord/hub-provision.js");
        const r = await provisionCustomer(tenant, svc.deps, sub === "reinvite" ? { newInvite: true } : {});
        console.log(`${r.area.businessName}: ready on the hub.`);
        for (const a of r.actions) console.log(`  ${a}`);
        console.log(r.inviteUrl ? `Join link (one person, 7 days): ${r.inviteUrl}` : "Somebody has already joined, so no new link was made. `discord-hub reinvite` makes one for another person.");
        return 0;
      }
      console.error(`Usage: ${USAGE}`);
      return 2;
    },
  },
];

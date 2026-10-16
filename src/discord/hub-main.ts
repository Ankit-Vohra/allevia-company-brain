// Runs the shared Allevia bot for the hub (selected by DISCORD_HUB_GUILD_ID): one process for every customer. Per
// customer it builds that business's own AlleviaBot lazily (its graph, its ask deps, its time zone), shares one count of
// running turns across them all, and every minute posts new approval cards and the day's note into the customer's own
// channels. Provisioning retries run here too (the same claim keeps two processes from doing one business twice).
import { botPublishPort } from "./publish-notice.js";
import { loadConfig } from "../config.js";
import { checkupJobs } from "../checkup/jobs.js";
import { businessId } from "../graph/tenants.js";
import { ask } from "../agent/ask.js";
import type { GraphHandle } from "../graph/client.js";
import { approval as readApproval } from "../server/reads.js";
import { AlleviaBot } from "./bot.js";
import { HubBot } from "./hub-bot.js";
import { sweepOfflineJoins } from "./hub-join.js";
import { loadAssetFile } from "../creative/files.js";
import { StudioDiscord, StudioGate } from "./studio-bot.js";
import { syncArea } from "./hub-provision.js";
import { tenantSource } from "./hub-source.js";
import { startApprovalNudge } from "./hub-nudge.js";
import { hubSettings, productionHub } from "./hub-service.js";
import { tenantTimeZone } from "./main.js";

export interface StartedHub { stop: () => Promise<void> }

export async function startHubBot(o: { model?: string; log?: (line: string) => void; syncEveryMs?: number }): Promise<StartedHub> {
  const log = o.log ?? ((line: string) => console.error(line));
  const cfg = loadConfig();
  const s = hubSettings(cfg);
  if (!s.settings) throw new Error(`Missing ${s.missing.join(", ")} in ~/.config/allevia/allevia.env.`);
  if (!s.settings.appId) throw new Error("Missing DISCORD_APPLICATION_ID in ~/.config/allevia/allevia.env.");
  const { token, appId, guildId, staffRoleId } = s.settings;

  const service = await productionHub({ cfg, log });
  if (!service) throw new Error("The hub is not configured.");
  const { createAskDeps, tenantGraph } = await import("../agent/wiring.js");
  const { productionDeps } = await import("../server/main.js");
  const { onDecision, actions } = productionDeps({ publicMode: false });
  const shared = { live: 0 };
  const gate = new StudioGate();
  const { productionStudioDeps, studioClip } = await import("../studio/wiring.js");
  const { realFfmpeg } = await import("../studio/video.js");
  const studioDeps = productionStudioDeps(cfg.dataDir);
  const clip = studioClip(cfg.dataDir, (slug) => tenantGraph(slug), { log });
  const ffmpeg = realFfmpeg();
  if (!(await ffmpeg.available())) log("[hub] ffmpeg is not installed: videos are kept but not looked at (install ffmpeg to assess their first frame).");

  const hubBot = new HubBot({
    guildId, staffRoleId, store: service.deps.store, hub: service.deps.hub, log,
    botFor: async (area) => {
      const graph = await tenantGraph(area.slug);
      const deps = await createAskDeps({ tenant: area.slug, ...(o.model ? { model: o.model } : {}) }, { graph });
      const timeZone = await tenantTimeZone(area.slug, graph);
      return new AlleviaBot({
        tenant: area.slug, guildId, channelId: area.channels["your-team"]!, webBase: cfg.webBaseUrl, graph, shared,
        ask: (input, emit) => ask(input, { ...deps, ...(timeZone ? { timeZone } : {}) }, emit),
        ...(onDecision ? { onDecision } : {}), ...(actions ? { actions } : {}), log,
        // what the team makes comes back here as files with Approve and Change, read from this business's own storage
        deliverables: { file: (assetId) => loadAssetFile(graph, studioDeps.store, area.slug, assetId) },
        // a spreadsheet dropped in #your-team adds this business's own numbers (the business comes from the channel only)
        numbers: { businessId: businessId(area.slug) },
        checkup: checkupJobs(), // /checkup: this business's own site, in the background
        connections: await connectLinks(area.slug), // /connect: this business's tools, with one-time links only the owner sees
        publish: botPublishPort(graph, area.slug, actions), // Cancel and Try again on a post: this business's own posts and connections
        revise: async (approvalId, instruction) => {
          const { reviseDraft } = await import("../proactive/revise.js");
          const { productionDrafters } = await import("../proactive/wiring.js");
          const r = await reviseDraft(graph, approvalId, instruction, { text: productionDrafters(graph, area.slug, businessId(area.slug)).text });
          if (!r.ok) return { why: r.why };
          return (await readApproval(graph, approvalId)) ?? { why: "That draft is no longer there." };
        },
      });
    },
    studioFor: async (area) => new StudioDiscord({
      tenant: area.slug, businessId: businessId(area.slug), graph: await tenantGraph(area.slug), studio: studioDeps, ffmpeg, gate, brandLibrary: true,
      ...(clip ? { clip } : {}),
      ...(onDecision ? { onDecision } : {}), ...(actions ? { actions } : {}), log,
    }),
  });

  // A join link used while the bot was not running: nobody can tell who joined, so staff are told to give the role by hand.
  try {
    const missed = await sweepOfflineJoins({ hub: service.deps.hub, store: service.deps.store, staffRoleId });
    const inbox = (await service.deps.store.getHub(guildId))?.supportInboxId;
    if (missed.length && inbox) {
      await service.deps.hub.sendMessage(inbox, `Someone joined with the join link for ${[...new Set(missed)].join(", ")} while the bot was not running, so they have no access yet. Find them in Server Settings > Members and give them the customer role by hand.`);
    }
  } catch (e) {
    log(`[hub] could not check for joins while the bot was off: ${e instanceof Error ? e.message : String(e)}`);
  }

  // (before logging in, so a join that arrives now is never mixed up with one that happened while the bot was off)
  const { startHubClient } = await import("./hub-client.js");
  const client = await startHubClient(hubBot, { token, appId, guildId }, log);

  const stopRetry = service.startRetryLoop();
  let syncing = false;
  const sync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      for (const a of await service.deps.store.listAreas()) {
        if (a.status !== "ready") continue;
        try {
          await syncArea(a.slug, service.deps, tenantSource(await tenantGraph(a.slug), a.slug, { store: studioDeps.store, webBase: cfg.webBaseUrl }));
        } catch (e) {
          log(`[hub] ${a.slug}: could not post cards or the note: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      // the list of businesses itself could not be read (the database restarting, issue #28): try again next minute
      log(`[hub] could not read the list of businesses: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      syncing = false;
    }
  };
  void sync();
  // a card made in this process (a chat turn, Studio, an insight) is posted within seconds, not at the next minute
  const stopNudge = startApprovalNudge({ deps: service.deps, log, source: async (slug) => tenantSource(await tenantGraph(slug), slug, { store: studioDeps.store, webBase: cfg.webBaseUrl }) });
  const timer = setInterval(() => void sync(), o.syncEveryMs ?? 60_000);
  timer.unref();
  log(`Allevia on the Discord hub: every customer's own channels, one shared bot. Path links go to ${cfg.webBaseUrl}.`);
  return { stop: async () => { clearInterval(timer); stopNudge(); stopRetry(); await client.stop(); } };
}

// /connect for one business: the list as an owner reads it and one-time links (src/connections), never another business's.
async function connectLinks(slug: string): Promise<import("./bot.js").ConnectLinks> {
  const { productionConnections } = await import("../connections/production.js");
  const { recommendedFor } = await import("../../shared/connection-map.js");
  const svc = productionConnections();
  const recommended = new Set(recommendedFor(null).map((e) => e.id));
  return {
    list: async () => (await svc.list(slug)).map((v) => ({ id: v.id, name: v.name, blurb: v.blurb, state: v.state, available: v.available, recommended: recommended.has(v.id) })),
    link: (id) => { try { return svc.connectLink(slug, id); } catch { return null; } },
  };
}

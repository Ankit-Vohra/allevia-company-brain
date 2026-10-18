// `meetings ingest`: one meeting-capture run for a business, now (src/meetings/capture.ts): its connected recorders' new calls become
// minutes, decisions and routed action items, with the minutes email waiting for the owner's OK. For the demo coffee business it
// reads the sample Fireflies account, through the same path. With --file it reads a transcript or notes from a file instead, the
// way the business's meeting address would. Running it again saves nothing twice.
// `meetings address`: the business's own meeting address, for a recorder or an automation to post transcripts to.
// `meetings forget`: forget the demo's SAMPLE recorded meeting (and what it wrote), so it can be shown arriving again. A real
// meeting is refused.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { openGraph } from "../graph/client.js";
import { meetingAddress } from "../meetings/address.js";
import { captureInbound, captureMeetings } from "../meetings/capture.js";
import { forgetSampleMeeting, NotSample } from "../meetings/forget.js";
import { SAMPLE_FIREFLIES_ID } from "../demo/sample/fireflies.js";
import { isSalesDemo, demoPortFor } from "../sales/demo.js";
import type { Command } from "./_command.js";
import { workLog } from "./_worklog.js";

export const commands: Command[] = [
  {
    name: "meetings",
    usage: "meetings ingest <tenant> [--recorder fireflies|granola] [--file notes.txt --title \"...\" --date YYYY-MM-DD] [--model haiku] [--quiet] | meetings address <tenant> | meetings forget <tenant> [--recorder fireflies --id <meeting id>]",
    summary: "Read a business's meeting recorder now: new calls become minutes and routed action items (or print its meeting address)",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: { recorder: { type: "string" }, file: { type: "string" }, title: { type: "string" }, date: { type: "string" }, id: { type: "string" }, model: { type: "string" }, quiet: { type: "boolean" }, json: { type: "boolean" } },
      });
      const [sub, tenant] = positionals;
      if (!tenant || (sub !== "ingest" && sub !== "address" && sub !== "forget")) {
        console.error("Usage: npm run cli -- meetings ingest <tenant> [--recorder fireflies|granola] [--file notes.txt]\n       npm run cli -- meetings address <tenant>\n       npm run cli -- meetings forget <tenant>   (the demo's sample meeting, for a retake)");
        return 2;
      }
      if (sub === "forget") {
        const recorder = (values.recorder ?? "fireflies") as "fireflies" | "granola" | "inbound";
        try {
          const r = await forgetSampleMeeting(await openGraph(tenant), recorder, values.id ?? SAMPLE_FIREFLIES_ID);
          console.log(r ? `Forgot the sample meeting ${r.meetingId}: ${r.nodes} records and ${r.turns} chat thread(s). Run "meetings ingest ${tenant}" to show it arriving again.` : "That meeting is not saved, so there is nothing to forget.");
          return 0;
        } catch (e) {
          if (e instanceof NotSample) { console.error(e.message); return 1; }
          throw e;
        }
      }
      if (sub === "address") {
        const url = meetingAddress(loadConfig().webBaseUrl, loadConfig().google.connectorKey, tenant);
        if (!url) { console.error("The meeting address is off: set ALLEVIA_CONNECTOR_KEY (at least 32 characters) first."); return 1; }
        console.log(url);
        console.log('Post a transcript to it: curl -X POST -H "content-type: application/json" -d \'{"id":"call-1","title":"...","transcript":"..."}\' <address>');
        return 0;
      }
      const g = await openGraph(tenant);
      const { wiring } = await import("../agent/wiring.js");
      let made: Awaited<ReturnType<typeof wiring.createAskDeps>> | undefined;
      const askDeps = async () => (made ??= await wiring.createAskDeps({ tenant, ...(values.model ? { model: values.model } : {}) }));
      const port = isSalesDemo(tenant) ? demoPortFor(tenant) : (await import("../connections/production.js")).productionConnections().port(tenant);
      const emit = values.quiet || values.json ? () => undefined : workLog();
      const deps = { graph: g, port, askDeps, channel: "cli" as const, emit, log: (l: string) => console.error(l) };

      if (values.file) {
        const text = readFileSync(values.file, "utf8");
        const r = await captureInbound(tenant, { text, ...(values.id ? { id: values.id } : {}), ...(values.title ? { title: values.title } : {}), ...(values.date ? { date: values.date } : {}) }, deps);
        if (values.json) { console.log(JSON.stringify({ status: r.status, meetingId: r.meetingId })); return r.status === "failed" ? 1 : 0; }
        console.log(r.status === "already_saved" ? `\nThat meeting is already saved (${r.meetingId}): nothing new was written.` : r.status === "saved" ? `\nSaved ${r.meetingId}.` : "\nCould not save that meeting.");
        return r.status === "failed" ? 1 : 0;
      }

      const r = await captureMeetings(tenant, deps, values.recorder ? { recorder: values.recorder } : {});
      if (values.json) { console.log(JSON.stringify(r, null, 2)); return r.saved.some((s) => !s.ok) ? 1 : 0; }
      console.log("");
      for (const x of r.recorders) console.log(`${x.state === "connected" ? "✓" : "·"} ${x.message}`);
      for (const s of r.skipped) console.log(`  skipped "${s.title}" (${s.recorder}): ${s.why}`);
      for (const s of r.saved) console.log(`  ${s.ok ? "saved" : "FAILED"} "${s.title}" (${s.recorder}): thread ${s.sessionId}`);
      if (!r.saved.length && !r.skipped.length && r.recorders.some((x) => x.state === "connected")) console.log("  No calls to read.");
      if (r.saved.length) console.log(`\nSee it in Chat (the thread "New meeting from …") and the minutes email in Needs your OK. Run again: nothing is saved twice.`);
      return r.saved.some((s) => !s.ok) ? 1 : 0;
    },
  },
];

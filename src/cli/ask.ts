// `ask`: put a question to the agent company and watch the work log stream. `replay` prints a stored turn's log;
// `threads` lists a tenant's threads (session ids for `ask --session`).
// The real deps (SDK runtime, graph tools, search seeds) come from src/agent/wiring.ts, imported dynamically so this
// command loads even before the tools land.
import { parseArgs } from "node:util";
import { openGraph } from "../graph/client.js";
import { ask, type AgentWiring } from "../agent/ask.js";
import { getTurnEvents, listSessions } from "../agent/memory.js";
import { formatIst } from "../util/time.js";
import type { Command } from "./_command.js";
import { interruptible } from "./_interrupt.js";
import { workLog } from "./_worklog.js";

const WIRING = "../agent/wiring.js"; // a variable, so the build doesn't require the file to exist yet

async function loadWiring(): Promise<AgentWiring | undefined> {
  try {
    return (await import(WIRING)) as AgentWiring;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "ERR_MODULE_NOT_FOUND" && /wiring/.test(err.message ?? "")) return undefined;
    throw e;
  }
}

export const commands: Command[] = [
  {
    name: "ask",
    usage: 'ask <tenant> "<question>" [--model haiku] [--session <id>] [--json]',
    summary: "Ask the agent company a question and watch every agent's steps",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: { model: { type: "string" }, session: { type: "string" }, json: { type: "boolean" } },
      });
      const [tenant, ...words] = positionals;
      const question = words.join(" ").trim();
      if (!tenant || !question) {
        console.error('Usage: npm run cli -- ask <tenant> "<question>" [--model haiku] [--session <id>] [--json]');
        return 2;
      }
      const wiring = await loadWiring();
      if (!wiring?.createAskDeps) {
        console.error("The agent wiring (src/agent/wiring.ts, exporting createAskDeps) isn't in this build yet. It lands with the graph tools.");
        return 1;
      }
      const deps = await wiring.createAskDeps({ tenant, ...(values.model ? { model: values.model } : {}) });
      const emit = values.json ? (e: unknown) => { process.stdout.write(`${JSON.stringify(e)}\n`); } : workLog();
      const stop = interruptible();
      try {
        const r = await ask({ tenant, question, channel: "cli", ...(values.session ? { sessionId: values.session } : {}) }, { ...deps, signal: stop.signal }, emit);
        if (!values.json) console.log(`\nContinue this thread: npm run cli -- ask ${tenant} "<follow-up>" --session ${r.sessionId}`);
        return r.ok ? 0 : 1;
      } finally {
        stop.dispose();
      }
    },
  },
  {
    name: "replay",
    usage: "replay <tenant> <turnId> [--json]",
    summary: "Print a stored turn's work log, as it streamed",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
      const [tenant, turnId] = positionals;
      if (!tenant || !turnId) { console.error("Usage: npm run cli -- replay <tenant> <turnId>"); return 2; }
      const events = await getTurnEvents(await openGraph(tenant), turnId);
      if (!events) { console.error(`No stored events for ${turnId} in ${tenant}.`); return 1; }
      const emit = values.json ? (e: unknown) => { process.stdout.write(`${JSON.stringify(e)}\n`); } : workLog();
      for (const e of events) emit(e);
      return 0;
    },
  },
  {
    name: "threads",
    usage: "threads <tenant> [--limit 20]",
    summary: "List a tenant's threads, newest first",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { limit: { type: "string" } } });
      const [tenant] = positionals;
      if (!tenant) { console.error("Usage: npm run cli -- threads <tenant>"); return 2; }
      const rows = await listSessions(await openGraph(tenant), { limit: Number(values.limit ?? 20) || 20 });
      if (!rows.length) { console.log("No threads yet."); return 0; }
      for (const s of rows) console.log(`${s.id}  ${formatIst(s.lastAt)}  ${String(s.turnCount).padStart(3)} turn(s)  ${s.channel.padEnd(7)}  ${s.title}`);
      return 0;
    },
  },
];

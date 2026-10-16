// The one place every surface (CLI, server, Discord, MCP) builds ask()'s deps, so they all run the same company:
// - runtime: ClaudeAgentSdkRuntime on the founder's Claude subscription. Its onInit runs assertSubscription on each run's
//   SDK init message, so a run whose calls could be billed to an API key stops before its first model call (fail closed).
// - getTools: the graph tools by name (tools/index.ts). The orchestrator cuts each agent's set down to its roster.
// - graph: the tenant's graph (allevia_<tenant>), which must already exist: asking must not create a tenant by accident.
// - embedQuery: the local e5-small model when its files are in MODELS_DIR. Without them there is no embedder and search
//   runs on full-text alone (nothing is downloaded). If the model fails to load, vector search is off for the process.
// - skills: the shipped skill packs (skills/), each agent's way of working; ALLEVIA_SKILLS=off turns them off. ask() lays
//   the business's own skills and skill rules over them each turn.
// - seedSearch: the search tool itself, read-only, so recall starts from the hits an agent would see first.
// Stopping: ask() hands deps.signal to every agent run, invokeTool gives the run's signal to each tool as ctx.signal,
// and the write tools (remember, propose_action) refuse once it is aborted. Graph algorithms run under the tools' own
// TOOL_ALGO_TIMEOUT_MS (tools/common.ts), passed to the graph core as `timeoutMs`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { graphName, listGraphs, openGraph, type GraphHandle } from "../graph/client.js";
import type { AgentWiring, AskDeps } from "./ask.js";
import { ClaudeAgentSdkRuntime, type AgentRuntime, type SdkRuntimeOpts } from "./runtime.js";
import { codeCatalog, skillsEnabled } from "./skills/catalog.js";
import { assertSubscription } from "./sdk-env.js";
import { TouchedSet, type ToolContext } from "./tool.js";
import { toolsByName } from "./tools/index.js";
import { loadConfig } from "../config.js";
import type { CreativeDeps } from "../creative/ports.js";
import type { PublicDataPort } from "../publicdata/service.js";
import { search } from "./tools/search.js";

export const SEED_LIMIT = 8;
// The files the q8 e5-small pipeline reads (embed.ts loads it with dtype "q8" from MODELS_DIR).
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", join("onnx", "model_quantized.onnx")];

type EmbedQuery = NonNullable<ToolContext["embedQuery"]>;

// Overrides for tests and special surfaces. `embedQuery: null` turns vector search off.
export interface WiringOverrides {
  runtime?: AgentRuntime;
  sdk?: SdkRuntimeOpts["sdk"]; // the Agent SDK module for the default runtime (tests inject a fake); the guard still applies
  graph?: GraphHandle;
  embedQuery?: EmbedQuery | null;
  modelsDir?: string;
  creative?: CreativeDeps | null;  // the creating tools' deps; null: creating is off (the tools say so)
  publicData?: PublicDataPort | null; // public-data lookups; null: off (default: from config, off without APIFY_TOKEN)
}

export function embedModelReady(dir: string, model: string): boolean {
  return MODEL_FILES.every((f) => existsSync(join(dir, model, f)));
}

// The local embedder, or undefined when its files are missing. The model module (and onnxruntime) loads on first use.
// One failure turns it off for the process: every later call fails at once instead of loading the model again.
export async function localEmbedder(modelsDir?: string): Promise<EmbedQuery | undefined> {
  const { EMBED_MODEL, MODELS_DIR } = await import("../ingest/embed.js");
  if (!embedModelReady(modelsDir ?? MODELS_DIR, EMBED_MODEL)) return undefined;
  let broken: Error | undefined;
  return async (text) => {
    if (broken) throw broken;
    try {
      return await (await import("../ingest/embed.js")).embedQuery(text);
    } catch (e) {
      broken = new Error(`local embedder unavailable: ${e instanceof Error ? e.message : String(e)}`);
      throw broken;
    }
  };
}

// Entity ids the question is about: the search tool's hits, in rank order.
export function searchSeeds(graph: GraphHandle, tenant: string, embedQuery?: EmbedQuery): (question: string) => Promise<string[]> {
  const shape = z.object(search.input);
  return async (question) => {
    const ctx: ToolContext = {
      graph, tenant, turnId: "seed", agentId: "chief-of-staff", asker: "person:founder", touched: new TouchedSet(),
      now: Date.now(), readOnly: true, ...(embedQuery ? { embedQuery } : {}),
    };
    const r = await search.run(shape.parse({ query: question, limit: SEED_LIMIT }), ctx);
    const hits = (r.data as { hits?: Array<{ id?: unknown }> } | null)?.hits ?? [];
    return hits.map((h) => h.id).filter((id): id is string => typeof id === "string");
  };
}

// The tenant's graph, which must already exist (asking or serving must not create a tenant by accident).
export async function tenantGraph(tenant: string): Promise<GraphHandle> {
  const name = graphName(tenant); // validates the slug
  if (!(await listGraphs()).includes(name)) throw new Error(`No graph for tenant "${tenant}" (${name}). Ingest or seed it first.`);
  return openGraph(tenant);
}

export async function createAskDeps(opts: { tenant: string; model?: string }, over: WiringOverrides = {}): Promise<AskDeps> {
  const graph = over.graph ?? await tenantGraph(opts.tenant);
  const embedQuery = over.embedQuery === null ? undefined : over.embedQuery ?? await localEmbedder(over.modelsDir);
  // The tools that make things: files per business under the data dir, vision on the subscription, the capped image engine.
  const creative = over.creative === null ? undefined : over.creative ?? (await import("../creative/wiring.js")).productionCreativeDeps(loadConfig().dataDir, { tenant: opts.tenant });
  // Public data (Apify): always present so the tools can say plainly when it is off; it runs only with APIFY_TOKEN set.
  const publicData = over.publicData === null ? undefined : over.publicData ?? (await import("../publicdata/service.js")).productionPublicData(loadConfig(), { log: (l) => console.error(l) });
  const runtime = over.runtime
    ?? new ClaudeAgentSdkRuntime({ onInit: (init) => { assertSubscription(init); }, ...(over.sdk ? { sdk: over.sdk } : {}) });
  return {
    runtime,
    getTools: toolsByName,
    graph,
    seedSearch: searchSeeds(graph, opts.tenant, embedQuery),
    ...(creative ? { creative } : {}),
    ...(publicData ? { publicData } : {}),
    ...(embedQuery ? { embedQuery } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    // The shipped skill packs, unless ALLEVIA_SKILLS=off (how the quality trials run the team without them).
    ...(skillsEnabled() ? { skills: codeCatalog() } : {}),
  };
}

export const wiring = { createAskDeps } satisfies AgentWiring;

// The owner's settings for the AI team, as graph data (product design §2.4):
// - Agent props enabled, mode (full | light | off) and autonomy (0-3), all TRACKED, so every change keeps the old state
//   as a Version; statusNote ("till the new site launches") untracked. A switched-off desk has enabled false and mode
//   'off' (the two are kept in step). The Chief of Staff can't be switched off: it plans and answers every request.
// - Standing instructions: Memory{kind:'instruction', status:'active'} -ABOUT-> Agent (and -ABOUT-> Channel when scoped
//   to one; channel/channelName props say which even if the Channel node doesn't exist yet). A closed ABOUT edge, a
//   status other than active, or a newer Memory that SUPERSEDES it takes it out.
// loadTeamSettings is what a turn reads (ask.ts); listAgentsWithSettings and setAgentSettings serve the API
// (GET /api/:t/agents, PATCH /api/:t/agents/:id). Graph reads and writes only: the parser lives in directives.ts.
import { AGENTS, agentById } from "../../shared/roster.js";
import type { AgentMode, AgentSettings } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode, type Prim } from "../graph/upsert.js";
import { agentNodeId, ensureRoster } from "../agent/memory.js";
import type { InstructionNote, TeamSettings } from "../agent/types.js";

export const CHIEF = "chief-of-staff";
export const AGENT_DEFAULTS = { enabled: true, mode: "full" as AgentMode, autonomy: 0 };
export const AGENT_MODES: readonly AgentMode[] = ["full", "light", "off"];

const rosterIdOf = (nodeId: string): string => nodeId.replace(/^agent:allevia-/, "");
const isMode = (v: unknown): v is AgentMode => typeof v === "string" && (AGENT_MODES as readonly string[]).includes(v);

interface InstructionRow { agent: string; id: string; text: string | null; at: number | null; channel: string | null; channelName: string | null; ch?: { id: string; name: string } }

// Active instruction Memories about the roster's agents, oldest first. Three plain reads joined here: FalkorDB has
// crashed on OPTIONAL MATCH + collect after a WITH … WHERE aggregation, so this keeps to simple patterns.
async function readInstructions(g: GraphHandle): Promise<InstructionRow[]> {
  const rows = await g.roQuery<InstructionRow>(
    `MATCH (a:Entity:Agent) WHERE a.id IN $ids WITH a
     MATCH (m:Memory)-[r:ABOUT]->(a)
     WHERE r.until IS NULL AND m.kind = 'instruction' AND coalesce(m.status, 'active') = 'active'
     RETURN a.id AS agent, m.id AS id, coalesce(m.text, m.summary, m.name) AS text, m.at AS at, m.channel AS channel, m.channelName AS channelName`,
    { ids: AGENTS.map((a) => agentNodeId(a.id)) });
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.id))];
  const [superseded, channels] = await Promise.all([
    g.roQuery<{ id: string }>("UNWIND $ids AS id MATCH (:Memory)-[s:SUPERSEDES]->(m:Entity:Memory {id:id}) WHERE s.until IS NULL RETURN DISTINCT m.id AS id", { ids }),
    g.roQuery<{ id: string; ch: string; name: string | null }>(
      "UNWIND $ids AS id MATCH (m:Entity:Memory {id:id})-[r:ABOUT]->(c:Channel) WHERE r.until IS NULL RETURN m.id AS id, c.id AS ch, c.name AS name ORDER BY ch", { ids }),
  ]);
  const gone = new Set(superseded.map((s) => s.id));
  const chOf = new Map<string, { id: string; name: string }>();
  for (const c of channels) if (!chOf.has(c.id)) chOf.set(c.id, { id: c.ch, name: c.name || c.ch });
  return rows.filter((r) => !gone.has(r.id)).map((r) => ({ ...r, ...(chOf.has(r.id) ? { ch: chOf.get(r.id)! } : {}) }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id));
}

const channelOf = (r: InstructionRow): { id: string; name: string } | undefined => {
  if (r.ch) return r.ch;
  if (r.channel) return { id: r.channel, name: r.channelName || r.channel.replace(/^channel:/, "") };
  return undefined;
};

// Every roster agent with its settings (defaults where none are stored) and its active instructions.
export async function listAgentsWithSettings(g: GraphHandle): Promise<AgentSettings[]> {
  const [rows, notes] = await Promise.all([
    g.roQuery<{ id: string; enabled: boolean | null; mode: string | null; autonomy: number | null; note: string | null; skillsOff: string[] | null }>(
      "UNWIND $ids AS id MATCH (a:Entity:Agent {id:id}) RETURN a.id AS id, a.enabled AS enabled, a.mode AS mode, a.autonomy AS autonomy, a.statusNote AS note, a.skillsOff AS skillsOff",
      { ids: AGENTS.map((a) => agentNodeId(a.id)) }),
    readInstructions(g),
  ]);
  const byId = new Map(rows.map((r) => [rosterIdOf(r.id), r]));
  return AGENTS.map((a) => {
    const r = byId.get(a.id);
    const mode = isMode(r?.mode) ? r.mode : r?.enabled === false ? "off" : AGENT_DEFAULTS.mode;
    const enabled = a.id === CHIEF || (r?.enabled !== false && mode !== "off");
    return {
      id: a.id, nodeId: agentNodeId(a.id), name: a.name, title: a.title, department: a.department,
      enabled, mode: enabled && mode === "off" ? "full" : mode,
      autonomy: typeof r?.autonomy === "number" ? r.autonomy : AGENT_DEFAULTS.autonomy,
      ...(r?.note ? { statusNote: r.note } : {}),
      ...(Array.isArray(r?.skillsOff) && r.skillsOff.length ? { skillsOff: r.skillsOff.filter((x): x is string => typeof x === "string") } : {}),
      instructions: notes.filter((n) => rosterIdOf(n.agent) === a.id && n.text).map((n) => {
        const ch = channelOf(n);
        return { id: n.id, text: n.text!, ...(ch ? { channel: ch.name } : {}), ...(typeof n.at === "number" ? { at: n.at } : {}) };
      }),
    };
  });
}

// What a turn needs: desks off or light, and each standing instruction with every agent it is about.
export async function loadTeamSettings(g: GraphHandle): Promise<TeamSettings> {
  const [agents, notes] = await Promise.all([listAgentsWithSettings(g), readInstructions(g)]);
  const instructions = new Map<string, InstructionNote>();
  for (const n of notes) {
    if (!n.text) continue;
    const agent = rosterIdOf(n.agent);
    const cur = instructions.get(n.id);
    if (cur) { if (!cur.agents.includes(agent)) cur.agents.push(agent); continue; }
    const ch = channelOf(n);
    instructions.set(n.id, { id: n.id, text: n.text, agents: [agent], ...(ch ? { channel: ch } : {}) });
  }
  return {
    disabled: agents.filter((a) => !a.enabled && a.id !== CHIEF).map((a) => a.id),
    light: agents.filter((a) => a.enabled && a.mode === "light").map((a) => a.id),
    ...(agents.some((a) => a.skillsOff?.length) ? { skillsOff: Object.fromEntries(agents.filter((a) => a.skillsOff?.length).map((a) => [a.id, a.skillsOff!])) } : {}),
    instructions: [...instructions.values()],
  };
}

export interface AgentChange { enabled?: boolean; mode?: AgentMode; autonomy?: number; statusNote?: string | null; skillsOff?: string[] }

// Why a change can't be made, or undefined.
export function agentChangeRefusal(agentId: string, c: AgentChange): string | undefined {
  const a = agentById(agentId);
  if (!a) return `There is no agent "${agentId}" on the team.`;
  if (agentId === CHIEF && (c.enabled === false || c.mode === "off")) return `${a.name} can't be switched off: the Chief of Staff plans every request and writes every answer.`;
  if (c.mode !== undefined && !isMode(c.mode)) return `Mode must be one of ${AGENT_MODES.join(", ")}.`;
  if (c.autonomy !== undefined && !(Number.isInteger(c.autonomy) && c.autonomy >= 0 && c.autonomy <= 3)) return "Autonomy must be a whole number from 0 to 3.";
  return undefined;
}

// Switch a desk on or off, set its mode or autonomy. The first change to an agent writes the defaults first, so the
// change itself is a change of state and the old one is kept as a Version. `src` names what asked for it (a directive).
export async function setAgentSettings(g: GraphHandle, agentId: string, change: AgentChange, opts: { now?: number; src?: string } = {}): Promise<AgentSettings> {
  const why = agentChangeRefusal(agentId, change);
  if (why) throw new Error(why);
  const a = agentById(agentId)!;
  const now = opts.now ?? Date.now();
  const id = agentNodeId(agentId);
  let [row] = await g.roQuery<{ enabled: boolean | null; mode: string | null; autonomy: number | null }>(
    "MATCH (a:Entity:Agent {id:$id}) RETURN a.enabled AS enabled, a.mode AS mode, a.autonomy AS autonomy", { id });
  if (!row) {
    await ensureRoster(g, {}, now);
    row = { enabled: null, mode: null, autonomy: null };
  }
  const base: Record<string, Prim> = {};
  if (typeof row.enabled !== "boolean") base.enabled = AGENT_DEFAULTS.enabled;
  if (!isMode(row.mode)) base.mode = row.enabled === false ? "off" : AGENT_DEFAULTS.mode;
  if (typeof row.autonomy !== "number") base.autonomy = AGENT_DEFAULTS.autonomy;
  if (Object.keys(base).length) await upsertNode(g, { type: "Agent", id, name: a.name, props: base }, now);

  let enabled = typeof row.enabled === "boolean" ? row.enabled : (base.enabled as boolean);
  let mode = isMode(row.mode) ? row.mode : (base.mode as AgentMode);
  if (change.mode !== undefined) { mode = change.mode; enabled = mode !== "off"; }
  if (change.enabled !== undefined) {
    enabled = change.enabled;
    if (!enabled) mode = "off";
    else if (mode === "off") mode = "full";
  }
  const props: Record<string, Prim> = { enabled, mode };
  if (change.autonomy !== undefined) props.autonomy = change.autonomy;
  if (change.skillsOff !== undefined) props.skillsOff = [...new Set(change.skillsOff)];
  if (change.statusNote !== undefined) props.statusNote = change.statusNote;
  else if (change.enabled === true || (change.mode !== undefined && change.mode !== "off")) props.statusNote = null; // back on: the "till …" no longer holds
  await upsertNode(g, { type: "Agent", id, name: a.name, props, ...(opts.src ? { src: opts.src } : {}) }, now);
  return (await listAgentsWithSettings(g)).find((x) => x.id === agentId)!;
}

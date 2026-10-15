// Toolkits: the agents' tools, organised by domain in ONE place. A toolkit is a named set of tools for one kind of work
// (looking things up, numbers, SEO, content, ops, research, making things, the brand library ...). Each tool is tagged
// with what it is, so anything built on top (per-agent skill packs, the owner's "what can your team do" screen, access
// levels) reads the tag instead of guessing:
//   domain  - the department the tool belongs to
//   mode    - "read" (looks something up), "create" (makes a file or a draft: a poster, an image, a clip, copy) or
//             "write" (changes company memory or raises a card)
//   cost    - "free" (graph reads), "model" (spends the Claude subscription: a model call or a web search),
//             "credits" (spends image-generator credits, always through the capped engine and quoted first)
//   needsOk - whether the owner's OK is needed before the tool's result does anything outside the company: true for
//             everything that creates or proposes (it waits as a card), false for reads
// A roster agent is given toolkits plus a few named extras (shared/roster.ts), not a hard-coded array of names. The Chief
// of Staff holds the toolkits of every domain it may call across. Pure data: no Node or DOM imports (the web app reads it).

export type ToolDomain = "knowledge" | "analytics" | "marketing" | "content" | "tech" | "ops" | "research" | "brand" | "creative" | "memory" | "answer";
export type ToolMode = "read" | "create" | "write";
export type ToolCost = "free" | "model" | "credits";

export interface ToolMeta {
  name: string;
  domain: ToolDomain;
  mode: ToolMode;
  cost: ToolCost;
  needsOk: boolean;
  summary: string;     // one plain line for the owner and for skill packs
}

const read = (name: string, domain: ToolDomain, summary: string): ToolMeta => ({ name, domain, mode: "read", cost: "free", needsOk: false, summary });

export const TOOL_META: ToolMeta[] = [
  // knowledge: the company's memory
  read("search", "knowledge", "Finds things across everything the team knows"),
  read("get_entity", "knowledge", "Opens one thing and what is known about it"),
  read("neighbors", "knowledge", "Shows what is connected to something"),
  read("find_paths", "knowledge", "Traces how two things connect"),
  read("trace_decision", "knowledge", "Explains why something was decided"),
  read("who_knows", "knowledge", "Finds who knows about a topic"),
  read("topics", "knowledge", "Maps the topics the business talks about"),
  read("important", "knowledge", "Ranks what matters most"),
  read("history", "knowledge", "Reads how something changed over time"),
  read("cypher", "knowledge", "Runs a read-only question over the records"),
  { name: "recall", domain: "memory", mode: "read", cost: "free", needsOk: false, summary: "Recalls what the owner already told the team" },
  { name: "remember", domain: "memory", mode: "write", cost: "free", needsOk: false, summary: "Saves something the owner asked the team to remember" },
  // skills: every agent can open its own skill packs (handed out by the orchestrator, not a toolkit)
  { name: "use_skill", domain: "knowledge", mode: "read", cost: "free", needsOk: false, summary: "Opens one of the agent's skills (how this kind of work is done here)" },
  { name: "show_path", domain: "answer", mode: "read", cost: "free", needsOk: false, summary: "Draws how the answer was reached" },
  { name: "propose_action", domain: "answer", mode: "write", cost: "free", needsOk: true, summary: "Asks the owner for an OK on a change (an issue, a draft, a paused ad)" },
  // analytics
  read("metric_trend", "analytics", "Reads how a number has moved"),
  read("seo_report", "analytics", "Reads the website's search health"),
  read("content_performance", "analytics", "Compares which posts and hooks worked"),
  // marketing
  read("ad_report", "marketing", "Reads ad results (sample numbers when simulated)"),
  read("playbook", "content", "Reads the rules for writing and posting in this voice"),
  // tech and ops
  read("impact_of", "tech", "Shows what depends on something"),
  read("who_owns", "ops", "Finds who owns something and what is waiting"),
  // research
  { name: "research", domain: "research", mode: "read", cost: "model", needsOk: false, summary: "Looks something up on the web and cites where it found it" },
  // the brand library
  read("get_brand_asset", "brand", "Finds the business's logo, colours, fonts, guide and pictures"),
  // making things
  { name: "write_copy", domain: "content", mode: "create", cost: "model", needsOk: true, summary: "Writes captions, ad lines or emails in the brand's voice" },
  { name: "make_poster", domain: "creative", mode: "create", cost: "credits", needsOk: true, summary: "Makes a poster or ad with the real logo and exact words" },
  { name: "generate_image", domain: "creative", mode: "create", cost: "credits", needsOk: true, summary: "Makes a picture from a description" },
  { name: "make_reel_script_and_clip", domain: "creative", mode: "create", cost: "credits", needsOk: true, summary: "Writes a reel script and, when priced and agreed, a 5-second clip" },
];

// Toolkits: a name, the domain it serves, the tools in it.
export interface Toolkit { id: string; label: string; domain: ToolDomain; tools: string[] }

export const TOOLKITS: Toolkit[] = [
  { id: "lookup", label: "Look things up", domain: "knowledge", tools: ["search", "get_entity"] },
  { id: "explore", label: "Follow connections", domain: "knowledge", tools: ["neighbors", "find_paths"] },
  { id: "sql", label: "Ask the records directly", domain: "knowledge", tools: ["cypher"] },
  { id: "library", label: "Library: decisions, who knows, topics", domain: "knowledge", tools: ["trace_decision", "who_knows", "topics", "important"] },
  { id: "history", label: "How things changed", domain: "knowledge", tools: ["history"] },
  { id: "memory", label: "What the owner told the team", domain: "memory", tools: ["recall", "remember"] },
  { id: "answer", label: "Show how we got this", domain: "answer", tools: ["show_path"] },
  { id: "proposals", label: "Ask for an OK", domain: "answer", tools: ["propose_action"] },
  { id: "numbers", label: "Numbers over time", domain: "analytics", tools: ["metric_trend"] },
  { id: "seo", label: "Search health", domain: "analytics", tools: ["seo_report"] },
  { id: "content-stats", label: "What content worked", domain: "analytics", tools: ["content_performance"] },
  { id: "ads", label: "Ad results", domain: "marketing", tools: ["ad_report"] },
  { id: "playbooks", label: "Voice and posting rules", domain: "content", tools: ["playbook"] },
  { id: "tech", label: "What depends on what", domain: "tech", tools: ["impact_of"] },
  { id: "ops", label: "Who owns what", domain: "ops", tools: ["who_owns"] },
  { id: "research", label: "Web research", domain: "research", tools: ["research"] },
  { id: "brand", label: "The brand library", domain: "brand", tools: ["get_brand_asset"] },
  { id: "copywriting", label: "Write copy", domain: "content", tools: ["write_copy"] },
  { id: "creative", label: "Make posters, images and clips", domain: "creative", tools: ["make_poster", "generate_image", "make_reel_script_and_clip"] },
];

const BY_TOOLKIT = new Map(TOOLKITS.map((t) => [t.id, t]));
const BY_TOOL = new Map(TOOL_META.map((t) => [t.name, t]));

export const toolMeta = (name: string): ToolMeta | undefined => BY_TOOL.get(name);
export const toolkitById = (id: string): Toolkit | undefined => BY_TOOLKIT.get(id);

// The tool names an agent holds: its toolkits' tools, then its named extras, each once, in that order.
export function toolsOf(toolkits: readonly string[], extras: readonly string[] = []): string[] {
  const unknown = toolkits.filter((k) => !BY_TOOLKIT.has(k));
  if (unknown.length) throw new Error(`unknown toolkit${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  const names = [...toolkits.flatMap((k) => BY_TOOLKIT.get(k)!.tools), ...extras];
  const missing = names.filter((n) => !BY_TOOL.has(n));
  if (missing.length) throw new Error(`tool${missing.length > 1 ? "s" : ""} with no tag: ${[...new Set(missing)].join(", ")}`);
  return [...new Set(names)];
}

// Which toolkits contain a tool (a tool may sit in one: the registry test holds every tool to exactly one or an extra).
export const toolkitsWith = (tool: string): string[] => TOOLKITS.filter((t) => t.tools.includes(tool)).map((t) => t.id);

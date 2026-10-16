// Toolkits: the agents' tools, organised by domain in ONE place. A toolkit is a named set of tools for one kind of work
// (looking things up, numbers, SEO, content, ops, research, making things, the brand library ...). Each tool is tagged
// with what it is, so anything built on top (per-agent skill packs, the owner's "what can your team do" screen, access
// levels) reads the tag instead of guessing:
//   domain  - the department the tool belongs to
//   mode    - "read" (looks something up), "create" (makes a file or a draft: a poster, an image, a clip, copy) or
//             "write" (changes company memory or raises a card)
//   cost    - "free" (graph reads), "model" (spends the Claude subscription: a model call or a web search),
//             "credits" (spends image-generator credits, always through the capped engine and quoted first),
//             "paid" (spends money at a data provider: an Apify public-data lookup or DataForSEO keywords; estimated first,
//             from a budget per business per month)
//   needsOk - whether the owner's OK is needed before the tool's result does anything outside the company: true for
//             everything that creates or proposes (it waits as a card), false for reads
// A roster agent is given toolkits plus a few named extras (shared/roster.ts), not a hard-coded array of names. The Chief
// of Staff holds the toolkits of every domain it may call across. Pure data: no Node or DOM imports (the web app reads it).

export type ToolDomain = "knowledge" | "analytics" | "marketing" | "content" | "tech" | "ops" | "research" | "brand" | "creative" | "memory" | "answer" | "sales";
export type ToolMode = "read" | "create" | "write";
export type ToolCost = "free" | "model" | "credits" | "paid";

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
  read("website_checkup", "tech", "Says what to fix on the website first, ranked by enquiries"),
  read("ai_visibility", "analytics", "Says whether AI assistants name the business when customers ask"),
  { name: "keyword_ideas", domain: "analytics", mode: "write", cost: "paid", needsOk: false, summary: "Finds searches the business could rank for (optional, paid, within a monthly budget)" },
  // marketing
  read("ad_report", "marketing", "Reads ad results (sample numbers when simulated)"),
  read("playbook", "content", "Reads the rules for writing and posting in this voice"),
  // tech and ops
  read("impact_of", "tech", "Shows what depends on something"),
  read("who_owns", "ops", "Finds who owns something and what is waiting"),
  // research
  { name: "research", domain: "research", mode: "read", cost: "model", needsOk: false, summary: "Looks something up on the web and cites where it found it" },
  // public data (Apify): paid lookups that save public numbers to the records (write), inside a monthly budget; nothing
  // goes out and nothing is posted, so no OK is needed
  { name: "google_listing", domain: "research", mode: "write", cost: "paid", needsOk: false, summary: "Reads a Google Maps listing: address, hours, rating and recent reviews" },
  { name: "instagram_public", domain: "research", mode: "write", cost: "paid", needsOk: false, summary: "Reads the public numbers of an Instagram profile: followers, posting rate, likes and top posts" },
  { name: "competitor_watch", domain: "research", mode: "write", cost: "paid", needsOk: false, summary: "Checks competitors' public Instagram numbers and the ads they run, and keeps each reading" },
  { name: "ad_library", domain: "research", mode: "write", cost: "paid", needsOk: false, summary: "Reads the public ad libraries (Meta and Google) for a brand or website" },
  // the brand library
  read("get_brand_asset", "brand", "Finds the business's logo, colours, fonts, guide and pictures"),
  // the business's connected tools (src/connections): reads run now; anything that sends, books, posts or changes waits for the OK
  read("calendar_free_slots", "ops", "Finds free times on the owner's calendar"),
  { name: "calendar_book", domain: "ops", mode: "write", cost: "free", needsOk: true, summary: "Proposes a meeting on the owner's calendar for their OK" },
  { name: "gmail_draft", domain: "ops", mode: "write", cost: "free", needsOk: true, summary: "Writes an email for the owner to read and approve; nothing is sent" },
  { name: "gmail_send", domain: "ops", mode: "write", cost: "free", needsOk: true, summary: "Proposes sending an email from the owner's Gmail for their OK" },
  read("gmail_inbox", "ops", "Looks through the inbox, if the owner allowed it"),
  read("ga4_report", "analytics", "Reads website visits and where they come from, live"),
  read("gsc_report", "analytics", "Reads the searches and pages that bring people, live"),
  read("ads_report", "marketing", "Reads Google Ads spend and results, live"),
  read("connections_available", "ops", "Lists the connected tools and what each can do"),
  read("connection_tools", "ops", "Lists the actions a connected tool offers"),
  read("connection_read", "ops", "Looks something up in a connected tool"),
  { name: "connection_act", domain: "ops", mode: "write", cost: "free", needsOk: true, summary: "Proposes a change in a connected tool for the owner's OK" },
  // sales: the business's own leads, deals and meetings in the records (src/sales); anything that goes out to a customer
  // (an email, an invite) is sent with gmail_send or calendar_book, which wait for the owner's OK
  read("enquiries_read", "sales", "Finds new enquiries nobody has answered yet, in the records and in the inbox"),
  read("crm_read", "sales", "Reads the leads, deals and meetings: the pipeline, what moved, what is stuck"),
  { name: "crm_write", domain: "sales", mode: "write", cost: "free", needsOk: false, summary: "Adds a lead, opens a deal, moves a stage or adds a follow-up in the records" },
  // posting to the owner's own channels (src/publish): the card waits for the owner's OK and posts exactly what they approved
  { name: "publish_post", domain: "content", mode: "write", cost: "free", needsOk: true, summary: "Proposes posting to the owner's Instagram, Facebook Page or LinkedIn, now or at a time, for their OK" },
  read("publish_status", "content", "Lists what is scheduled and what posted lately"),
  { name: "publish_cancel", domain: "content", mode: "write", cost: "free", needsOk: false, summary: "Cancels a scheduled post that has not gone out" },
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
  { id: "website", label: "Website check-up and AI visibility", domain: "tech", tools: ["website_checkup", "ai_visibility"] },
  { id: "keywords", label: "Keyword research (optional, paid)", domain: "analytics", tools: ["keyword_ideas"] },
  { id: "sales", label: "Sales: enquiries, leads and deals", domain: "sales", tools: ["enquiries_read", "crm_read", "crm_write"] },
  { id: "calendar", label: "Calendar: free times and meetings", domain: "ops", tools: ["calendar_free_slots", "calendar_book"] },
  { id: "inbox", label: "Email: drafts, sends and the inbox", domain: "ops", tools: ["gmail_draft", "gmail_send", "gmail_inbox"] },
  { id: "live-analytics", label: "Live website and search numbers", domain: "analytics", tools: ["ga4_report", "gsc_report"] },
  { id: "live-ads", label: "Live ad results", domain: "marketing", tools: ["ads_report"] },
  { id: "connections", label: "The business's connected tools", domain: "ops", tools: ["connections_available", "connection_tools", "connection_read", "connection_act"] },
  { id: "ads", label: "Ad results", domain: "marketing", tools: ["ad_report"] },
  { id: "playbooks", label: "Voice and posting rules", domain: "content", tools: ["playbook"] },
  { id: "tech", label: "What depends on what", domain: "tech", tools: ["impact_of"] },
  { id: "ops", label: "Who owns what", domain: "ops", tools: ["who_owns"] },
  { id: "research", label: "Web research", domain: "research", tools: ["research"] },
  { id: "public-profiles", label: "Public listings and profiles", domain: "research", tools: ["google_listing", "instagram_public"] },
  { id: "competitors", label: "Competitors and their ads", domain: "research", tools: ["competitor_watch", "ad_library"] },
  { id: "brand", label: "The brand library", domain: "brand", tools: ["get_brand_asset"] },
  { id: "copywriting", label: "Write copy", domain: "content", tools: ["write_copy"] },
  { id: "posting", label: "Post to your own accounts, after your OK", domain: "content", tools: ["publish_post", "publish_status", "publish_cancel"] },
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

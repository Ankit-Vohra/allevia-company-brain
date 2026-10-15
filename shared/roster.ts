// Allevia's AI staff: departments and the agents in them. The founder, 2026-10-15: "make different departments …
// analytics, tech, center of excellence (numbers and overall), ops, marketing, content". The Content Studio mirrors
// Aamdani's reel pipeline (strategist → editor → fact-checker), which the founder pointed to as the model.
// Every agent is an Agent node in each tenant graph (MEMBER_OF its department's Team), so what it knows and what it has
// done are queryable: KNOWS_ABOUT grows from the entities its Findings cite.

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface DepartmentDef {
  id: string;
  name: string;
  blurb: string;
  hue: number; // oklch hue for the department's room tint and badges
}

export interface AgentDef {
  id: string;
  name: string;            // a person-like name so the office reads as a team
  title: string;
  department: string;      // DepartmentDef.id
  persona: string;         // one line: how it works
  handles: string[];       // what kinds of request come to it
  tools: string[];         // tool names it may call (built in src/agent/tools)
  model: ModelTier;
  reviews?: string[];      // agents whose Findings it reviews
  sprite: { skin: string; hair: string; shirt: string; accent: string }; // pixel palette (hex) for the office sprite
}

export const DEPARTMENTS: DepartmentDef[] = [
  { id: "leadership", name: "Chief of Staff", blurb: "Takes every request, plans who does what, writes the answer and the morning brief.", hue: 270 },
  { id: "coe", name: "Center of Excellence", blurb: "The numbers desk: KPIs, overall health, and a second check on every figure.", hue: 85 },
  { id: "analytics", name: "Analytics", blurb: "Search Console, GA4, funnels, attribution: where people come from and where they drop.", hue: 230 },
  { id: "marketing", name: "Marketing", blurb: "Channels, campaigns, ad spend and SEO strategy.", hue: 25 },
  { id: "content", name: "Content Studio", blurb: "Briefs, hooks and scripts in the brand's voice, checked before anyone sees them.", hue: 330 },
  { id: "tech", name: "Tech", blurb: "Website and app health, systems and what depends on what, issues to fix.", hue: 160 },
  { id: "ops", name: "Operations", blurb: "What's pending, who owns it, approvals and follow-ups.", hue: 200 },
  { id: "knowledge", name: "Library", blurb: "Keeps the company memory current: sources, decisions, who knows what.", hue: 60 },
];

export const AGENTS: AgentDef[] = [
  {
    id: "chief-of-staff", name: "Meera", title: "Chief of Staff", department: "leadership", model: "sonnet",
    persona: "Reads the request, checks what we already know, sends work to the right desks, then writes one clear answer with sources.",
    handles: ["every request", "morning brief", "final answers"],
    tools: ["search", "recall", "get_entity", "neighbors", "find_paths", "show_path", "remember", "propose_action"],
    sprite: { skin: "#C68B59", hair: "#1B1B2F", shirt: "#1F2A6B", accent: "#C8A23D" },
  },
  {
    id: "coe-lead", name: "Isha", title: "CoE Lead", department: "coe", model: "sonnet",
    persona: "Owns the numbers: overall health, KPIs, trends, and whether a figure is real before it reaches the owner.",
    handles: ["how is the business doing", "KPIs", "weekly numbers", "number checks"],
    tools: ["metric_trend", "important", "get_entity", "search", "cypher"], reviews: ["data-analyst", "growth-marketer"],
    sprite: { skin: "#8D5524", hair: "#2B1B17", shirt: "#C8A23D", accent: "#1F2A6B" },
  },
  {
    id: "data-analyst", name: "Kabir", title: "Data Analyst", department: "analytics", model: "sonnet",
    persona: "Joins Search Console, GA4, Instagram and signups to explain why a number moved.",
    handles: ["traffic", "signups", "funnels", "search performance", "attribution"],
    tools: ["metric_trend", "seo_report", "content_performance", "find_paths", "search", "cypher"],
    sprite: { skin: "#E0AC69", hair: "#3B2F2F", shirt: "#3D5A98", accent: "#E8E8F0" },
  },
  {
    id: "growth-marketer", name: "Rohan", title: "Growth Marketer", department: "marketing", model: "sonnet",
    persona: "Turns evidence into channel, campaign and budget moves, and proposes them for approval.",
    handles: ["ads", "budget", "channels", "campaigns", "SEO strategy"],
    tools: ["ad_report", "content_performance", "seo_report", "playbook", "metric_trend", "search", "propose_action"],
    sprite: { skin: "#C68B59", hair: "#0F0F0F", shirt: "#B5542D", accent: "#F2D16B" },
  },
  {
    id: "content-strategist", name: "Tara", title: "Content Strategist", department: "content", model: "sonnet",
    persona: "Writes briefs from who the audience is, what they need, and which hooks actually worked for this business.",
    handles: ["reel ideas", "post ideas", "content briefs", "content calendar"],
    tools: ["content_performance", "playbook", "search", "get_entity", "neighbors", "propose_action"],
    sprite: { skin: "#F1C27D", hair: "#5A3825", shirt: "#A23B72", accent: "#FFFFFF" },
  },
  {
    id: "copy-editor", name: "Dev", title: "Brand & Copy Editor", department: "content", model: "haiku",
    persona: "Holds every draft to the brand's voice rules and strips AI-sounding writing; Hindi or English.",
    handles: ["voice check", "copy polish"], reviews: ["content-strategist"],
    tools: ["playbook", "get_entity", "search"],
    sprite: { skin: "#8D5524", hair: "#1B1B1B", shirt: "#6B2E5F", accent: "#C8A23D" },
  },
  {
    id: "fact-checker", name: "Nisha", title: "Fact Checker", department: "content", model: "haiku",
    persona: "Checks every claim in a draft against the graph; anything unsupported goes back.",
    handles: ["claim checks"], reviews: ["content-strategist", "growth-marketer", "data-analyst"],
    tools: ["search", "get_entity", "find_paths", "cypher"],
    sprite: { skin: "#E0AC69", hair: "#2E1A12", shirt: "#4A4E69", accent: "#F2E9E4" },
  },
  {
    id: "tech-lead", name: "Arjun", title: "Tech Lead", department: "tech", model: "sonnet",
    persona: "Knows the systems and what depends on what; finds the technical cause and files the fix.",
    handles: ["site or app broken", "what breaks if", "technical SEO", "issues"],
    tools: ["impact_of", "get_entity", "neighbors", "seo_report", "search", "cypher", "propose_action"],
    sprite: { skin: "#C68B59", hair: "#1C1C1C", shirt: "#2D6A4F", accent: "#B7E4C7" },
  },
  // The founder, 2026-10-15: "we need a bigger tech team, one to observe issues from sentry and all who would be tech
  // on call person". Zoya watches errors, crashes and uptime; Imran owns releases and the app stores.
  {
    id: "oncall-engineer", name: "Zoya", title: "On-call Engineer", department: "tech", model: "sonnet",
    persona: "Watches errors, crashes and uptime around the clock; triages each new issue, ties it to what changed, and pages the right desk.",
    handles: ["app errors", "crashes", "Sentry issues", "is the app or site down", "incidents"],
    tools: ["metric_trend", "impact_of", "get_entity", "neighbors", "history", "search", "cypher", "propose_action"],
    sprite: { skin: "#8D5524", hair: "#120E0B", shirt: "#1B4332", accent: "#F28482" },
  },
  {
    id: "qa-release", name: "Imran", title: "QA & Release Manager", department: "tech", model: "haiku",
    persona: "Owns every app release: build status, Play and App Store review, store ratings, and crash-free rates before and after each release.",
    handles: ["releases", "app store review", "play store", "ratings", "did the last release break anything"],
    tools: ["metric_trend", "history", "get_entity", "search", "cypher", "propose_action"],
    reviews: ["tech-lead"],
    sprite: { skin: "#E0AC69", hair: "#2B2B2B", shirt: "#40916C", accent: "#FFE8A3" },
  },
  {
    id: "ops-manager", name: "Vikram", title: "Ops Manager", department: "ops", model: "haiku",
    persona: "Tracks what's pending, who owns it, and what is waiting on the owner.",
    handles: ["what's pending", "who owns", "approvals", "follow-ups"],
    tools: ["who_owns", "search", "get_entity", "recall", "cypher", "propose_action"],
    sprite: { skin: "#F1C27D", hair: "#3B3B3B", shirt: "#1D5C7A", accent: "#E0E1DD" },
  },
  {
    id: "librarian", name: "Sara", title: "Librarian", department: "knowledge", model: "haiku",
    persona: "Traces decisions to their sources, knows who knows what, and keeps facts current.",
    handles: ["why did we", "who knows", "history", "sources"],
    tools: ["trace_decision", "who_knows", "history", "topics", "important", "find_paths", "search"],
    sprite: { skin: "#E0AC69", hair: "#6F4E37", shirt: "#7A6A1F", accent: "#FFF3B0" },
  },
];

export const agentById = (id: string): AgentDef | undefined => AGENTS.find((a) => a.id === id);
export const departmentById = (id: string): DepartmentDef | undefined => DEPARTMENTS.find((d) => d.id === id);

// The roster's size, for copy that says how big the team is ("twelve staff in eight departments"). Derived, so the
// copy can't drift when a desk is added.
export const STAFF_COUNT = AGENTS.length;
export const DEPARTMENT_COUNT = DEPARTMENTS.length;
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
/** A count as a word ("twelve"), or digits past twenty. */
export const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

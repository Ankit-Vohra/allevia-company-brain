// Plain words for "What your team knows": friendly names for the kinds of things in the company brain, the groups the
// summary shows, how two things relate, and how old something is. Technical words (node, graph, PageRank) never come
// from here; they appear only inside "Show how" expanders.
import { fmtDate, fmtNum } from "../lib/format";
import { hueFor } from "../lib/labels";

/** One kind of thing, as an owner would name it ("Observation" is a Number, "Rule" is a Website check). */
const KIND: Record<string, string> = {
  Business: "Business", Person: "Person", Team: "Team", Agent: "Team member",
  Product: "Product or service", Feature: "Feature", Audience: "Customer group", Need: "Customer need",
  Decision: "Decision", Content: "Post", Campaign: "Campaign", Channel: "Channel",
  Page: "Website page", Query: "Search phrase", Rule: "Website check", Metric: "Measure", Observation: "Number", Goal: "Goal",
  BrandRule: "Brand rule", BrandAsset: "Brand style", Playbook: "Playbook",
  Task: "Task", System: "Tool", Event: "Event", Document: "Document", Memory: "Note", Chunk: "Passage",
  Recommendation: "Idea", Finding: "Something we noticed", Turn: "Conversation", Session: "Conversation",
  Approval: "Waiting for your OK", Action: "Action", Checkpoint: "Check-in", Program: "Growth plan", Capability: "Connection",
  Asset: "Photo or file", Version: "Earlier version", Competitor: "Competitor", Supplier: "Supplier", Partner: "Partner", Client: "Client",
};
export const kindName = (label: string) => KIND[label] ?? label.replace(/([a-z])([A-Z])/g, "$1 $2");

/** "007 · Pause daily posts" → "Pause daily posts": decisions carry a filing number the owner never needs. */
/** "Supabase prod ([redacted:supabase-ref], Mumbai)" → "Supabase prod (Mumbai)": the privacy filter's marker is not for the owner
 *  (the same rule as src/util/plain.ts on the server). */
const unmarked = (s: string) =>
  s.includes("[redacted:")
    ? s.replace(/\(\s*\[redacted:[a-z-]+\]\s*\)/gi, "").replace(/\[redacted:[a-z-]+\]\s*,?\s*/gi, "").replace(/\s{2,}/g, " ").trim()
    : s;
export const tidyName = (label: string, name: string) => unmarked(label === "Decision" ? name.replace(/^\d{2,4}\s*[·:-]\s*/, "") : name);

export interface BrainGroup { id: string; name: string; blurb: string; labels: string[] }

/** The groups the summary shows, in reading order. Anything not listed (conversations, passages…) is bookkeeping and stays out. */
export const BRAIN_GROUPS: BrainGroup[] = [
  { id: "offer", name: "What you sell", blurb: "Products, services and what they include", labels: ["Product", "Feature"] },
  { id: "customers", name: "Customers and what they need", blurb: "Who you serve and what they are looking for", labels: ["Audience", "Need"] },
  { id: "decisions", name: "Decisions", blurb: "What you decided and why", labels: ["Decision"] },
  { id: "content", name: "Posts, campaigns and channels", blurb: "Where you show up and what you put out", labels: ["Content", "Campaign", "Channel"] },
  { id: "pages", name: "Website pages and checks", blurb: "Your pages, what people search for, what to fix", labels: ["Page", "Query", "Rule"] },
  { id: "numbers", name: "Numbers and results", blurb: "What was measured, and when", labels: ["Metric", "Observation", "Goal"] },
  { id: "brand", name: "Your brand and how you work", blurb: "Voice, look and the methods your team follows", labels: ["BrandRule", "BrandAsset", "Playbook"] },
  { id: "people", name: "People and teams", blurb: "Who is who", labels: ["Person", "Team"] },
  { id: "others", name: "Businesses you work with", blurb: "Suppliers, partners, clients and competitors", labels: ["Supplier", "Partner", "Client", "Competitor"] },
  { id: "notes", name: "Documents and notes", blurb: "Files, notes and things worth remembering", labels: ["Document", "Memory"] },
  { id: "tools", name: "Tools, tasks and events", blurb: "Systems you use and what is on the list", labels: ["System", "Task", "Event"] },
];

export const GROUPED_LABELS = new Set(BRAIN_GROUPS.flatMap((g) => g.labels));
/** Kinds that make poor "most important" rows: the business itself, conversations and plumbing. */
export const NOT_HEADLINES = new Set(["Business", "Agent", "Chunk", "Turn", "Session", "Finding", "Version", "Approval", "Action", "Document", "Capability", "Checkpoint", "Program"]);

export const groupHue = (g: BrainGroup) => hueFor(g.labels[0]!);

export const thingsCount = (n: number) => `${fmtNum(n)} ${n === 1 ? "thing" : "things"}`;

/** "today", "yesterday", "3 days ago", else a short date. Works on a calendar-day basis, so 23:00 yesterday is "yesterday". */
export function whenWords(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return fmtDate(iso);
}

/** How two things relate, read from each side. The first phrase reads from the thing that points; the second from the thing pointed at. */
const REL: Record<string, [string, string]> = {
  AFFECTS: ["Affects", "Affected by"], BASED_ON: ["Based on", "Led to"], DECIDED: ["Decided", "Decided by"],
  AUTHORED: ["Wrote", "Written by"], MEASURES: ["Measures", "Measured by"], OWNS: ["Owns", "Owned by"],
  TARGETS: ["Aimed at", "Aimed at by"], SOLVES: ["Helps with", "Helped by"], INCLUDES: ["Includes", "Part of"],
  MEMBER_OF: ["Part of", "Includes"], PART_OF: ["Part of", "Includes"], ABOUT: ["About", "Talked about in"],
  FAILS: ["Needs fixing", "Needs fixing on"], SUPERSEDES: ["Replaces", "Replaced by"], KNOWS_ABOUT: ["Knows about", "Known by"],
  MENTIONS: ["Mentions", "Mentioned in"], SOURCED_FROM: ["Comes from", "Source for"], HAS_NEED: ["Needs", "Needed by"],
  LINKS_TO_PAGE: ["Links to", "Linked from"], APPLIES_TO: ["Applies to", "Covers"], DEPENDS_ON: ["Depends on", "Needed by"],
  BLOCKS: ["Holds up", "Held up by"], TOUCHED: ["Touched", "Touched by"], STATED: ["Said", "Said by"],
};
export function relPhrase(type: string, direction: "out" | "in"): string {
  const hit = REL[type];
  if (hit) return hit[direction === "out" ? 0 : 1];
  const plain = type.toLowerCase().replace(/_/g, " ");
  const cap = plain.replace(/^./, (c) => c.toUpperCase());
  return direction === "out" ? cap : `Linked by (${plain})`;
}

/** decidedAt → "Decided at", lcp → "LCP": sentence case, with the usual acronyms kept. */
const ACRONYMS = new Set(["lcp", "ctr", "cpa", "seo", "url", "h1", "id", "kpi", "ga4"]);
export const humanKey = (k: string) =>
  k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase()
    .split(" ").map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ")
    .replace(/^./, (c) => c.toUpperCase());

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "number") return fmtNum(v, 2);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}/.test(v) ? fmtDate(v) : v;
  return JSON.stringify(v);
}

// Kinds of things and their colours. The Brain map's legend chips are these kinds; every dot in the app (the map, the
// side panel, search, the answer's path) takes its hue from the kind its label belongs to, so a colour means the same
// thing everywhere. Soft hues on two calm bases (warm paper, indigo ink). Gold is never a kind colour: it is reserved
// for the lit answer path and for what the team is reading right now.
export interface MapKind { id: string; name: string; hue: number; chroma: number; labels: string[] }

export const MAP_KINDS: MapKind[] = [
  { id: "sell", name: "What you sell", hue: 148, chroma: 0.1, labels: ["Product", "Feature"] },
  { id: "customers", name: "Customers", hue: 176, chroma: 0.09, labels: ["Audience", "Need", "Client", "Lead", "Deal", "Meeting"] },
  { id: "people", name: "People and teams", hue: 28, chroma: 0.1, labels: ["Business", "Person", "Team", "Agent", "Supplier", "Partner", "Competitor"] },
  { id: "numbers", name: "Numbers", hue: 232, chroma: 0.1, labels: ["Metric", "Observation", "Goal"] },
  { id: "decisions", name: "Decisions and plans", hue: 292, chroma: 0.09, labels: ["Decision", "Recommendation", "Finding", "Task", "Event", "Approval", "Action", "Program", "Checkpoint"] },
  { id: "posts", name: "Posts and channels", hue: 345, chroma: 0.1, labels: ["Content", "Campaign", "Channel", "Asset"] },
  { id: "website", name: "Website", hue: 204, chroma: 0.09, labels: ["Page", "Query", "Rule"] },
  { id: "documents", name: "Documents and notes", hue: 262, chroma: 0.035, labels: ["Document", "Chunk", "Memory", "BrandRule", "BrandAsset", "Playbook", "Version"] },
  { id: "tools", name: "Tools", hue: 118, chroma: 0.09, labels: ["System", "Capability"] },
];
const OTHER_KIND: MapKind = { id: "other", name: "Other", hue: 265, chroma: 0.03, labels: [] };

const KIND_OF = new Map(MAP_KINDS.flatMap((k) => k.labels.map((l) => [l, k] as const)));
/** The kind a label belongs to ("Observation" is a Number, "System" a Tool); anything unlisted is "other". */
export const kindOf = (label: string): MapKind => KIND_OF.get(label) ?? OTHER_KIND;

export const LABEL_HUE: Record<string, number> = Object.fromEntries(
  [...KIND_OF.entries()].map(([l, k]) => [l, k.hue]),
);

export const hueFor = (label: string) => kindOf(label).hue;
/** How strong a kind's colour is: documents and notes stay nearly grey so the business itself stands out. */
export const chromaFor = (label: string) => kindOf(label).chroma;

/** Solid node colour for canvases (works on both themes). */
export const nodeColor = (label: string, dark: boolean) => `oklch(${dark ? 72 : 60}% ${chromaFor(label)} ${hueFor(label)})`;

export const COMMUNITY_HUES = [265, 330, 170, 120, 225, 200, 55, 25];
export const communityColor = (c: number | undefined, dark: boolean) => `oklch(${dark ? 72 : 60}% 0.11 ${COMMUNITY_HUES[(c ?? 0) % COMMUNITY_HUES.length]})`;

/** "decision:007-pause-daily…" → "Decision". */
export const labelOfId = (id: string) => {
  const t = id.split(":")[0] ?? "";
  const map: Record<string, string> = { brandrule: "BrandRule", brandasset: "BrandAsset" };
  return map[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
};

/** A readable short name for an id we have no node for yet. */
export const nameOfId = (id: string) => {
  const rest = id.split(":").slice(1).join(":");
  return rest.replace(/^www\./, "").replace(/-/g, " ").slice(0, 48) || id;
};

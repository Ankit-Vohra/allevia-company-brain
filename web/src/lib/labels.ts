// Node labels → a hue for dots and graph nodes. Gold is never a label colour: it is reserved for the lit path.
export const LABEL_HUE: Record<string, number> = {
  Business: 270, Person: 25, Team: 25, Agent: 300,
  Decision: 265, Document: 250, Chunk: 250, Memory: 300, Turn: 300, Session: 300,
  Channel: 330, Content: 340, Campaign: 10,
  Audience: 170, Need: 185, Product: 150, Feature: 150,
  Rule: 120, BrandRule: 110, BrandAsset: 110, Playbook: 125,
  Observation: 225, Metric: 215,
  Page: 200, Query: 195, Event: 45,
  Task: 55, System: 160, Recommendation: 300, Approval: 300, Action: 300, Finding: 300,
  Competitor: 285, Supplier: 285, Partner: 285, Client: 285,
};

export const hueFor = (label: string) => LABEL_HUE[label] ?? 265;

/** Solid node colour for canvases (works on both themes). */
export const nodeColor = (label: string, dark: boolean) => `oklch(${dark ? 72 : 58}% ${label === "Document" || label === "Chunk" ? 0.04 : 0.11} ${hueFor(label)})`;

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

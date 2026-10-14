// Ontology: the node labels Allevia writes (spec §5.2). Every node also carries the base label `Entity`.
export const ENTITY_TYPES = [
  "Business", "Person", "Agent", "Team", "Product", "Feature", "Audience", "Need", "BrandRule", "BrandAsset",
  "Channel", "Content", "Campaign", "Page", "Query", "Metric", "Observation", "Document", "Chunk", "Decision", "Task",
  "System", "Event", "Playbook", "Rule", "Recommendation", "Approval", "Action", "Session", "Turn", "Memory", "Version",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

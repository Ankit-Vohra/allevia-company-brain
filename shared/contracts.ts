// Contracts shared by the backend (src/) and the web app (web/). Pure types and constants: no Node or DOM imports.
// The founder, 2026-10-15: "every agent is visible … if a request is given then it should be visible on steps followed
// what each agent did". So one request streams as AgentEvents that say which agent did what, with the graph nodes
// each step touched, and the web app animates them in the office and on the graph.

export interface NodeRef { id: string; label: string; name: string; asOf?: string; simulated?: boolean }
export interface EdgeRef { from: string; type: string; to: string; since?: number; until?: number | null }
export interface SourceRef { id: string; title: string; asOf?: string }

// What every graph tool returns: the data plus the nodes/edges it touched (for the path view and the citation check).
export interface ToolResult<T = unknown> { data: T; nodes: NodeRef[]; edges: EdgeRef[]; sources: SourceRef[]; note?: string }

export type AgentId = string; // a roster id, e.g. "chief-of-staff"

// One step of the Chief of Staff's plan. Steps whose `after` agents have finished run in parallel.
export interface PlanStep { agent: AgentId; task: string; after?: AgentId[] }

export interface TurnChecks {
  citationsValid: boolean; invalidCitations: string[];
  numbersGrounded: boolean; ungroundedNumbers: string[];
  simulatedDisclosed: boolean; freshnessDisclosed: boolean;
}

export type AgentEvent =
  | { type: "session"; tenant: string; sessionId: string; turnId: string; question: string }
  | { type: "recall"; brief: string; ids: string[] }                                  // "what we already know" from earlier threads
  | { type: "plan"; by: AgentId; steps: PlanStep[]; rationale: string }
  | { type: "agent_start"; agent: AgentId; task: string }
  | { type: "agent_status"; agent: AgentId; text: string }                           // one human line: "Reading Search Console clicks"
  | { type: "tool_call"; agent: AgentId; id: string; name: string; args: unknown }
  | { type: "tool_result"; agent: AgentId; id: string; name: string; summary: string; nodes: NodeRef[]; edges: EdgeRef[]; sources: SourceRef[] }
  | { type: "handoff"; from: AgentId; to: AgentId; note: string }
  | { type: "finding"; agent: AgentId; findingId: string; text: string; citations: string[]; basedOn?: string[] }
  | { type: "review"; agent: AgentId; findingId: string; verdict: "ok" | "fix" | "reject"; note: string }
  | { type: "proposal"; agent: AgentId; recommendationId: string; approvalId: string; title: string; kind: ActionKind }
  | { type: "agent_done"; agent: AgentId; ms: number; ok: boolean }
  | { type: "text"; agent: AgentId; delta: string }                                   // the final answer streaming (Chief of Staff)
  | { type: "path"; nodes: NodeRef[]; edges: EdgeRef[] }                              // the explanation path, ordered
  | { type: "final"; turnId: string; answer: string; citations: string[]; checks: TurnChecks; agents: AgentId[]; ms: number }
  // Studio (product design §6, §7): an Asset appeared, Tara assessed a photo, a rule was learned from an approval
  | { type: "asset"; agent: AgentId; assetId: string; kind: AssetKind; parentId?: string; thumb?: string; simulated?: boolean }
  | { type: "assessment"; agent: AgentId; assetId: string; verdict: AssessmentVerdict; overlays: AssessmentOverlay[] }
  | { type: "learned"; ruleId: string; text: string; fromApprovalId: string }
  | { type: "error"; agent?: AgentId; message: string };

// An Asset node's role: the owner's upload, a generated or edited variant of it, or the approved final.
export type AssetKind = "original" | "variant" | "final";
// Tara's call on an uploaded photo (product design §6, step 3).
export type AssessmentVerdict = "use" | "enhance" | "recompose" | "reshoot";
// A box drawn over the photo, in 0..1 coordinates of its width and height (x, y is the top-left corner). `kind` is open
// so new overlay types need no contract change; today: "clutter", "privacy", "text", "lock".
export interface AssessmentOverlay { kind: string; x: number; y: number; w: number; h: number; note: string }

export type ActionKind = "github_issue" | "content_draft" | "pause_ad" | "discord_post";

// Onboarding (paste a website URL) streams these. profile, goals, baseline and capabilities arrived with schema v2.
export type OnboardStage =
  | "crawl" | "brand" | "seo" | "understand" | "playbooks" | "index" | "done"
  | "profile" | "goals" | "baseline" | "capabilities";
export type OnboardEvent =
  | { type: "stage"; stage: OnboardStage; text: string }
  | { type: "page"; url: string; title: string }
  | { type: "nodes"; nodes: NodeRef[]; edges: EdgeRef[] }                             // graph grows live
  | { type: "done"; tenant: string; counts: Record<string, number> }
  | { type: "error"; message: string };

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
  | { type: "error"; agent?: AgentId; message: string };

export type ActionKind = "github_issue" | "content_draft" | "pause_ad" | "discord_post";

// Onboarding (paste a website URL) streams these.
export type OnboardEvent =
  | { type: "stage"; stage: "crawl" | "brand" | "seo" | "understand" | "playbooks" | "index" | "done"; text: string }
  | { type: "page"; url: string; title: string }
  | { type: "nodes"; nodes: NodeRef[]; edges: EdgeRef[] }                             // graph grows live
  | { type: "done"; tenant: string; counts: Record<string, number> }
  | { type: "error"; message: string };

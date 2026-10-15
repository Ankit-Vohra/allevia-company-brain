// The JSON shapes the API returns. They mirror web/src/types-ext.ts field for field (the web app's contract for
// Milestone 4.1); change both together. AgentEvent, NodeRef, EdgeRef and SourceRef come from shared/contracts.ts.
import type { ActionKind, AgentEvent, AgentId, EdgeRef, NodeRef, SourceRef, TurnChecks } from "../../shared/contracts.js";

export interface TenantDto {
  id: string;
  name: string;
  domain: string;
  industry: string;
  city?: string;
  country?: string;
  currency?: string;
  locale?: string;
  timeZone?: string;
}

export interface FreshnessDto { source: string; asOf: string; status: "ok" | "stale" | "error"; note?: string }

export interface OverviewDto {
  tenant: TenantDto;
  counts: Record<string, number>;
  freshness: FreshnessDto[];
  brief: string;
  recommendations: RecommendationDto[];
  approvalsPending: number;
}

export type Channel = "web" | "discord" | "cli";

export interface SessionSummaryDto { id: string; title: string; startedAt: string; lastAt: string; turns: number; channel: Channel }

export interface TurnRecordDto {
  id: string;
  question: string;
  answer: string;
  at: string;
  ms: number;
  agents: AgentId[];
  citations: string[];
  checks: TurnChecks;
}

export interface SessionDetailDto { id: string; title: string; turns: TurnRecordDto[] }

export interface SearchHitDto { node: NodeRef; score: number; snippet?: string }

export interface GraphNodeDto extends NodeRef { rank?: number; community?: number; summary?: string }
export interface GraphDataDto { nodes: GraphNodeDto[]; edges: EdgeRef[] }

export interface VersionRecordDto { since: string; until: string | null; props: Record<string, unknown>; src?: string }

export interface NodeDetailDto {
  node: GraphNodeDto;
  props: Record<string, unknown>;
  neighbors: { edge: EdgeRef; node: NodeRef; direction: "out" | "in" }[];
  versions: VersionRecordDto[];
  sources: SourceRef[];
}

export interface AgentStatsDto {
  requests: number;
  findings: number;
  proposals: number;
  reviewsGiven: number;
  checksPassed: number;
  checksTotal: number;
  lastActiveAt?: string;
}

export interface FindingRecordDto {
  id: string;
  agent: AgentId;
  text: string;
  citations: string[];
  turnId: string;
  question: string;
  at: string;
  verdicts: { by: AgentId; verdict: "ok" | "fix" | "reject"; note: string }[];
}

export interface AgentSummaryDto { id: AgentId; stats: AgentStatsDto; knows: number }

export interface AgentDetailDto {
  id: AgentId;
  playbooks: { id: string; name: string; source: string }[];
  knowledge: { nodes: (NodeRef & { weight?: number })[]; edges: EdgeRef[] };
  findings: FindingRecordDto[];
  stats: AgentStatsDto;
}

export const REC_AREAS = ["seo", "content", "funnel", "ads", "knowledge", "tech"] as const;
export type RecArea = (typeof REC_AREAS)[number];

export interface RecommendationDto {
  id: string;
  area: RecArea;
  title: string;
  why: string;
  impact: string;
  value?: { amount: number; currency?: string; per?: "week" | "month" | "year"; note?: string };
  confidence: number;
  score: number;
  status: "open" | "proposed" | "approved" | "dismissed";
  by: AgentId;
  evidence: NodeRef[];
  evidenceEdges: EdgeRef[];
  approvalId?: string;
  simulated?: boolean;
  createdAt: string;
}

export const APPROVAL_STATUSES = ["pending", "approved", "edited", "rejected", "executed", "failed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalPayload { title: string; body: string; target?: string }

export interface ApprovalDto {
  id: string;
  kind: ActionKind;
  status: ApprovalStatus;
  title: string;
  by: AgentId;
  recommendationId?: string;
  payload: ApprovalPayload;
  editedPayload?: ApprovalPayload;
  createdAt: string;
  decidedAt?: string;
  result?: string;
  simulated?: boolean;
}

// POST /api/:t/approvals/:id answers with the card as it stands plus what the decision did: the `learned` AgentEvents
// (the "applied: your edit" chip; one per rule learned from an edit, in the JSON rather than a stream, since a decision
// is one short request) and the Action the executor recorded (status done | failed | skipped | dry_run).
export interface DecisionDto extends ApprovalDto {
  learned: Array<Extract<AgentEvent, { type: "learned" }>>;
  action: { id: string; kind: ActionKind; status: "done" | "failed" | "skipped" | "dry_run"; result: string; url?: string; simulated?: boolean } | null;
}

export interface BriefDto { id: string; title: string; asOf?: string; text: string }

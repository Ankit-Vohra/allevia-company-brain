// The JSON shapes the API returns. They mirror web/src/types-ext.ts field for field (the web app's contract for
// Milestone 4.1); change both together. AgentEvent, NodeRef, EdgeRef and SourceRef come from shared/contracts.ts.
import type { ActionKind, AgentEvent, AgentId, EdgeRef, NodeRef, SourceRef, TurnChecks } from "../../shared/contracts.js";
import type { LiveStatus, LiveTurnDto } from "./turns.js";

export type { LiveStatus, LiveTurnDto };

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
  /** With owner links on (ALLEVIA_AUTH=1): this business is shown to the caller as a public demo, read-only. The web app turns its change buttons off. */
  readOnly?: boolean;
  /** With readOnly: a real business shown to the public (showcase.ts): people, customers, messages and private documents are masked. */
  showcase?: boolean;
  /** With sign-in on: the caller's role in this business (an owner link or the operator's makes them the owner). Absent for a demo they only read, and with sign-in off. */
  role?: "owner" | "member";
  /** With role: the caller is an operator account (the person who runs Allevia) and opens this business as its owner without being in it. */
  operator?: true;
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

// running: a turn in this thread is still working on the server (turns.ts); set only then.
// agent: a direct chat with that one roster agent (Session.agent); absent: the whole team.
export interface SessionSummaryDto { id: string; title: string; startedAt: string; lastAt: string; turns: number; channel: Channel; running?: boolean; agent?: AgentId }

export interface TurnRecordDto {
  id: string;
  question: string;
  answer: string;
  at: string;
  ms: number;
  target?: AgentId;             // a direct chat: the agent the owner asked (Turn.target); absent: the whole team
  source?: Channel;             // the door it came through: "web" or "discord" (a thread can be continued from either)
  agents: AgentId[];
  skills?: string[];            // the skills the team opened for it, "agent-id/skill-id" (Turn.skills)
  citations: string[];
  checks: TurnChecks;
  ended?: "stopped" | "failed"; // set only when the turn did not finish: stopped by the owner (or the time cap), or failed
  error?: string;
}

// running: the thread's turn still working on the server (not yet among `turns`); the web app re-attaches to it with
// GET /api/:t/turns/:id/events.
export interface SessionDetailDto { id: string; title: string; agent?: AgentId; turns: TurnRecordDto[]; running?: LiveTurnDto }

// GET /api/:t/turns/:id/events?after=N: the turn's events from index N (at most a page of them), `next` the index to ask
// from next time, `done` once the turn has ended and every event has been sent. A turn no longer live on this server
// answers from its stored log (done at once).
export interface TurnEventsDto {
  turnId: string;
  sessionId: string;
  question: string;
  status: LiveStatus;
  events: AgentEvent[];
  next: number;
  done: boolean;
}

export interface SearchHitDto { node: NodeRef; score: number; snippet?: string }

export interface GraphNodeDto extends NodeRef { rank?: number; community?: number; summary?: string }
export interface GraphDataDto { nodes: GraphNodeDto[]; edges: EdgeRef[] }

/** The Brain map and Home's living brain (GET /api/:t/graph/map): the most important things, light enough for a phone.
 *  No summaries (a tap reads the card); `learnedAt` is when the team learned it (epoch ms, for "Watch it grow"); `links`
 *  are [from, to, type] indexes into `nodes` and `types`. `counts` are things by kind in the whole brain and `totals` its
 *  size, plumbing (versions, passages, read logs) left out. `capped`: there are more things than `nodes`.
 *  Business knowledge only: general know-how (the shared playbooks, src/graph/reference.ts) is drawn only with ?general=1,
 *  each such thing marked `general`, and is never in `counts` or `totals.things`; `totals.general` is how much there is. */
export interface BrainMapNodeDto extends NodeRef { rank: number; community?: number; learnedAt?: number; general?: boolean }
export interface BrainMapDto {
  nodes: BrainMapNodeDto[];
  types: string[];
  links: Array<[number, number, number]>;
  counts: Record<string, number>;
  totals: { things: number; links: number; general?: number };
  capped: boolean;
}

export interface VersionRecordDto { since: string; until: string | null; props: Record<string, unknown>; src?: string }

export interface NodeDetailDto {
  node: GraphNodeDto;
  props: Record<string, unknown>;
  neighbors: { edge: EdgeRef; node: NodeRef; direction: "out" | "in" }[];
  versions: VersionRecordDto[];
  sources: SourceRef[];
  // The answers whose "How we know" path walked through this node, newest first (memory.ts answersThrough).
  answers?: { turnId: string; question: string; at: string; sessionId?: string; pathIndex: number }[];
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

/** What a card carries beyond its title and text (src/server/preview.ts); mirrored in web/src/types-ext.ts. */
export interface ApprovalPreview {
  /** The reason, one sentence. */
  why?: string;
  /** Emails: who it goes to, who is copied, the subject; `draftOnly`: saved as a draft in the owner's inbox, not sent. */
  to?: string;
  cc?: string;
  subject?: string;
  draftOnly?: boolean;
  /** Meetings: when, and who is invited. `start` and `end` are ISO times; `timeZone` is the owner's. */
  when?: { start: string; end?: string; timeZone?: string; guests: string[] };
  /** Posts, posters and clips: the options to show (asset ids, served by /api/:t/assets/:id) and which one approving uses. */
  media?: { kind: "photo" | "poster" | "image" | "clip"; options: Array<{ id: string; label: string; note: string; pick: boolean; held: boolean }>; extras?: Array<{ id: string; label: string; kind: "clip"; note: string }> };
  /** A post to the owner's own account (publish_post): where it goes ("Instagram (your account @cafe)"), and when, when it is not straight away. */
  post?: { where: string; when?: { at: string; timeZone?: string; words: string }; textOnly?: boolean };
}

export interface ApprovalDto {
  id: string;
  kind: ActionKind;
  status: ApprovalStatus;
  title: string;
  by: AgentId;
  recommendationId?: string;
  payload: ApprovalPayload;
  editedPayload?: ApprovalPayload;
  /** Set when the card has something to show beyond its text. Absent on the answer to a decision. */
  preview?: ApprovalPreview;
  createdAt: string;
  decidedAt?: string;
  result?: string;
  simulated?: boolean;
  /** What saying OK spends, in credits (shared/credits.ts approvalCharges; the recommended option of a Studio card). */
  credits?: number;
}

// POST /api/:t/approvals/:id answers with the card as it stands plus what the decision did: the `learned` AgentEvents
// (the "applied: your edit" chip; one per rule learned from an edit, in the JSON rather than a stream, since a decision
// is one short request) and the Action the executor recorded (status done | failed | skipped | dry_run).
export interface DecisionDto extends ApprovalDto {
  learned: Array<Extract<AgentEvent, { type: "learned" }>>;
  action: { id: string; kind: ActionKind; status: "done" | "failed" | "skipped" | "dry_run"; result: string; url?: string; simulated?: boolean } | null;
  /** A "post it" card: the post it made (scheduled, posted or failed), so the page can offer Cancel or Try again at once. */
  post?: import("../publish/dto.js").PostDto;
}

export interface BriefDto { id: string; title: string; asOf?: string; text: string }

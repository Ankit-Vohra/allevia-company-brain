// API shapes the web app needs that shared/contracts.ts does not define yet. The backend (Milestone 4.1) should return
// exactly these; when they move into shared/contracts.ts, re-export them from there and delete them here.
import type { ActionKind, AgentEvent, AgentId, AgentSettings, EdgeRef, LearnedRuleDto, NodeRef, SkillView, SourceRef, TurnChecks } from "@shared/contracts";

export interface Tenant {
  id: string;            // graph name, e.g. "aamdani"
  name: string;          // "Aamdani"
  domain: string;        // "aamdani.ai"
  industry: string;      // "Blue-collar jobs platform"
  city?: string;
  country?: string;      // "United Kingdom"
  currency?: string;     // ISO 4217, the currency the business reports in: "GBP", "AUD", "AED", "USD", "INR"
  locale?: string;       // BCP 47, how the owner reads dates and numbers: "en-GB", "en-US", "en-AU"
  timeZone?: string;     // IANA, the owner's clock: "Asia/Kolkata", "Europe/London", "America/New_York"
}

export interface Freshness { source: string; asOf: string; status: "ok" | "stale" | "error"; note?: string }

export interface Overview {
  tenant: Tenant;
  counts: Record<string, number>;             // label -> node count
  freshness: Freshness[];
  brief: string;                              // morning brief, markdown with [[node-id]] citations
  recommendations: Recommendation[];          // top few
  approvalsPending: number;
}

/** `running`: a turn in this thread is still working on the server (set only then). */
export interface SessionSummary { id: string; title: string; startedAt: string; lastAt: string; turns: number; channel: "web" | "discord" | "cli"; running?: boolean }

export interface TurnRecord {
  id: string;
  question: string;
  answer: string;
  at: string;
  ms: number;
  /** The door it came through. A thread can be continued from the web or from Discord. */
  source?: "web" | "discord" | "cli";
  agents: AgentId[];
  citations: string[];
  checks: TurnChecks;
  /** Set only when the turn did not finish: stopped by the owner, or failed. */
  ended?: "stopped" | "failed";
  error?: string;
}

/** `running`: the thread's turn still working on the server (not yet among `turns`); re-attach with turnEvents. */
export interface SessionDetail { id: string; title: string; turns: TurnRecord[]; running?: LiveTurn }

/** A turn running on the server: it goes on when the tab closes, and only an explicit stop cancels it. */
export type LiveStatus = "running" | "done" | "failed" | "stopped";
export interface LiveTurn { turnId: string; sessionId: string; question: string; startedAt: string; status: LiveStatus }

/** GET /api/:t/turns/:id/events?after=N: events from index N, `next` to ask from, `done` once ended and all sent. */
export interface TurnEventsPage { turnId: string; sessionId: string; question: string; status: LiveStatus; events: AgentEvent[]; next: number; done: boolean }

export interface SearchHit { node: NodeRef; score: number; snippet?: string }

/** A graph node as the viewer gets it. `rank` is PageRank (0–1), `community` a label-propagation id. */
export interface GraphNode extends NodeRef { rank?: number; community?: number; summary?: string }
export interface GraphData { nodes: GraphNode[]; edges: EdgeRef[] }

export interface VersionRecord { since: string; until: string | null; props: Record<string, unknown>; src?: string }

export interface NodeDetail {
  node: GraphNode;
  props: Record<string, unknown>;
  neighbors: { edge: EdgeRef; node: NodeRef; direction: "out" | "in" }[];
  versions: VersionRecord[];
  sources: SourceRef[];
}

export interface AgentStats {
  requests: number;       // turns HANDLED_BY this agent
  findings: number;       // Findings PRODUCED
  proposals: number;      // Recommendations proposed
  reviewsGiven: number;
  checksPassed: number;   // Findings that passed review
  checksTotal: number;
  lastActiveAt?: string;
}

export interface FindingRecord {
  id: string;
  agent: AgentId;
  text: string;
  citations: string[];
  turnId: string;
  question: string;
  at: string;
  verdicts: { by: AgentId; verdict: "ok" | "fix" | "reject"; note: string }[];
}

export interface AgentSummary { id: AgentId; stats: AgentStats; knows: number }

export interface AgentDetail {
  id: AgentId;
  playbooks: { id: string; name: string; source: string }[];
  /** The agent's KNOWS_ABOUT subgraph: the agent node, the entities it knows (weight 0–1) and the edges between them. */
  knowledge: { nodes: (NodeRef & { weight?: number })[]; edges: EdgeRef[] };
  findings: FindingRecord[];
  stats: AgentStats;
}

export interface Recommendation {
  id: string;
  area: "seo" | "content" | "funnel" | "ads" | "knowledge" | "tech";
  title: string;
  why: string;              // markdown with [[node-id]] citations
  impact: string;
  /** Money at stake, when there is a figure: shown in the business's currency. */
  value?: { amount: number; currency?: string; per?: "week" | "month" | "year"; note?: string };
  confidence: number;       // 0–1
  score: number;
  status: "open" | "proposed" | "approved" | "dismissed";
  by: AgentId;
  evidence: NodeRef[];      // ordered evidence chain
  evidenceEdges: EdgeRef[];
  approvalId?: string;
  simulated?: boolean;
  createdAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "edited" | "rejected" | "executed" | "failed";

export interface Approval {
  id: string;
  kind: ActionKind;
  status: ApprovalStatus;
  title: string;
  by: AgentId;
  recommendationId?: string;
  payload: { title: string; body: string; target?: string };
  editedPayload?: { title: string; body: string; target?: string };
  createdAt: string;
  decidedAt?: string;
  result?: string;          // e.g. the GitHub issue URL once executed
  simulated?: boolean;
}

export interface ApprovalDecision { decision: "approve" | "reject"; editedPayload?: { title: string; body: string; target?: string } }

export interface OnboardRequest {
  name: string;
  url: string;
  instagram?: string;
  /** Where the business trades, and so which currency and date style the team reports in (product design §8). */
  country?: string;
  currency?: string;   // ISO 4217
  locale?: string;     // BCP 47
  timeZone?: string;   // IANA, the owner's clock (a first guess from the country; the owner can change it later)
}

/** A stored turn's event log, as returned by GET /api/:t/turns/:id/replay. */
export type ReplayLog = AgentEvent[];

// ---------- Allevia 90, the team and what it learned (product design §2.3–2.4, §3.3, §8) ----------
// The shapes themselves live in shared/contracts.ts; these are the envelopes the routes wrap them in.

/** GET /api/:t/agents: each roster agent's stats, its settings and the active rules it learned (src/server/routes/team.ts). */
export type AgentView = AgentSummary & AgentSettings & {
  learnedRules: Array<Pick<LearnedRuleDto, "id" | "text" | "confidence" | "appliedCount" | "learnedAt">>;
  /** What this person can look at and do, in the owner's words, and how they work (absent in the sample mode). */
  tools?: Array<{ name: string; words: string }>;
  skills?: SkillView[];
};

/** GET /api/:t/learning?since= */
export interface LearningFeed {
  since: string;
  firstPass: { rate: number | null; decided30d: number; firstPass30d: number };
  active: number;
  rules: LearnedRuleDto[];
}

/** GET /api/:t/brief, and the part of POST /api/:t/brief/run's answer the web app reads. */
export interface Brief { id: string; title: string; asOf?: string; date?: string; text: string }

export type LearnedEvent = Extract<AgentEvent, { type: "learned" }>;

/** POST /api/:t/approvals/:id: the card as it stands, plus the rules the decision taught and the Action it ran. */
export interface DecisionResult extends Approval {
  learned?: LearnedEvent[];
  action?: { id: string; kind: ActionKind; status: "done" | "failed" | "skipped" | "dry_run"; result: string; url?: string; simulated?: boolean } | null;
}

// ---------- plan and usage (product design §4.1, §4.2) ----------

/** One Studio charge: credits spent when a draft was approved. */
export interface UsageItem { subject: string; name: string; credits: number; date: string }

/** GET /api/:t/usage?month=YYYY-MM (src/server/routes/usage.ts). */
export interface Usage {
  month: string;
  credits: { used: number; items: UsageItem[] };
  costUsd: number;            // what the month's Studio work cost to make; covered by the plan
  answers: number;            // questions the team answered this month
  actionsLive: boolean;       // false: approved GitHub issues and Discord posts are dry runs
  billingConnected: false;
}

// ---------- "Your team suggests these goals" (src/server/routes/goals.ts) ----------

/** GET /api/:t/goals/setup, and POST /api/:t/goals/:id's answer: a suggested goal and whether the owner said OK. */
export interface GoalSetup {
  id: string;
  name: string;
  unit: string | null;
  period: "week" | "month";
  baseline: number | null;
  target: number | null;
  why: string | null;
  confirmed: boolean;
}

// ---- "Add your numbers": the spreadsheet upload (POST /api/:t/numbers/preview and /import). They mirror
// src/connectors/upload/types.ts and src/connectors/upload/import.ts; change both together. ----

export type NumbersCadence = "day" | "week" | "month";

/** What the owner confirms. `metric` is a key from `metricOptions`, "skip", "other" (named in `label`), or null while it still needs an answer. */
export interface NumbersPlanColumn { index: number; metric: string | null; label?: string }
export interface NumbersPlan {
  dateColumn: number;
  dateOrder: "dmy" | "mdy";
  cadence: NumbersCadence | "ranges" | null;
  weekAnchor: "start" | "end";
  columns: NumbersPlanColumn[];
}
export interface NumbersPreviewColumn {
  index: number;
  letter: string;
  header: string;
  sample: string[];
  guess: { metric: string | null; label: string | null; sure: boolean };
}
export interface NumbersPreview {
  fileName: string;
  fileHash: string;
  sheet?: string;
  rowCount: number;
  dateColumn: { index: number; letter: string; header: string };
  dateOrderGuessed: boolean;
  cadence: NumbersCadence | null;
  from: string;
  to: string;
  columns: NumbersPreviewColumn[];
  leftOut: Array<{ index: number; header: string; reason: string }>;
  headline: string;
  sentences: string[];
  sampleRows: string[][];
  questions: Array<"date_order" | "cadence" | "metrics">;
  metricOptions: Array<{ key: string; label: string }>;
  plan: NumbersPlan;
  feedsGoals?: Array<{ id: string; name: string }>;
}
/** GET /api/:t/connectors/search-console: the connection in plain words (src/connectors/google/searchconsole.ts ConnectorStatus). */
export interface ConnectorStatus {
  state: "not_configured" | "not_connected" | "choose_property" | "connected" | "needs_reconnect";
  message: string;
  property?: string;
  sites?: string[];
  lastPullAt?: string;
  dataThrough?: string;
  capabilityMode?: string;
}

export interface NumbersGoalOutcome {
  id: string;
  name: string;
  current: number | null;
  baseline: number | null;
  status: string;
  sentence: string;
  newlyMeasured: boolean;
}
export interface NumbersImportResult {
  status: "imported" | "already_added" | "replaced_earlier";
  fileName: string;
  written: number;
  goals: NumbersGoalOutcome[];
  capabilities: Array<{ key: string; name: string; from: string; to: string }>;
  sentences: string[];
}

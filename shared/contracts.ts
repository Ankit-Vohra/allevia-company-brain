// Contracts shared by the backend (src/) and the web app (web/). Pure types and constants: no Node or DOM imports.
// The founder, 2026-10-15: "every agent is visible … if a request is given then it should be visible on steps followed
// what each agent did". So one request streams as AgentEvents that say which agent did what, with the graph nodes
// each step touched, and the web app animates them in the office and on the graph.

export interface NodeRef { id: string; label: string; name: string; asOf?: string; simulated?: boolean }
export interface EdgeRef { from: string; type: string; to: string; since?: number; until?: number | null }
export interface SourceRef { id: string; title: string; asOf?: string }

// What every graph tool returns: the data plus the nodes/edges it touched (for the path view and the citation check).
// `guidance` is text for the model only (a skill's method): it is shown to the agent but is never evidence, so it is not
// recorded as something the turn saw and no citation or number check counts it.
export interface ToolResult<T = unknown> { data: T; nodes: NodeRef[]; edges: EdgeRef[]; sources: SourceRef[]; note?: string; guidance?: string }

export type AgentId = string; // a roster id, e.g. "chief-of-staff"

// One step of the Chief of Staff's plan. Steps whose `after` agents have finished run in parallel.
export interface PlanStep { agent: AgentId; task: string; after?: AgentId[] }

export interface TurnChecks {
  citationsValid: boolean; invalidCitations: string[];
  numbersGrounded: boolean; ungroundedNumbers: string[];
  simulatedDisclosed: boolean; freshnessDisclosed: boolean;
  // The answer says where its data came from for every capability it cites whose access mode is not "api" ("from your
  // public profile", "benchmark"). Always set by checkTurn; absent on turns saved before the capability ladder.
  modeDisclosed?: boolean;
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
  // The final answer streaming (Chief of Staff). With `reset`, the answer shown so far is replaced by `delta`: text the
  // Chief wrote before a lookup was a working note, not the answer, and is taken back (it goes to the log as a status).
  | { type: "text"; agent: AgentId; delta: string; reset?: true }
  | { type: "path"; nodes: NodeRef[]; edges: EdgeRef[] }                              // the explanation path, ordered
  | { type: "final"; turnId: string; answer: string; citations: string[]; checks: TurnChecks; agents: AgentId[]; ms: number }
  // Studio (product design §6, §7): an Asset appeared, Tara assessed a photo, a rule was learned from an approval
  | { type: "asset"; agent: AgentId; assetId: string; kind: AssetKind; parentId?: string; thumb?: string; simulated?: boolean }
  | { type: "assessment"; agent: AgentId; assetId: string; verdict: AssessmentVerdict; overlays: AssessmentOverlay[] }
  | { type: "learned"; ruleId: string; text: string; fromApprovalId: string }
  // An agent loaded one of its skills (how it does this kind of work here): "Tara is using: Instagram post craft".
  | { type: "skill_used"; agent: AgentId; skillId: string; name: string; source: "code" | "business" }
  // Something the team made on request (a poster, an image, a clip): the options, each checked, with a card waiting for the owner's OK
  | { type: "deliverable"; agent: AgentId; kind: DeliverableKind; title: string; approvalId: string; recommended: string; options: DeliverableOption[]; notes: string[]; credits?: number }
  // The team needs a few answers before it can make something well: at most three short questions, each with tap-to-answer
  // options (an empty list means a typed answer). Discord shows buttons, the web app chips; an answer is sent as the next message.
  | { type: "quick_replies"; agent: AgentId; questions: Array<{ field: string; question: string; options: string[] }> }
  | { type: "error"; agent?: AgentId; message: string };

// What the team can make from a request. Each becomes an Asset (with lineage) and waits for the owner's OK as a card.
export type DeliverableKind = "poster" | "image" | "clip";
export interface DeliverableOption {
  assetId: string;
  label: string;                         // "A", "B", "C"
  badge: "ok" | "held" | "unchecked";    // Nisha's check: passed, held back, or could not be checked
  note: string;
  thumb: string;                         // the asset proxy URL of a small copy
  layout?: string;
  aiEdited: boolean;                     // the artwork behind it came from an image model
}

// An Asset node's role: the owner's upload, a generated or edited variant of it, or the approved final.
export type AssetKind = "original" | "variant" | "final" | "poster" | "image" | "clip" | "artwork";
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
// Where the owner joins their team on Discord. Only present when the Discord hub is set up on this server.
// inviteUrl: a single-use join link; later: the area is not ready yet ("We'll send your Discord link shortly").
export interface DiscordInfo { inviteUrl?: string; later?: boolean }

// GET /api/:t/discord (the Home page): enabled false when this server has no Discord hub.
export interface DiscordHome {
  enabled: boolean;
  state?: "invite" | "joined" | "expired" | "later";
  inviteUrl?: string;       // invite: the single-use link
  openUrl?: string;         // joined: the team's channel
}

export type OnboardEvent =
  | { type: "stage"; stage: OnboardStage; text: string }
  | { type: "page"; url: string; title: string }
  | { type: "nodes"; nodes: NodeRef[]; edges: EdgeRef[] }                             // graph grows live
  | { type: "done"; tenant: string; counts: Record<string, number>; discord?: DiscordInfo }
  | { type: "error"; message: string; soft?: boolean };   // soft: one step did not finish but the set-up goes on and ends with `done`

// ---------- capability ladder and team settings (product design §2.3, §2.4, §8) ----------

// What each connected (or not) source lets the agents do, at the best access mode available, best first.
export type CapabilityKey = "ga4" | "search_console" | "gbp" | "instagram_insights" | "reviews" | "studio" | "ads";
export type AccessMode = "api" | "delegated" | "upload" | "public" | "benchmark" | "none";
// ok: working at its mode; stale: its connector data is over 7 days old; down: its connector reports an error (it
// dropped a rung); not_connected: no connector at all.
export type CapabilityStatus = "ok" | "stale" | "down" | "not_connected";

// GET /api/:t/capabilities
export interface CapabilityState {
  id: string;                 // capability:<key>
  key: CapabilityKey;
  name: string;               // "Instagram insights"
  accessMode: AccessMode;
  status: CapabilityStatus;
  lastOkAt: number | null;    // epoch ms of the newest live connector data, if there ever was any
  upgradeHint: string;        // the one action that would move it up a rung, in plain words
  dependsOn: string[];        // the Channel and System ids it reads
}

export type AgentMode = "full" | "light" | "off";

// GET /api/:t/agents
export interface AgentSettings {
  id: AgentId;                // roster id
  nodeId: string;             // agent:allevia-<id>
  name: string;
  title: string;
  department: string;
  enabled: boolean;
  mode: AgentMode;
  autonomy: number;           // 0 draft only, 1 scheduled after approval, 2 auto-publish with a digest, 3 full
  statusNote?: string;        // "till the new site launches"
  skillsOff?: string[];       // skill ids the owner switched off for this person (absent: all of their skills are on)
  instructions: Array<{ id: string; text: string; channel?: string; at?: number }>;
}

// One skill of one person on the team, as the owner reads it (GET /api/:t/agents): what it is for, what it can make, whether
// it waits for their OK, whether it is the shipped one or this business's own, and the rules that business added to it.
export interface SkillView {
  id: string;
  name: string;
  when: string;
  makes?: string;             // plain words, only for a skill that makes something
  needsOk: boolean;
  on?: boolean;               // false when the owner switched this skill off for this person (GET /api/:t/agents)
  source: "code" | "business";
  rules: Array<{ id: string; text: string; channel?: string }>;  // the owner's or the team's own rules for this skill
  learned: string[];          // things the team learned from the owner's edits that belong to this skill
}

// "Tell your team": the owner's words turned into typed patches, previewed as a diff, then applied.
export type DirectivePatch =
  | { kind: "agent.enabled"; agent: AgentId; enabled: boolean; note?: string }
  | { kind: "agent.mode"; agent: AgentId; mode: AgentMode }
  | { kind: "agent.autonomy"; agent: AgentId; autonomy: number }
  | { kind: "memory.instruction"; agents: AgentId[]; text: string; channel?: string; limit?: { kind: "max_daily_spend"; amount: number; currency: string } }
  | { kind: "brand_rule.add"; text: string; ruleKind: "voice" | "visual" }
  // A rule for one skill ("our posts always end with a question" -> Tara's Instagram post craft); skill "*" = all the agent's skills.
  | { kind: "skill.rule"; agents: AgentId[]; skill: string; text: string; channel?: string }
  // A skill of this business's own (or one that replaces a shipped skill of the same id) for the named agents.
  | { kind: "skill.add"; agents: AgentId[]; id: string; name: string; when: string; text: string };

export interface DirectiveDiffLine {
  patch: number;              // index into patches
  op: "change" | "add" | "same";
  target: string;             // the node it writes (agent:allevia-tech-lead, memory:…, brand-rule:…)
  label: string;              // "Arjun (Tech Lead)"
  before?: string;
  after: string;
}

// POST /api/:t/directives (preview) and POST /api/:t/directives/:id/apply
export interface DirectivePreview {
  id: string;                 // document:directive-…
  text: string;
  actor: string;
  status: "preview" | "applied";
  patches: DirectivePatch[];
  diff: DirectiveDiffLine[];
  unparsed: string[];         // parts of the text that became no patch
  notes: string[];            // why something was left out ("the Chief of Staff can't be switched off")
  parser: "rules" | "rules+llm";
}

// ---------- Allevia 90 (product design §3.3, §8) ----------

export type GoalState = "achieved" | "on_track" | "at_risk" | "off_track" | "no_data";

export interface ProgramGoal {
  id: string;
  name: string;
  metricKey: string;
  unit: string | null;
  period: "week" | "month";   // week: the last 7 complete days; month: the last 28
  owner: { id: AgentId; name: string } | null;
  baseline: number | null;    // Day 0, from real Observations; null when there was no data (baselineConf 'unknown')
  baselineConf: "measured" | "reported" | "unknown";
  baselineAt: string | null;  // the last day of the baseline's period
  target: number | null;
  targetBasis: "baseline" | "template" | null; // baseline × (1 + lift), or the template's floor when there is no baseline
  current: number | null;     // the newest complete period
  currentAt: string | null;
  progress: number | null;    // 0 at the baseline, 1 at the target
  status: GoalState;
  dueAt: string | null;
}

export interface ProgramCheckpoint { day: 0 | 30 | 60 | 90; dueDate: string; status: "done" | "due" | "upcoming"; id?: string; at?: string; summary?: string }

// The first-pass rate over the 30 days up to each day since the program started (null on a day with no decision yet).
export interface FirstPassPoint { date: string; rate: number | null; decided: number; firstPass: number }

// GET /api/:t/program: the "Your 90 days: Day N" card. Every number comes from the graph.
export interface ProgramScorecard {
  id: string;
  kind: string;
  status: string;             // active | graduated
  day: number;                // 0 on the start date, in the business's time zone
  daysLeft: number;
  startDate: string;
  endDate: string;
  today: string;
  timeZone?: string;
  templateKey?: string;
  checkpoints: ProgramCheckpoint[];
  firstPass: { rate: number | null; decided30d: number; firstPass30d: number; series: FirstPassPoint[] };
  learnedRules: { active: number; learnedSinceStart: number; retired: number; recent: Array<{ id: string; text: string; learnedAt: string | null }> };
  goals: ProgramGoal[];
  capabilities: { byMode: Record<AccessMode, number>; items: Array<Pick<CapabilityState, "key" | "name" | "accessMode" | "status">> };
  deliverables: { approved: number; approvedSinceStart: number; editedSinceStart: number; rejectedSinceStart: number; pending: number };
}

// GET /api/:t/learning: what the team learned from the owner's edits, newest first.
export interface LearnedRuleDto {
  id: string;
  text: string;
  op: string;
  status: "active" | "retired";
  confidence: number;
  appliedCount: number;
  learnedAt: string | null;
  retiredAt: string | null;
  fromApprovalIds: string[];
  agents: AgentId[];          // the desks it applies to (none: everyone)
}

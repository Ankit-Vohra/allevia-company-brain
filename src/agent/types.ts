// Records one turn of the agent company produces, shared by the orchestrator (which builds them), memory (which
// persists them as Finding nodes and REVIEWED edges) and ask(). The wire events are in shared/contracts.ts.
import type { ActionKind, AgentId, NodeRef } from "../../shared/contracts.js";

// The "what we already know" brief built from the graph before a turn (spec §7.3). Its ids count as seen: agents may
// cite them.
export interface RecallBrief { text: string; ids: string[]; nodes?: NodeRef[] }

export interface FindingRecord {
  id: string;            // finding:<turnId>-<agentId>, stable across a revision
  agent: AgentId;
  task: string;
  text: string;          // ≤ 1,200 chars (4,000 for the content desk) with [[id]] citations
  citations: string[];
  basedOn: string[];     // finding ids it builds on (the handoff)
  proposals: string[];   // suggested actions, free text (proposals that became approvals arrive as ProposalRecord)
  revised: boolean;
  rejected: boolean;
  partial?: boolean;     // its desk ran out of turns: this is what it had written by then
  guidedBy?: string[];   // the owner's instruction Memories its desk worked under (saved as GUIDED_BY)
  skills?: string[];     // ids of the skills its desk opened (saved on the Finding)
}

// The owner's settings for the team, loaded from the graph before a turn (src/settings/directives.ts loadTeamSettings):
// which desks are switched off or light, and the standing instructions (Memory{kind:'instruction'} ABOUT an Agent).
export interface InstructionNote {
  id: string;                                   // memory:…
  text: string;
  agents: AgentId[];                            // roster ids it is about
  channel?: { id: string; name: string };       // a channel it is scoped to ("no emojis on LinkedIn")
}
export interface TeamSettings {
  disabled: AgentId[];                          // never planned, never review (the Chief of Staff can't be off)
  light?: AgentId[];                            // run on the cheapest model
  instructions: InstructionNote[];
}

export interface ReviewRecord { reviewer: AgentId; findingId: string; verdict: "ok" | "fix" | "reject"; note: string }

export interface ProposalRecord { agent: AgentId; recommendationId: string; approvalId: string; title: string; kind: ActionKind }

// finding:<turn key>-<agent>, e.g. finding:2026-10-15-1a2b3c4d-data-analyst (the turn id's "turn:" prefix dropped).
export const findingId = (turnId: string, agentId: string): string => `finding:${turnId.replace(/^turn:/, "")}-${agentId}`;

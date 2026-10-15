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
  text: string;          // ≤ 1,200 chars with [[id]] citations
  citations: string[];
  basedOn: string[];     // finding ids it builds on (the handoff)
  proposals: string[];   // suggested actions, free text (proposals that became approvals arrive as ProposalRecord)
  revised: boolean;
  rejected: boolean;
  partial?: boolean;     // its desk ran out of turns: this is what it had written by then
}

export interface ReviewRecord { reviewer: AgentId; findingId: string; verdict: "ok" | "fix" | "reject"; note: string }

export interface ProposalRecord { agent: AgentId; recommendationId: string; approvalId: string; title: string; kind: ActionKind }

// finding:<turn key>-<agent>, e.g. finding:2026-10-15-1a2b3c4d-data-analyst (the turn id's "turn:" prefix dropped).
export const findingId = (turnId: string, agentId: string): string => `finding:${turnId.replace(/^turn:/, "")}-${agentId}`;

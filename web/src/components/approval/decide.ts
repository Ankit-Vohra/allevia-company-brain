// Deciding a draft, the same call from every door: Home's "Needs your OK", the Approvals page, the chat, and the Discord
// buttons all post to POST /api/:t/approvals/:id. An edit becomes a habit the team keeps (the answer's `learned` events), so
// the team's pages are told to look again. What comes back is said to the owner in one line (Decided).
import type { ActionKind } from "@shared/contracts";
import { api } from "../../api";
import { plainTitle } from "../../lib/home";
import { TEAM_CHANGED } from "../../lib/office-shared";
import type { Approval, LearnedEvent, PostView } from "../../types-ext";
import { APPROVALS_CHANGED } from "../TopBar";

export type Payload = Approval["payload"];

/** A decision, said back. `failed`: the owner said OK but the tool refused, in the executor's own plain words. */
export interface Done {
  id: string; title: string; kind: ActionKind; outcome: "approved" | "edited" | "rejected";
  learned: LearnedEvent[]; failed?: string; draftOnly?: boolean; result?: string; post?: PostView;
}

export async function decideDraft(tenantId: string, a: Approval, decision: "approve" | "reject", edited?: Payload): Promise<Done> {
  const out = await api.decide(tenantId, a.id, { decision, ...(edited ? { editedPayload: edited } : {}) });
  const failed = decision === "approve" && out.action?.status === "failed" ? out.action.result : undefined;
  window.dispatchEvent(new Event(APPROVALS_CHANGED));
  if (out.learned?.length) window.dispatchEvent(new Event(TEAM_CHANGED));
  return {
    id: a.id, title: plainTitle(a.title), kind: a.kind,
    outcome: decision === "reject" ? "rejected" : edited ? "edited" : "approved",
    learned: out.learned ?? [],
    ...(failed ? { failed } : {}),
    ...(a.preview?.draftOnly ? { draftOnly: true } : {}),
    ...(a.kind === "publish_post" && decision === "approve" && out.action?.result && !failed ? { result: out.action.result } : {}),
    ...(out.post ? { post: out.post } : {}),
  };
}

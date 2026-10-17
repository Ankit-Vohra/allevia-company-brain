// A draft as one compact row: what kind it is (an icon), a short title, who made it and how big it is, then OK and Look.
// Look (or a tap on the title) opens the whole draft in a sheet (DraftView). Home's "Needs your OK" and the Approvals page
// list drafts with it; a decision is said back with Decided.
import { useState } from "react";
import { ACTION } from "../../lib/actions";
import { plainTitle } from "../../lib/home";
import type { Approval } from "../../types-ext";
import { AgentAvatar, agentDef } from "../bits";
import { Icon } from "../Icon";
import { LearnedChips } from "../Learning";
import { PostLine } from "../PostsList";
import { kindWords } from "../../lib/approval-words";
import type { Done } from "./decide";
import "./approval.css";

export function ApprovalRow({ a, big, stake, readOnly, onOk, onLook }: {
  a: Approval;
  big?: boolean;
  /** How big: the idea's figure ("≈3× reach per reel"), else what it costs in credits. */
  stake?: string;
  readOnly: boolean;
  onOk: (a: Approval) => Promise<void>;
  onLook: (a: Approval) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = plainTitle(a.title);
  const who = agentDef(a.by)?.name ?? "Your team";
  const size = stake ?? (a.credits ? `${a.credits} credits` : undefined);
  const ok = async () => {
    setBusy(true);
    setError(null);
    try {
      await onOk(a);
    } catch (e) {
      setError((e as Error).message || "That did not go through. Try again.");
      setBusy(false);
    }
  };
  return (
    <li className="ap-row" data-approval={a.id}>
      <span className="ap-row-icon" aria-hidden="true"><Icon name={ACTION[a.kind].icon} size={16} /></span>
      <button type="button" className="ap-row-main" onClick={() => onLook(a)} aria-label={`Look at: ${title}`}>
        <span className="ap-row-title">{title}</span>
        <span className="ap-row-meta">
          <AgentAvatar id={a.by} size={16} />
          <span className="ap-row-who">{who}</span>
          {big && <span className="ap-badge">Big one</span>}
          {size && <span className="ap-row-size">{size}</span>}
          {a.simulated && <span className="ap-sample">sample</span>}
        </span>
      </button>
      <span className="ap-row-acts">
        <button type="button" className="btn btn-gold btn-sm ap-ok" onClick={() => void ok()} disabled={busy || readOnly} aria-label={`OK: ${title}`} title={readOnly ? "Turned off in the public demo" : undefined}>
          {busy ? "…" : <><Icon name="check" size={14} /> OK</>}
        </button>
        <button type="button" className="btn btn-ghost btn-sm ap-look" onClick={() => onLook(a)} aria-label={`Look at: ${title}`}>Look</button>
      </span>
      {error && <p className="notice notice-bad ap-row-error" role="alert">{error}</p>}
    </li>
  );
}

/** A decision, said back in a line, with what the team learned from an edit and, for a post, Cancel or Try again. */
export function Decided({ d, tenantId, onPost }: { d: Done; tenantId: string; onPost?: (p: NonNullable<Done["post"]>) => void }) {
  const head = d.failed ? "Did not go through" : d.outcome === "rejected" ? "You said no" : d.outcome === "edited" ? "Approved with your edits" : "Approved";
  const line = d.failed ? d.failed : d.outcome === "rejected" ? "Nothing was changed." : d.result ?? kindWords({ kind: d.kind, title: d.title, preview: { draftOnly: d.draftOnly } }).done;
  return (
    <div className={`ap-done${d.failed ? " is-failed" : d.outcome === "rejected" ? " is-no" : ""}`} role="status">
      <p className="ap-done-line">
        <Icon name={d.failed ? "warn" : d.outcome === "rejected" ? "x" : "check"} size={15} />
        <span><b>{head}:</b> {d.title}. <span className="ap-done-tail">{line}</span></span>
      </p>
      {d.post && <PostLine tenantId={tenantId} post={d.post} onChanged={(p) => onPost?.(p)} quiet />}
      <LearnedChips events={d.learned} edited={d.outcome === "edited"} />
    </div>
  );
}

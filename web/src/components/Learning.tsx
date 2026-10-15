// Learning, made visible (product design §3.2, §8): the chip an edit earns on the Approvals card, a learned rule as a
// list row with its retire action, and the path a rule was learned along (rule -LEARNED_FROM-> approval -RESULTED_IN->
// the draft), opened from a book on Sara's shelf in the office.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { LearnedRuleDto, NodeRef } from "@shared/contracts";
import { api, getPublicMode } from "../api";
import { diffExcerpt, wordDiff } from "../lib/diff";
import { fmtDate, fmtPct } from "../lib/format";
import { hueFor } from "../lib/labels";
import { avatarUrl } from "../office/sprites";
import { useApp, useAsync } from "../state/app";
import type { LearnedEvent } from "../types-ext";
import { AgentAvatar, agentDef, deptOf } from "./bits";
import { Icon } from "./Icon";
import "./learning.css";

/** 'Say "home", not "villa".' → 'say "home", not "villa"': for "Learned: …". */
export const ruleClause = (text: string) => {
  const t = text.trim().replace(/[.\s]+$/, "");
  return /^[A-Z][a-z]/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t;
};

/** What a decision taught, on the decided card: one chip per rule, or an honest note when the edit taught none. */
export function LearnedChips({ events, edited }: { events: LearnedEvent[] | undefined; edited: boolean }) {
  if (!events) return null;
  if (!events.length) {
    return edited ? <p className="learned-none">Your edit is saved with this draft. Nothing new to remember for next time.</p> : null;
  }
  return (
    <ul className="learned-chips" aria-label="What the team learned from your edit">
      {events.map((e) => (
        <li key={e.ruleId} className="learned-pill">
          <Icon name="sparkle" size={13} />
          <span><b>Your team learned:</b> {ruleClause(e.text)} <span className="learned-pill-tail">· applied to future drafts</span></span>
        </li>
      ))}
    </ul>
  );
}

/** One learned rule: what it says, who follows it, how sure the team is, how often it has been used, and retire. */
export function RuleRow({ rule, onRetire, onOpen, compact }: {
  rule: Pick<LearnedRuleDto, "id" | "text" | "confidence" | "appliedCount" | "learnedAt"> & Partial<Pick<LearnedRuleDto, "agents" | "op" | "status" | "retiredAt">>;
  onRetire?: (id: string) => Promise<void>;
  onOpen?: (id: string) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const retired = rule.status === "retired";
  const retire = async () => {
    if (!onRetire) return;
    setBusy(true);
    setErr(null);
    try { await onRetire(rule.id); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <li className={`rule-row${retired ? " is-retired" : ""}${compact ? " is-compact" : ""}`}>
      <span className="rule-book" aria-hidden="true" style={{ ["--hue" as string]: rule.agents?.[0] ? hueOfAgent(rule.agents[0]) : 60 }} />
      <div className="rule-main">
        {onOpen ? (
          <button type="button" className="rule-text" onClick={() => onOpen(rule.id)} title="Show where this came from">{rule.text}</button>
        ) : (
          <p className="rule-text">{rule.text}</p>
        )}
        <p className="rule-meta">
          {!compact && rule.agents && rule.agents.length > 0 && (
            <span className="rule-who">
              {rule.agents.map((a) => <AgentAvatar key={a} id={a} size={16} />)}
              {rule.agents.map((a) => agentDef(a)?.name).join(", ")}
            </span>
          )}
          {retired ? <span>Retired {fmtDate(rule.retiredAt ?? undefined)}</span> : <span>Learned {fmtDate(rule.learnedAt ?? undefined)}</span>}
          {rule.appliedCount > 0 && <span>used in <b className="num">{rule.appliedCount}</b> {rule.appliedCount === 1 ? "draft" : "drafts"}</span>}
        </p>
        {err && <p className="notice notice-bad" role="alert">{err}</p>}
      </div>
      {onRetire && !retired && (
        <button type="button" className="btn btn-quiet btn-sm rule-retire" onClick={retire} disabled={busy || getPublicMode()} aria-label={`Stop using this: ${rule.text}`}>
          {busy ? "Stopping…" : "Stop using"}
        </button>
      )}
    </li>
  );
}

const hueOfAgent = (id: string) => deptOf(id)?.hue ?? 60;

// ---------------------------------------------------------------- the LEARNED_FROM path

interface PathData {
  rule: NodeRef;
  approval?: NodeRef;
  draft?: NodeRef;
  appliesTo: NodeRef[];
  usedBy: NodeRef[];
  edit?: { before: string; after: string; by: string; decidedAt?: string };
}

function PathNode({ n, role, onOpen }: { n: NodeRef; role: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="lp-node" style={{ ["--hue" as string]: hueFor(n.label) }} onClick={() => onOpen(n.id)} title={`${n.label}: ${n.name}. See what your team knows.`}>
      <span className="lp-node-role"><span className="lp-dot" aria-hidden="true" />{role}</span>
      <span className="lp-node-name">{n.name.replace(/^(?:content_draft|github_issue|pause_ad|discord_post): /, "")}</span>
      <span className="lp-node-id">{n.label}</span>
    </button>
  );
}

/** A small modal: the rule, the approval it was learned from and the draft that approval became, with the edit itself. */
export function LearnedPathDialog({ rule, onClose, onRetired }: { rule: LearnedRuleDto | null; onClose: () => void; onRetired?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { tenant } = useApp();
  const nav = useNavigate();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (rule && !d.open) d.showModal();
    if (!rule && d.open) d.close();
  }, [rule]);

  const path = useAsync<PathData | undefined>(async () => {
    if (!rule) return undefined;
    const r = await api.node(tenant.id, rule.id);
    const out = (d: typeof r, type: string, label?: string) =>
      d?.neighbors.filter((x) => x.direction === "out" && x.edge.type === type && (!label || x.node.label === label)).map((x) => x.node) ?? [];
    const approvalRef = out(r, "LEARNED_FROM")[0] ?? (rule.fromApprovalIds[0] ? { id: rule.fromApprovalIds[0], label: "Approval", name: rule.fromApprovalIds[0] } : undefined);
    const [appr, approvals] = await Promise.all([
      approvalRef ? api.node(tenant.id, approvalRef.id) : Promise.resolve(null),
      api.approvals(tenant.id).catch(() => []),
    ]);
    const action = out(appr, "RESULTED_IN")[0];
    const actionDetail = action ? await api.node(tenant.id, action.id) : null;
    const draft = out(actionDetail, "RESULTED_IN", "Content")[0] ?? action;
    const card = approvals.find((a) => a.id === approvalRef?.id);
    return {
      rule: r?.node ?? { id: rule.id, label: "Rule", name: rule.text },
      approval: appr?.node ?? approvalRef,
      draft,
      appliesTo: out(r, "APPLIES_TO"),
      usedBy: r?.neighbors.filter((x) => x.direction === "in" && x.edge.type === "USES_RULE").map((x) => x.node) ?? [],
      ...(card?.editedPayload ? {
        edit: {
          before: `${card.payload.title}\n${card.payload.body}`.trim(), after: `${card.editedPayload.title}\n${card.editedPayload.body}`.trim(),
          by: card.by, decidedAt: card.decidedAt,
        },
      } : {}),
    };
  }, [rule?.id, tenant.id]);

  const diff = useMemo(() => (path.data?.edit ? diffExcerpt(wordDiff(path.data.edit.before, path.data.edit.after)) : null), [path.data?.edit]);
  const open = (id: string) => { onClose(); nav(`/brain?node=${encodeURIComponent(id)}`); };
  const [busy, setBusy] = useState(false);
  const retire = async () => {
    if (!rule) return;
    setBusy(true);
    try { await api.retireRule(tenant.id, rule.id); onRetired?.(); onClose(); } finally { setBusy(false); }
  };
  const p = path.data;

  return (
    <dialog ref={ref} className="lp-dialog" aria-labelledby="lp-title" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {rule && (
        <div className="lp">
          <header className="lp-head">
            <span className="lp-portrait" aria-hidden="true"><img src={avatarUrl("librarian", 4)} width={44} height={44} alt="" /></span>
            <div>
              <p className="lp-eyebrow">From Sara’s shelf · learned {fmtDate(rule.learnedAt ?? undefined)}</p>
              <h2 id="lp-title" className="lp-title">{rule.text}</h2>
            </div>
            <button type="button" className="btn btn-quiet btn-icon" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
          </header>

          <p className="lp-stats">
            <span>Confidence <b className="num">{fmtPct(rule.confidence)}</b></span>
            <span>Applied to <b className="num">{rule.appliedCount}</b> {rule.appliedCount === 1 ? "draft" : "drafts"}</span>
            {rule.agents.length > 0 && <span className="lp-who">{rule.agents.map((a) => <AgentAvatar key={a} id={a} size={18} />)} {rule.agents.map((a) => agentDef(a)?.name).join(", ")} {rule.agents.length === 1 ? "follows it" : "follow it"}</span>}
          </p>

          <section aria-label="Where it was learned">
            <h3 className="lp-h">Learned along this path</h3>
            {path.loading && !p ? (
              <span className="skeleton" style={{ display: "block", height: 74 }} />
            ) : p ? (
              <ol className="lp-graph">
                <li><PathNode n={p.rule} role="The rule" onOpen={open} /></li>
                <li className="lp-edge" aria-label="learned from"><span>learned from</span></li>
                <li>{p.approval ? <PathNode n={p.approval} role="Your approval, with edits" onOpen={open} /> : <span className="lp-missing">That draft is no longer in your records</span>}</li>
                {p.draft && <li className="lp-edge" aria-label="resulted in"><span>resulted in</span></li>}
                {p.draft && <li><PathNode n={p.draft} role="The draft" onOpen={open} /></li>}
              </ol>
            ) : (
              <p className="notice notice-bad">The path did not load{path.error ? `: ${path.error}` : "."}</p>
            )}
          </section>

          {p?.edit && diff && (
            <section aria-label="Your edit">
              <h3 className="lp-h">Your edit{p.edit.decidedAt ? `, ${fmtDate(p.edit.decidedAt)}` : ""}</h3>
              <p className="lp-diff">
                {diff.map((d, i) => d.kind === "same" ? <span key={i}>{d.text}</span> : d.kind === "del" ? <del key={i}>{d.text}</del> : <ins key={i}>{d.text}</ins>)}
              </p>
            </section>
          )}

          {p && p.usedBy.length > 0 && (
            <section aria-label="Drafts that applied it since">
              <h3 className="lp-h">Applied since</h3>
              <ul className="lp-used">
                {p.usedBy.map((n) => <li key={n.id}><button type="button" className="lp-link" onClick={() => open(n.id)}><Icon name="file" size={14} /> {n.name}</button></li>)}
              </ul>
            </section>
          )}

          <footer className="lp-foot">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => open(rule.id)}><Icon name="brain" size={14} /> Open in the brain</button>
            {rule.status === "active" && (
              <button type="button" className="btn btn-quiet btn-sm" onClick={retire} disabled={busy || getPublicMode()}>{busy ? "Retiring…" : "Retire this rule"}</button>
            )}
          </footer>
        </div>
      )}
    </dialog>
  );
}

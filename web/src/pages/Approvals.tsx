// Approvals: nothing leaves Allevia without the owner's yes. Each draft shows who proposed it, why, what approving will
// actually do, and the draft itself, which the owner can edit first. Edits are kept as learned rules, and the
// first-pass rate (approved without edits) shows the team getting closer week by week.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { AgentAvatar, SimBadge, agentDef } from "../components/bits";
import { Icon } from "../components/Icon";
import { APPROVALS_CHANGED } from "../components/TopBar";
import { ACTION } from "../lib/actions";
import { fmtAgo, fmtDate, fmtPct } from "../lib/format";
import { useApp, useAsync } from "../state/app";
import type { Approval } from "../types-ext";
import "./approvals.css";

type Payload = Approval["payload"];

const OUTCOME: Record<Approval["status"], { text: string; cls: string }> = {
  pending: { text: "Waiting", cls: "badge-gold" },
  approved: { text: "Approved", cls: "badge-ok" },
  edited: { text: "Approved with edits", cls: "badge-ok" },
  executed: { text: "Done", cls: "badge-ok" },
  rejected: { text: "Rejected", cls: "badge-ink" },
  failed: { text: "Failed", cls: "badge-bad" },
};

export default function ApprovalsPage() {
  const { tenant } = useApp();
  const list = useAsync(() => api.approvals(tenant.id), [tenant.id]);
  const recs = useAsync(() => api.recommendations(tenant.id), [tenant.id]);
  const [recent, setRecent] = useState<Set<string>>(new Set());

  useEffect(() => { setRecent(new Set()); }, [tenant.id]);

  // /approvals#appr:… (from Insights) scrolls to that draft once it is on the page
  useEffect(() => {
    if (!list.data || !location.hash) return;
    const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    el?.scrollIntoView({ block: "center" });
    el?.focus({ preventScroll: true });
  }, [list.data]);

  const recTitle = useMemo(() => new Map((recs.data ?? []).map((r) => [r.id, r.title])), [recs.data]);
  const all = list.data ?? [];
  const open = all.filter((a) => a.status === "pending" || recent.has(a.id));
  const history = all.filter((a) => a.status !== "pending").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
  const waiting = all.filter((a) => a.status === "pending").length;
  const decided = history.filter((a) => a.status !== "failed");
  const firstPass = decided.filter((a) => (a.status === "executed" || a.status === "approved") && !a.editedPayload).length;
  const learned = history.filter((a) => a.editedPayload);

  const decide = async (a: Approval, decision: "approve" | "reject", editedPayload?: Payload) => {
    await api.decide(tenant.id, a.id, { decision, editedPayload });
    setRecent((s) => new Set(s).add(a.id));
    window.dispatchEvent(new Event(APPROVALS_CHANGED));
    list.reload();
  };

  return (
    <div className="approvals-page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="page-lede">
            Nothing is published, filed or changed until you approve it. If you edit a draft first, the team keeps your
            change as a rule for next time.
          </p>
        </div>
        <dl className="kpis" aria-label="How the team is doing">
          <div className="kpi">
            <dt>Waiting on you</dt>
            <dd className="num">{waiting}</dd>
          </div>
          <div className="kpi">
            <dt>First-pass approvals</dt>
            <dd className="num">{decided.length ? fmtPct(firstPass / decided.length) : "–"}</dd>
            <p>approved without edits, last 30 days</p>
          </div>
          <div className="kpi">
            <dt>Rules learned</dt>
            <dd className="num">{learned.length}</dd>
          </div>
        </dl>
      </header>

      {list.error && <p className="notice notice-bad" role="alert">Approvals did not load: {list.error}</p>}

      <section className="appr-open" aria-labelledby="open-title">
        <h2 id="open-title" className="section-title">Waiting on you</h2>
        {list.loading && !list.data ? (
          <span className="skeleton" style={{ display: "block", height: 260, marginTop: 12 }} />
        ) : open.length === 0 ? (
          <div className="appr-empty">
            <Icon name="check" size={20} />
            <p>You are all caught up. New drafts appear here as soon as a desk proposes one, and in the morning brief.</p>
          </div>
        ) : (
          <ol className="appr-list">
            {open.map((a) => (
              <ApprovalCard key={a.id} a={a} recTitle={a.recommendationId ? recTitle.get(a.recommendationId) : undefined} onDecide={decide} />
            ))}
          </ol>
        )}
      </section>

      <div className="appr-lower">
        <section aria-labelledby="hist-title">
          <h2 id="hist-title" className="section-title">History</h2>
          {history.length === 0 ? (
            <p className="muted small appr-none">Decisions you make show up here, with what happened next.</p>
          ) : (
            <ol className="ledger">
              {history.map((a) => {
                const k = ACTION[a.kind];
                const o = OUTCOME[a.status];
                return (
                  <li key={a.id} className="ledger-row">
                    <span className="ledger-date num">{fmtDate(a.decidedAt ?? a.createdAt)}</span>
                    <span className="ledger-kind" title={k.label}><Icon name={k.icon} size={16} /><span className="visually-hidden">{k.label}</span></span>
                    <span className="ledger-what">
                      <span className="ledger-title">{(a.editedPayload ?? a.payload).title}</span>
                      <span className="ledger-result">
                        {a.result ?? k.done}
                        {a.editedPayload && <span className="learned-chip"><Icon name="sparkle" size={12} /> Applied: your edit on {fmtDate(a.decidedAt)}</span>}
                      </span>
                    </span>
                    <span className="ledger-by"><AgentAvatar id={a.by} size={20} /><span>{agentDef(a.by)?.name}</span></span>
                    <span className={`badge ${o.cls}`}>{a.status === "executed" && a.editedPayload ? "Done, with your edits" : o.text}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="learned" aria-labelledby="learn-title">
          <h2 id="learn-title" className="section-title">What the team learned from you</h2>
          {learned.length === 0 ? (
            <p className="muted small">
              When you change a draft before approving it, the change becomes a rule the desk follows next time. Rules
              show here, and you can retire any of them.
            </p>
          ) : (
            <ul className="learned-list">
              {learned.map((a) => (
                <li key={a.id}>
                  <AgentAvatar id={a.by} size={24} />
                  <p>
                    <b>{agentDef(a.by)?.name}</b> now starts from your version of “{a.editedPayload!.title}”.
                    <span className="muted"> Learned {fmtDate(a.decidedAt)}.</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function ApprovalCard({ a, recTitle, onDecide }: { a: Approval; recTitle?: string; onDecide: (a: Approval, d: "approve" | "reject", p?: Payload) => Promise<void> }) {
  const k = ACTION[a.kind];
  const who = agentDef(a.by);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Payload>(a.payload);
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<string | null>(null);
  const done = a.status !== "pending";
  const changed = draft.title !== a.payload.title || draft.body !== a.payload.body;
  const shown = a.editedPayload ?? a.payload;

  const go = async (d: "approve" | "reject") => {
    setBusy(d);
    setError(null);
    try {
      await onDecide(a, d, d === "approve" && editing && changed ? draft : undefined);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message || "That did not go through. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <li id={a.id} tabIndex={-1} className={`appr${done ? " is-done" : ""}${editing ? " is-editing" : ""}`} aria-labelledby={`${a.id}-t`}>
      <div className="appr-side">
        <p className="appr-kind">
          <Icon name={k.icon} size={16} /> {k.label}
          {a.simulated && <SimBadge />}
        </p>
        <h3 id={`${a.id}-t`} className="appr-title">{a.title}</h3>
        <p className="appr-from">
          <AgentAvatar id={a.by} size={24} />
          <span>Proposed by <b>{who?.name}</b>, {who?.title} · {fmtAgo(a.createdAt)}</span>
        </p>
        {recTitle && (
          <p className="appr-why">
            Because of: <Link to="/insights">{recTitle}</Link>
          </p>
        )}
        {!done && <p className="appr-effect">{k.effect(a.payload.target)}</p>}
      </div>

      <div className="appr-doc">
        {shown.target && <p className="doc-target"><Icon name={k.icon} size={14} /> {shown.target}</p>}
        {editing ? (
          <>
            <label className="visually-hidden" htmlFor={`${a.id}-title`}>Title</label>
            <input id={`${a.id}-title`} className="field doc-title-field" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <label className="visually-hidden" htmlFor={`${a.id}-body`}>Draft</label>
            <textarea id={`${a.id}-body`} className="field doc-body-field" rows={Math.min(12, Math.max(5, draft.body.split("\n").length + 2))} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </>
        ) : (
          <>
            <p className="doc-title">{shown.title}</p>
            <p className="doc-body">{shown.body}</p>
          </>
        )}
      </div>

      <div className="appr-foot">
        {done ? (
          <div className="appr-stamp" role="status">
            <span className={`stamp${a.status === "rejected" ? " is-rejected" : ""}`}>{a.status === "rejected" ? "Rejected" : a.editedPayload ? "Approved with your edits" : "Approved"}</span>
            <p>{a.result}</p>
            {a.editedPayload && <span className="learned-chip"><Icon name="sparkle" size={12} /> Saved as a rule for {who?.name}</span>}
          </div>
        ) : (
          <div className="appr-actions">
            {editing ? (
              <>
                <button type="button" className="btn btn-gold" onClick={() => go("approve")} disabled={busy !== null || !draft.title.trim()}>
                  <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : changed ? "Approve with edits" : "Approve"}
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => { setEditing(false); setDraft(a.payload); }} disabled={busy !== null}>Cancel</button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-gold" onClick={() => go("approve")} disabled={busy !== null}>
                  <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : "Approve"}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)} disabled={busy !== null}>
                  <Icon name="pen" size={15} /> Edit first
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => go("reject")} disabled={busy !== null}>
                  {busy === "reject" ? "Rejecting…" : "Reject"}
                </button>
              </>
            )}
          </div>
        )}
        {editing && <p className="appr-hint">Your edit becomes a rule {who?.name} follows on the next draft.</p>}
        {error && <p className="notice notice-bad" role="alert">{error}</p>}
      </div>
    </li>
  );
}

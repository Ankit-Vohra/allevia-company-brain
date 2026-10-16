// Waiting for your OK: nothing leaves Allevia without the owner's yes. One draft at a time, as a stack: the top card is
// the one to decide, the next one or two peek out behind it. Each card says who made it, what it is and what happens if
// you say OK; the draft itself, where it goes and why sit behind "Details". An edit becomes a rule the team follows next
// time (the decision's answer carries the `learned` events, shown right after). Decided drafts and the rules your edits
// taught are one quiet tap away below the stack.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { ActionKind, LearnedRuleDto } from "@shared/contracts";
import { api } from "../api";
import { AgentAvatar, agentDef } from "../components/bits";
import { Icon } from "../components/Icon";
import { whenWords, withoutSim } from "../components/insights-words";
import { LearnedChips, LearnedPathDialog, RuleRow, ruleClause } from "../components/Learning";
import { Reveal } from "../components/Reveal";
import { APPROVALS_CHANGED } from "../components/TopBar";
import { ACTION } from "../lib/actions";
import { wordDiff } from "../lib/diff";
import { useApp, useAsync } from "../state/app";
import type { Approval, LearnedEvent } from "../types-ext";
import { TEAM_CHANGED } from "./Office";
import "./approvals.css";

type Payload = Approval["payload"];

/** What each kind of draft is called to an owner, and what saying OK does, in plain words. */
const KIND: Record<ActionKind, { label: string; effect: (target?: string) => string; done: string }> = {
  github_issue: { label: "A fix for your website", effect: () => "If you say OK, this goes to whoever builds your website as a to-do. Nothing on the site changes yet.", done: "Sent to whoever builds your website." },
  content_draft: { label: "A post draft", effect: () => "If you say OK, the draft is saved for you. Nothing is posted.", done: "Draft saved. Nothing was posted." },
  pause_ad: { label: "A change to an ad", effect: () => "If you say OK, the change is made to the ad. You can undo it from your ad account any time.", done: "The change was made." },
  discord_post: { label: "A message to your team chat", effect: (t) => `If you say OK, this is posted${t ? ` to ${t}` : ""}.`, done: "Posted." },
};

const OUTCOME: Record<Approval["status"], { text: string; cls: string }> = {
  pending: { text: "Waiting for your OK", cls: "is-wait" },
  approved: { text: "Approved", cls: "is-ok" },
  edited: { text: "Approved with your edits", cls: "is-ok" },
  executed: { text: "Done", cls: "is-ok" },
  rejected: { text: "You said no", cls: "is-no" },
  failed: { text: "Did not go through", cls: "is-bad" },
};

interface Last { id: string; title: string; kind: ActionKind; outcome: "approved" | "edited" | "rejected" }

export default function ApprovalsPage() {
  const { tenant } = useApp();
  const list = useAsync(() => api.approvals(tenant.id), [tenant.id]);
  const recs = useAsync(() => api.recommendations(tenant.id), [tenant.id]);
  const feed = useAsync(() => api.learning(tenant.id).catch(() => null), [tenant.id]);
  const [recent, setRecent] = useState<Set<string>>(new Set());
  // what each decision taught, from POST /approvals/:id's `learned` events (for the drafts decided on this visit)
  const [taught, setTaught] = useState<Record<string, LearnedEvent[]>>({});
  const [last, setLast] = useState<Last | null>(null);
  const [openRule, setOpenRule] = useState<LearnedRuleDto | null>(null);
  const [hash, setHash] = useState(() => safeDecode(location.hash.slice(1)));

  useEffect(() => { setRecent(new Set()); setTaught({}); setLast(null); }, [tenant.id]);
  useEffect(() => {
    const on = () => setHash(safeDecode(location.hash.slice(1)));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const recTitle = useMemo(() => new Map((recs.data ?? []).map((r) => [r.id, r.title])), [recs.data]);
  const all = list.data ?? [];
  // /approvals#appr:… (from Insights and Ask) puts that draft on top of the stack
  // (not memoised: the mock API edits its cards in place, so the list's identity does not change when a card is decided)
  const pending = all.filter((a) => a.status === "pending");
  const at = pending.findIndex((a) => a.id === hash);
  const stack = at > 0 ? [pending[at]!, ...pending.slice(0, at), ...pending.slice(at + 1)] : pending;
  const history = all.filter((a) => a.status !== "pending").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
  const approvedCount = history.filter((a) => a.status === "executed" || a.status === "approved" || a.status === "edited").length;
  const top = stack[0];
  const handled = [...recent].filter((id) => !stack.some((a) => a.id === id)).length;
  const rules = feed.data?.rules ?? [];
  const rulesFrom = useMemo(() => {
    const m = new Map<string, LearnedRuleDto[]>();
    for (const r of rules) for (const id of r.fromApprovalIds) m.set(id, [...(m.get(id) ?? []), r]);
    return m;
  }, [rules]);

  useEffect(() => {
    if (!top || !hash || top.id !== hash) return;
    document.getElementById(top.id)?.focus({ preventScroll: true });
  }, [top?.id, hash]);

  const decide = async (a: Approval, decision: "approve" | "reject", editedPayload?: Payload) => {
    const out = await api.decide(tenant.id, a.id, { decision, editedPayload });
    setTaught((t) => ({ ...t, [a.id]: out.learned ?? [] }));
    setRecent((s) => new Set(s).add(a.id));
    setLast({ id: a.id, title: withoutSim(a.title), kind: a.kind, outcome: decision === "reject" ? "rejected" : editedPayload ? "edited" : "approved" });
    window.dispatchEvent(new Event(APPROVALS_CHANGED));
    if (out.learned?.length) window.dispatchEvent(new Event(TEAM_CHANGED));
    list.reload();
    feed.reload();
  };
  const retire = async (id: string) => {
    await api.retireRule(tenant.id, id);
    feed.reload();
    window.dispatchEvent(new Event(TEAM_CHANGED));
  };

  const peeks = Math.min(2, Math.max(0, stack.length - 1));

  return (
    <div className="approvals-page">
      <header className="appr-head">
        <h1 className="page-title">Waiting for your OK</h1>
        <p className="page-lede">Nothing goes out until you say OK. If you change a draft first, your team remembers it for next time.</p>
        {!list.loading && (
          <p className="appr-tally" aria-label="Where things stand">
            <b className="num">{stack.length}</b> waiting{approvedCount > 0 && <> · <b className="num">{approvedCount}</b> approved so far</>}
          </p>
        )}
      </header>

      {list.error && <p className="notice notice-bad" role="alert">Your drafts did not load: {list.error}</p>}

      <section className="appr-stage" aria-label="Drafts waiting for your OK">
        {list.loading && !list.data ? (
          <span className="skeleton" style={{ display: "block", height: 280 }} />
        ) : top ? (
          <>
            <p className="appr-count num" aria-live="polite">{handled + 1} of {handled + stack.length}</p>
            <div className={`appr-stack peeks-${peeks}`}>
              {peeks > 1 && <div className="appr-peek is-far" aria-hidden="true" />}
              {peeks > 0 && <div className="appr-peek is-near" aria-hidden="true" />}
              <ApprovalCard key={top.id} a={top} advanced={recent.size > 0} recTitle={top.recommendationId ? recTitle.get(top.recommendationId) : undefined} onDecide={decide} tz={tenant.timeZone} locale={tenant.locale} />
            </div>
          </>
        ) : null}

        {last && (
          <div className="appr-last" role="status">
            <p className="appr-last-line">
              <Icon name={last.outcome === "rejected" ? "x" : "check"} size={15} />
              <span><b>{last.outcome === "rejected" ? "You said no" : last.outcome === "edited" ? "Approved with your edits" : "Approved"}</b>: {last.title}</span>
            </p>
            <p className="small muted">{last.outcome === "rejected" ? "Nothing was changed." : KIND[last.kind].done}</p>
            <LearnedChips events={taught[last.id]} edited={last.outcome === "edited"} />
          </div>
        )}

        {!list.loading && list.data && !top && (
          <div className="appr-empty">
            <span className="appr-empty-icon" aria-hidden="true"><Icon name="check" size={22} /></span>
            <h2 className="appr-empty-title">Nothing needs you right now</h2>
            <p>Your team will leave new drafts here as soon as they have one. Until then, see what we noticed this week.</p>
            <Link className="btn btn-ghost" to="/insights">See what we noticed</Link>
          </div>
        )}
      </section>

      <div className="appr-more">
        <Reveal tone="row" label="Recently decided" summary={history.length ? `${history.length}` : "none yet"}>
          {history.length === 0 ? (
            <p className="muted small appr-none">What you decide shows up here, with what happened next.</p>
          ) : (
            <ol className="ledger">
              {history.map((a) => {
                const o = OUTCOME[a.status];
                return (
                  <li key={a.id} className="ledger-row">
                    <span className="ledger-what">
                      <span className="ledger-title">{withoutSim((a.editedPayload ?? a.payload).title)}</span>
                      <span className="ledger-result">
                        <AgentAvatar id={a.by} size={16} /> {agentDef(a.by)?.name} · {whenWords(a.decidedAt ?? a.createdAt, tenant.timeZone, tenant.locale)}
                        {a.editedPayload && (() => {
                          const r = rulesFrom.get(a.id)?.[0];
                          return r
                            ? <button type="button" className="learned-chip" onClick={() => setOpenRule(r)} title="See what was learned and where it came from"><Icon name="sparkle" size={12} /> Learned: {ruleClause(r.text)}</button>
                            : <span className="learned-chip is-quiet"><Icon name="pen" size={12} /> You edited it</span>;
                        })()}
                      </span>
                      {a.editedPayload && (
                        <Reveal className="ledger-edit" label="See what you changed">
                          <p className="doc-body"><Marked a={`${a.payload.title}\n${a.payload.body}`} b={`${a.editedPayload.title}\n${a.editedPayload.body}`} /></p>
                        </Reveal>
                      )}
                    </span>
                    <span className={`ledger-out ${o.cls}`}>{a.status === "executed" && a.editedPayload ? "Done, with your edits" : o.text}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </Reveal>

        <Reveal tone="row" label="Things your team learned from your edits" summary={feed.data && feed.data.active > 0 ? `${feed.data.active} in use` : "none yet"}>
          {feed.loading && !feed.data ? (
            <span className="skeleton" style={{ display: "block", height: 100 }} />
          ) : rules.length === 0 ? (
            <p className="muted small appr-none">When you change a draft before approving it, the change becomes a habit your team keeps. It shows up here, and you can retire any of them.</p>
          ) : (
            <>
              <ul className="learned-feed">
                {rules.slice(0, 12).map((r) => <RuleRow key={r.id} rule={r} onRetire={retire} onOpen={(id) => setOpenRule(rules.find((x) => x.id === id) ?? null)} />)}
              </ul>
              <p className="small muted appr-none">Each one is a book on Sara’s shelf in the office. <Link to="/team">See everyone’s habits</Link></p>
            </>
          )}
        </Reveal>
      </div>
      <LearnedPathDialog rule={openRule} onClose={() => setOpenRule(null)} onRetired={() => { feed.reload(); window.dispatchEvent(new Event(TEAM_CHANGED)); }} />
    </div>
  );
}

function safeDecode(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function ApprovalCard({ a, advanced, recTitle, onDecide, tz, locale }: { a: Approval; advanced: boolean; recTitle?: string; onDecide: (a: Approval, d: "approve" | "reject", p?: Payload) => Promise<void>; tz?: string; locale?: string }) {
  const k = KIND[a.kind];
  const who = agentDef(a.by);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Payload>(a.payload);
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<string | null>(null);
  const changed = draft.title !== a.payload.title || draft.body !== a.payload.body;

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
    <article id={a.id} tabIndex={-1} className={`appr-card${editing ? " is-editing" : ""}${advanced ? " is-next" : ""}`} aria-labelledby={`${a.id}-t`}>
      <p className="appr-kind">
        <Icon name={ACTION[a.kind].icon} size={15} /> {k.label}
        {a.simulated && <span className="sample-tag">sample numbers</span>}
      </p>
      <h2 id={`${a.id}-t`} className="appr-title">{withoutSim(a.title)}</h2>
      <p className="appr-from">
        <AgentAvatar id={a.by} size={24} />
        <span><b>{who?.name}</b>{who ? `, ${who.title.toLowerCase()}` : ""} · {whenWords(a.createdAt, tz, locale)}</span>
      </p>

      {editing ? (
        <div className="appr-edit">
          <label className="visually-hidden" htmlFor={`${a.id}-title`}>Title</label>
          <input id={`${a.id}-title`} className="field doc-title-field" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <label className="visually-hidden" htmlFor={`${a.id}-body`}>Draft</label>
          <textarea id={`${a.id}-body`} className="field doc-body-field" rows={Math.min(12, Math.max(5, draft.body.split("\n").length + 2))} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <p className="appr-hint">Your change becomes a habit {who?.name} keeps on the next draft.</p>
        </div>
      ) : (
        <>
          <p className="appr-effect">{k.effect(a.payload.target)}</p>
          <Reveal className="appr-details" label="Details" summary="the full draft and where it goes">
            <div className="appr-detail">
              {a.payload.target && (
                <>
                  <p className="detail-k">Where it goes</p>
                  <p className="detail-target"><Icon name={ACTION[a.kind].icon} size={13} /> {a.payload.target}</p>
                </>
              )}
              <p className="detail-k">The draft</p>
              <p className="doc-title">{a.payload.title}</p>
              <p className="doc-body">{a.payload.body.replace(/^Evidence: .*$/gm, "").replace(/\n{3,}/g, "\n\n").trim()}</p>
              {recTitle && <p className="detail-why">Why: <Link to="/insights">{withoutSim(recTitle)}</Link></p>}
            </div>
          </Reveal>
        </>
      )}

      <div className="appr-actions">
        {editing ? (
          <>
            <button type="button" className="btn btn-gold appr-yes" onClick={() => go("approve")} disabled={busy !== null || !draft.title.trim()}>
              <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : changed ? "Approve with edits" : "Approve"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => { setEditing(false); setDraft(a.payload); }} disabled={busy !== null}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-gold appr-yes" onClick={() => go("approve")} disabled={busy !== null}>
              <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)} disabled={busy !== null}>
              <Icon name="pen" size={15} /> Change
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => go("reject")} disabled={busy !== null}>
              {busy === "reject" ? "Saying no…" : "No thanks"}
            </button>
          </>
        )}
      </div>
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
    </article>
  );
}

/** The owner's edit, marked in place: what was cut and what was written instead. */
function Marked({ a, b }: { a: string; b: string }) {
  if (a === b) return <>{b}</>;
  return <>{wordDiff(a, b).map((p, i) => (p.kind === "same" ? <span key={i}>{p.text}</span> : p.kind === "del" ? <del key={i} className="doc-del">{p.text}</del> : <ins key={i} className="doc-ins">{p.text}</ins>))}</>;
}

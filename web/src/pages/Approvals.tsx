// Needs your OK: nothing leaves Allevia without the owner's yes. Every draft is one compact row (what it is, who made
// it, how big) with OK and Look; the same idea drafted on several mornings is one row with "×3" (the newest is the one acted
// on, the earlier ones open under it), and anything over a week old sits under one folded "Older" row; Look opens the whole draft in a sheet with Approve, Change and No thanks, the same call as
// Home and the Discord buttons. An edit becomes a habit the team keeps (said right after). Your posts, what you decided and
// what your edits taught sit folded below. /approvals#appr:… (from Insights and the chat) opens that draft at once.
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { LearnedRuleDto } from "@shared/contracts";
import { api, getPublicMode } from "../api";
import { ApprovalRow, Decided } from "../components/approval/ApprovalRow";
import { decideDraft, type Done, type Payload } from "../components/approval/decide";
import { DraftView } from "../components/approval/Draft";
import { AgentAvatar, agentDef } from "../components/bits";
import { Icon } from "../components/Icon";
import { stakeOf, whenWords, withoutSim } from "../components/insights-words";
import { LearnedPathDialog, RuleRow, ruleClause } from "../components/Learning";
import { PostsList } from "../components/PostsList";
import { Reveal } from "../components/Reveal";
import { Sheet } from "../components/Sheet";
import { wordDiff } from "../lib/diff";
import { fmtMoney } from "../lib/format";
import { groupDrafts, splitOlder } from "../lib/group";
import { plainTitle } from "../lib/home";
import { TEAM_CHANGED } from "../lib/office-shared";
import { useApp, useAsync } from "../state/app";
import type { Approval, PostView } from "../types-ext";
import "./approvals.css";

const OUTCOME: Record<Approval["status"], { text: string; cls: string }> = {
  pending: { text: "Waiting", cls: "is-wait" },
  approved: { text: "Approved", cls: "is-ok" },
  edited: { text: "Approved, edited", cls: "is-ok" },
  executed: { text: "Done", cls: "is-ok" },
  rejected: { text: "You said no", cls: "is-no" },
  failed: { text: "Did not go through", cls: "is-bad" },
};

export default function ApprovalsPage() {
  const { tenant } = useApp();
  const list = useAsync(() => api.approvals(tenant.id), [tenant.id]);
  const recs = useAsync(() => api.recommendations(tenant.id).catch(() => []), [tenant.id]);
  const feed = useAsync(() => api.learning(tenant.id).catch(() => null), [tenant.id]);
  const posts = useAsync(() => api.publishPosts(tenant.id).catch(() => [] as PostView[]), [tenant.id]);
  const [last, setLast] = useState<Done | null>(null);
  const [look, setLook] = useState<string | null>(() => safeDecode(location.hash.slice(1)) || null);
  const [openRule, setOpenRule] = useState<LearnedRuleDto | null>(null);
  const readOnly = getPublicMode();

  useEffect(() => { setLast(null); }, [tenant.id]);
  useEffect(() => {
    const on = () => setLook(safeDecode(location.hash.slice(1)) || null);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const stakes = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of recs.data ?? []) {
      if (!r.approvalId) continue;
      const s = stakeOf(r, fmtMoney);
      m.set(r.approvalId, s.small ? `${s.big} ${s.small}` : s.big);
    }
    return m;
  }, [recs.data]);
  // not memoised: the mock API edits its cards in place, so the list's identity does not change when a card is decided
  const all = list.data ?? [];
  const pending = all.filter((a) => a.status === "pending");
  // newest first, then folded: one row per idea, this week's on top and the rest under Older
  const groups = groupDrafts([...pending].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  const { recent, older } = splitOlder(groups, (a) => a.createdAt);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (id: string) => setOpenGroups((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const rows = (gs: typeof groups) => (
    <ul className="ap-list">
      {gs.map((g) => (
        <Fragment key={g.lead.id}>
          <ApprovalRow
            a={g.lead} stake={stakes.get(g.lead.id)} readOnly={readOnly} onOk={(x) => decide(x, "approve")} onLook={(x) => setLook(x.id)}
            repeats={g.items.length} repeatsOpen={openGroups.has(g.lead.id)} onRepeats={() => toggleGroup(g.lead.id)}
          />
          {openGroups.has(g.lead.id) && (
            <li className="ap-earlier">
              <ul className="ap-list" aria-label="Earlier drafts of the same idea">
                {g.items.slice(1).map((a) => (
                  <ApprovalRow key={a.id} a={a} stake={stakes.get(a.id)} readOnly={readOnly} onOk={(x) => decide(x, "approve")} onLook={(x) => setLook(x.id)} />
                ))}
              </ul>
            </li>
          )}
        </Fragment>
      ))}
    </ul>
  );
  const decided = all.filter((a) => a.status !== "pending").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
  const open = pending.find((a) => a.id === look);
  const rules = feed.data?.rules ?? [];
  const rulesFrom = useMemo(() => {
    const m = new Map<string, LearnedRuleDto[]>();
    for (const r of rules) for (const id of r.fromApprovalIds) m.set(id, [...(m.get(id) ?? []), r]);
    return m;
  }, [rules]);

  const close = () => {
    setLook(null);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  };
  const decide = async (a: Approval, decision: "approve" | "reject", edited?: Payload) => {
    const d = await decideDraft(tenant.id, a, decision, edited);
    setLast(d);
    close();
    posts.reload();
    list.reload();
    feed.reload();
  };
  const retire = async (id: string) => {
    await api.retireRule(tenant.id, id);
    feed.reload();
    window.dispatchEvent(new Event(TEAM_CHANGED));
  };

  return (
    <div className="approvals-page">
      <header className="appr-head">
        <h1 className="page-title">Needs your OK</h1>
      </header>

      {list.error && <p className="notice notice-bad" role="alert">Your drafts did not load: {list.error}</p>}

      {last && <Decided d={last} tenantId={tenant.id} onPost={(p) => { setLast({ ...last, post: p }); posts.reload(); }} />}

      <section className="appr-list" aria-label="Drafts waiting for your OK">
        {list.loading && !list.data ? (
          <span className="skeleton" style={{ display: "block", height: 160 }} />
        ) : pending.length > 0 ? (
          <>
            {rows(recent)}
            {older.length > 0 && (
              <Reveal className="ap-older" tone="row" label={`Older (${older.length})`} defaultOpen={recent.length === 0}>
                {rows(older)}
              </Reveal>
            )}
          </>
        ) : list.data ? (
          <div className="appr-empty">
            <span className="appr-empty-icon" aria-hidden="true"><Icon name="check" size={20} /></span>
            <h2 className="appr-empty-title">Nothing needs you right now</h2>
            <Link className="btn btn-ghost" to="/insights">See the ideas</Link>
          </div>
        ) : null}
      </section>

      <div className="appr-more">
        <Reveal tone="row" label="Your posts" summary={posts.data?.length ? `${posts.data.filter((p) => p.status === "scheduled").length} set for later` : "none yet"}>
          <PostsList tenantId={tenant.id} posts={posts.data ?? []} onChanged={posts.reload} />
        </Reveal>

        <Reveal tone="row" label="Decided" summary={decided.length ? `${decided.length}` : "none yet"}>
          {decided.length === 0 ? (
            <p className="muted small appr-none">What you decide shows up here.</p>
          ) : (
            <ol className="ledger">
              {decided.map((a) => {
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
                            ? <button type="button" className="learned-chip" onClick={() => setOpenRule(r)} title="What was learned and where it came from"><Icon name="sparkle" size={12} /> Learned: {ruleClause(r.text)}</button>
                            : <span className="learned-chip is-quiet"><Icon name="pen" size={12} /> You edited it</span>;
                        })()}
                      </span>
                      {a.editedPayload && (
                        <Reveal className="ledger-edit" label="What you changed">
                          <p className="doc-body"><Marked a={`${a.payload.title}\n${a.payload.body}`} b={`${a.editedPayload.title}\n${a.editedPayload.body}`} /></p>
                        </Reveal>
                      )}
                    </span>
                    <span className={`ledger-out ${o.cls}`}>{a.status === "executed" && a.editedPayload ? "Done, edited" : o.text}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </Reveal>

        <Reveal tone="row" label="Learned from your edits" summary={feed.data && feed.data.active > 0 ? `${feed.data.active} in use` : "none yet"}>
          {feed.loading && !feed.data ? (
            <span className="skeleton" style={{ display: "block", height: 100 }} />
          ) : rules.length === 0 ? (
            <p className="muted small appr-none">Change a draft before you OK it, and your team keeps the change as a habit.</p>
          ) : (
            <>
              <ul className="learned-feed">
                {rules.slice(0, 12).map((r) => <RuleRow key={r.id} rule={r} onRetire={retire} onOpen={(id) => setOpenRule(rules.find((x) => x.id === id) ?? null)} />)}
              </ul>
              <p className="small muted appr-none"><Link to="/team">Everyone's habits</Link></p>
            </>
          )}
        </Reveal>
      </div>

      <Sheet open={!!open} onClose={close} label={open ? plainTitle(open.title) : "Draft"}>
        {open && (
          <DraftView
            key={open.id} a={open} why={open.preview?.why} stake={stakes.get(open.id)}
            tz={tenant.timeZone} locale={tenant.locale} tenantId={tenant.id} readOnly={readOnly} onDecide={decide}
          />
        )}
      </Sheet>
      <LearnedPathDialog rule={openRule} onClose={() => setOpenRule(null)} onRetired={() => { feed.reload(); window.dispatchEvent(new Event(TEAM_CHANGED)); }} />
    </div>
  );
}

function safeDecode(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** The owner's edit, marked in place: what was cut and what was written instead. */
function Marked({ a, b }: { a: string; b: string }) {
  if (a === b) return <>{b}</>;
  return <>{wordDiff(a, b).map((p, i) => (p.kind === "same" ? <span key={i}>{p.text}</span> : p.kind === "del" ? <del key={i} className="doc-del">{p.text}</del> : <ins key={i} className="doc-ins">{p.text}</ins>))}</>;
}

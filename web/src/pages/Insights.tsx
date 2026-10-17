// What we noticed: the team's ideas, best first, one line each (what it is, who suggests it, how big). A tap opens the idea in a
// sheet: why, what is at stake, the one next step, and the reasoning (the sources and the chain of facts) behind "Why we think
// this". Today's note from Meera sits on top in one line, the whole note one tap away; where the numbers come from is at the
// bottom, and sample numbers are always said out loud (docs/owner-words.md).
import { useMemo, useState } from "react";
import type { NodeRef } from "@shared/contracts";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { AgentAvatar, agentDef } from "../components/bits";
import { EvidenceChain } from "../components/EvidenceChain";
import { Icon } from "../components/Icon";
import { firstSentence, likelihood, stakeOf, whenWords, withoutCites, withoutSim } from "../components/insights-words";
import { Markdown } from "../components/Markdown";
import { Reveal } from "../components/Reveal";
import { Sheet } from "../components/Sheet";
import { fmtMoney } from "../lib/format";
import { briefFirstLine } from "../lib/home";
import { useApp, useAsync } from "../state/app";
import type { Approval, Freshness, Recommendation } from "../types-ext";
import "../components/approval/approval.css";
import "./insights.css";

const TOP = 5;

/** The note's first paragraph as plain words, for the one line on top. */
const firstLine = briefFirstLine;

export default function InsightsPage() {
  const { tenant } = useApp();
  const nav = useNavigate();
  const overview = useAsync(() => api.overview(tenant.id), [tenant.id]);
  const recs = useAsync(() => api.recommendations(tenant.id), [tenant.id]);
  const approvals = useAsync(() => api.approvals(tenant.id), [tenant.id]);
  const graph = useAsync(() => api.graphOverview(tenant.id), [tenant.id]);
  const [all, setAll] = useState(false);
  const [look, setLook] = useState<string | null>(null);

  // names for source chips: the graph overview, plus every node a recommendation already carries
  const names = useMemo(() => {
    const m: Record<string, NodeRef> = {};
    for (const n of graph.data?.nodes ?? []) m[n.id] = n;
    for (const r of recs.data ?? []) for (const n of r.evidence) m[n.id] ??= n;
    return m;
  }, [graph.data, recs.data]);
  const byApproval = useMemo(() => new Map((approvals.data ?? []).map((a) => [a.id, a])), [approvals.data]);
  const sorted = useMemo(() => [...(recs.data ?? [])].sort((a, b) => b.score - a.score), [recs.data]);
  const shown = all ? sorted : sorted.slice(0, TOP);
  const waiting = sorted.filter((r) => r.approvalId && byApproval.get(r.approvalId)?.status === "pending").length;
  const samples = (overview.data?.freshness ?? []).filter((f) => f.note === "simulated").map((f) => f.source);
  const hasSamples = samples.length > 0 || sorted.some((r) => r.simulated);
  const open = sorted.find((r) => r.id === look);
  const openRank = open ? sorted.indexOf(open) + 1 : 0;

  const openNode = (id: string) => nav(`/brain?node=${encodeURIComponent(id)}`);

  return (
    <div className="insights-page">
      <header className="ins-head">
        <h1 className="page-title">What we noticed</h1>
        <p className="ins-tally">
          {sorted.length ? (
            <span>
              <b className="num">{sorted.length}</b> {sorted.length === 1 ? "idea" : "ideas"}
              {waiting > 0 && <> · <Link to="/approvals"><b className="num">{waiting}</b> waiting for your OK</Link></>}
            </span>
          ) : <span>{recs.loading ? "Looking at the latest numbers…" : "Nothing to suggest yet."}</span>}
          {hasSamples && <span className="sample-tag" title={samples.length ? `Sample numbers from ${samples.join(", ")}` : "Some numbers are samples"}>sample numbers</span>}
        </p>
      </header>

      <TodayNote brief={overview.data?.brief} loading={overview.loading && !overview.data} names={names} onOpen={openNode} />

      {recs.error && <p className="notice notice-bad" role="alert">Ideas did not load: {recs.error}</p>}
      {recs.loading && !recs.data && (
        <div className="ideas" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} className="skeleton idea-skel" />)}</div>
      )}

      {sorted.length > 0 && (
        <section aria-label="Ideas, best first">
          <ol className="ideas">
            {shown.map((r, i) => (
              <IdeaRow key={r.id} rec={r} rank={i + 1} approval={r.approvalId ? byApproval.get(r.approvalId) : undefined} onOpen={() => setLook(r.id)} />
            ))}
          </ol>
          {sorted.length > TOP && (
            <button type="button" className="ideas-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? `Show the top ${TOP}` : `See all ${sorted.length}`}
              <Icon name="chevron" size={16} className={all ? "is-up" : undefined} />
            </button>
          )}
        </section>
      )}

      {overview.data && overview.data.freshness.length > 0 && (
        <Reveal className="ins-sources" label="Where this comes from" summary={`${overview.data.freshness.length} sources`}>
          <ul className="source-list">
            {overview.data.freshness.map((f) => <SourceRow key={f.source} f={f} tz={tenant.timeZone} locale={tenant.locale} />)}
          </ul>
        </Reveal>
      )}

      <Sheet open={!!open} onClose={() => setLook(null)} label={open ? withoutSim(open.title) : "Idea"}>
        {open && <IdeaView rec={open} rank={openRank} approval={open.approvalId ? byApproval.get(open.approvalId) : undefined} onOpen={openNode} names={names} tz={tenant.timeZone} locale={tenant.locale} />}
      </Sheet>
    </div>
  );
}

function TodayNote({ brief, loading, names, onOpen }: { brief?: string; loading: boolean; names: Record<string, NodeRef>; onOpen: (id: string) => void }) {
  if (!loading && !brief) return null;
  return (
    <section className="note" aria-labelledby="note-title">
      <div className="note-head">
        <AgentAvatar id="chief-of-staff" size={26} />
        <h2 id="note-title" className="note-title">Today’s note</h2>
        <span className="small muted">from Meera</span>
      </div>
      {loading || !brief ? (
        <span className="skeleton" style={{ display: "block", height: 44 }} />
      ) : (
        <>
          <p className="note-line">{firstLine(brief)}</p>
          <Reveal label="Read it all">
            <Markdown className="note-md" text={withoutCites(brief)} />
            <Reveal label="How we know" summary="the sources">
              <Markdown className="note-md note-md-cited" text={brief} onCite={onOpen} nodes={names} />
            </Reveal>
          </Reveal>
        </>
      )}
    </section>
  );
}

function SourceRow({ f, tz, locale }: { f: Freshness; tz?: string; locale?: string }) {
  const sim = f.note === "simulated";
  return (
    <li className="source-row">
      <span className={`source-dot is-${f.status}`} aria-hidden="true" />
      <span className="source-name">{f.source}</span>
      {sim && <span className="sample-tag">sample numbers</span>}
      <span className="source-asof">{f.status === "error" ? "Can’t reach it right now" : `updated ${whenWords(f.asOf, tz, locale)}`}</span>
    </li>
  );
}

/** One idea in one line: the rank, what it is, who suggests it and how big. */
function IdeaRow({ rec: r, rank, approval, onOpen }: { rec: Recommendation; rank: number; approval?: Approval; onOpen: () => void }) {
  const s = stakeOf(r, fmtMoney);
  const waiting = approval?.status === "pending";
  return (
    <li className={`idea-row${r.status === "dismissed" ? " is-dismissed" : ""}`}>
      <button type="button" className="idea-line" onClick={onOpen}>
        <span className="idea-rank" aria-label={`Number ${rank}`}>{rank}</span>
        <span className="idea-text">
          <span className="idea-title">{withoutSim(r.title)}</span>
          <span className="idea-meta">
            <AgentAvatar id={r.by} size={16} />
            <span>{agentDef(r.by)?.name ?? "Your team"}</span>
            {s.big && <b className="idea-size">{s.big}{s.small ? ` ${s.small}` : ""}</b>}
            {waiting && <span className="ap-badge">Draft waiting</span>}
            {r.simulated && <span className="ap-sample">sample</span>}
          </span>
        </span>
        <Icon name="chevron-right" size={16} className="idea-go" />
      </button>
    </li>
  );
}

/** The idea in full, in the sheet: why, what is at stake, the next step, and the reasoning behind "Why we think this". */
function IdeaView({ rec: r, rank, approval, onOpen, names, tz, locale }: { rec: Recommendation; rank: number; approval?: Approval; onOpen: (id: string) => void; names: Record<string, NodeRef>; tz?: string; locale?: string }) {
  const a = agentDef(r.by);
  const s = stakeOf(r, fmtMoney);
  const waiting = approval?.status === "pending";
  const decided = approval && approval.status !== "pending";
  const askQ = `${withoutSim(r.title)}: what would it take, and what could go wrong?`;
  return (
    <article className="idea" aria-labelledby="idea-sheet-t">
      <p className="idea-by">
        <span className="idea-rank-sm num">#{rank}</span>
        <AgentAvatar id={r.by} size={22} />
        <span><b>{a?.name ?? "Your team"}</b> · {whenWords(r.createdAt, tz, locale)}</span>
      </p>
      <h2 id="idea-sheet-t" className="idea-title-lg">{withoutSim(r.title)}</h2>
      <p className="idea-why">{withoutCites(firstSentence(r.why))}</p>
      <p className="idea-stake">
        <span className="idea-stake-k">{s.label}</span>
        <span className="idea-stake-v">{s.big}</span>
        {s.small && <span className="idea-stake-s">{s.small}</span>}
        {r.simulated && <span className="sample-tag">sample numbers</span>}
      </p>
      <div className="idea-actions">
        {waiting ? (
          <Link className="btn btn-gold" to={`/approvals#${encodeURIComponent(approval!.id)}`}>Review the draft</Link>
        ) : decided ? (
          <span className={`idea-decided${approval!.status === "rejected" ? " is-no" : ""}`}>
            <Icon name={approval!.status === "rejected" ? "x" : "check"} size={14} />
            {approval!.status === "rejected" ? "You said no to the draft" : "You said OK"}
          </span>
        ) : (
          <Link className="btn btn-ghost" to={`/ask?q=${encodeURIComponent(askQ)}`}>Ask {a?.name ?? "your team"} about it</Link>
        )}
      </div>
      <Reveal className="idea-reveal" label="Why we think this" summary={`${likelihood(r.confidence)} · ${r.evidence.length} ${r.evidence.length === 1 ? "source" : "sources"}`}>
        <div className="idea-proof">
          <Markdown className="idea-proof-md" text={r.why} onCite={onOpen} nodes={names} />
          {r.evidence.length > 0 && (
            <>
              <p className="idea-proof-h">How the facts connect</p>
              <EvidenceChain nodes={r.evidence} edges={r.evidenceEdges} onOpen={onOpen} label={`How we know: ${withoutSim(r.title)}`} />
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => onOpen(r.evidence[0]?.id ?? "")}>
                <Icon name="brain" size={15} /> Open in your company brain
              </button>
            </>
          )}
        </div>
      </Reveal>
    </article>
  );
}

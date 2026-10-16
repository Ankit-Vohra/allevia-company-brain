// One exchange in the chat: what the owner said, then the reply. In a team chat the reply shows what each person added (with
// their avatar and name), then Meera's answer; in a direct chat it is that person's answer. Everything about how it was
// reached sits behind one "How we got this" line. Waiting-for-OK cards and made things (posters, drafts) appear inline.
import { useState } from "react";
import { useNavigate } from "react-router";
import type { AgentId } from "@shared/contracts";
import { api } from "../../api";
import { agentDef, AgentAvatar, SimBadge, fmtDate, fmtMs } from "../bits";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { MadeCard, QuickReplies } from "../MadeCard";
import { Reveal } from "../Reveal";
import { APPROVALS_CHANGED } from "../TopBar";
import { CHIEF, TEAM, type Who, checksPass, contributions, doorWords, howWeGotThis, teamTalk, workingNow } from "../../lib/chat";
import { humanDates, plain } from "../../lib/words";
import type { RunView } from "../../state/derive";
import type { Approval } from "../../types-ext";
import type { TurnItem } from "./useThread";

const nameOf = (id: AgentId) => agentDef(id)?.name ?? id;
const jobOf = (id: AgentId) => agentDef(id)?.title ?? "";
const KIND: Record<Approval["kind"], string> = {
  content_draft: "A post draft", github_issue: "A fix for your website", pause_ad: "Pausing an ad", discord_post: "A message to your team channel",
  calendar_event: "A meeting on your calendar", email_send: "An email from your address", connection_action: "A change in one of your tools",
};

export interface TurnProps {
  turn: TurnItem;
  view: RunView;
  who: Who;
  tenantId: string;
  latest: boolean;
  talk: boolean;
  approvals: Map<string, Approval>;
  onApprovalChanged: (a: Approval) => void;
  onPrefill: (text: string) => void;
  onSend: (text: string) => void;
  onReplay: () => void;
  onRetry: () => void;
}

export function ChatTurn(p: TurnProps) {
  const { turn, view, who, latest } = p;
  const nav = useNavigate();
  const live = turn.status === "running";
  const direct = who !== TEAM;
  const answerBy: AgentId = view.answerer ?? (direct ? who : CHIEF);
  const notes = direct ? [] : contributions(turn.events);
  const lines = !direct && p.talk ? teamTalk(turn.events) : [];
  const door = doorWords(turn.record?.source);
  const answered = turn.status !== "stopped" && (view.answerStarted || (!!view.final && !!view.answer.trim()));
  const working = workingNow(turn.events).filter((a) => a !== CHIEF || !view.answerStarted);
  const madeIds = new Set(view.made.map((m) => m.approvalId));
  const proposals = view.proposals.filter((x) => !madeIds.has(x.approvalId));
  const how = howWeGotThis(turn.events, view.final);
  const ok = !!view.final && checksPass(view.final.checks);
  const cite = (id: string) => nav(`/brain?node=${encodeURIComponent(id)}`);

  return (
    <li className={`ct-turn${live ? " is-live" : ""}`}>
      <div className="ct-you">
        <p className="ct-you-text">{turn.question}</p>
        <p className="ct-you-meta">
          {turn.at && <span>{fmtDate(turn.at, true)}</span>}
          {door && <span className="ct-door"><Icon name="chat" size={12} /> {door}</span>}
        </p>
      </div>

      {!turn.events.length && !live ? (
        <span className="skeleton ct-skel" />
      ) : (
        <div className="ct-reply">
          {live && !answered && (
            <p className="ct-working" role="status">
              <span className="ct-pulse" aria-hidden="true" />
              {turn.replaying ? "Replaying: " : ""}{working.length ? `${working.map(nameOf).join(" and ")} ${working.length > 1 ? "are" : "is"} on it…` : direct ? `${nameOf(who)} is reading your question…` : "Meera is reading your question…"}
            </p>
          )}

          {lines.length > 0 && (
            <div className="ct-talk" role="log" aria-label="What the team said to each other">
              <p className="ct-talk-title">The team, talking it over</p>
              <ol>
                {lines.map((l, i) => (
                  <li key={i} className={`ct-line kind-${l.kind}${l.verdict ? ` v-${l.verdict}` : ""}`}>
                    <AgentAvatar id={l.from} size={22} />
                    <p>
                      <b>{nameOf(l.from)}</b>
                      {l.to && <span className="ct-to"> to {nameOf(l.to)}</span>}
                      <span className="ct-line-text"> {plain(l.text)}</span>
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {notes.length > 0 && <Notes notes={notes} />}

          {answered && (
            <article className={`ct-answer${view.final ? "" : " is-streaming"}`} aria-label={`${nameOf(answerBy)}'s answer`}>
              <header className="ct-answer-by">
                <AgentAvatar id={answerBy} size={26} ring={!view.final} />
                <span><b>{nameOf(answerBy)}</b><span className="ct-role">{jobOf(answerBy)}</span></span>
              </header>
              <Markdown text={humanDates(view.answer)} nodes={view.nodes} onCite={cite} className="ct-md" />
              {view.final && (
                <p className={`ct-assure${ok ? "" : " is-warn"}`}>
                  <Icon name={ok ? "check" : "warn"} size={14} />
                  {ok ? "Sources checked" : "A few things could not be matched to a source"} · {view.final.agents.length} {view.final.agents.length === 1 ? "person" : "people"} · {fmtMs(view.final.ms)}
                </p>
              )}
            </article>
          )}

          {view.final && view.made.map((m) => <MadeCard key={m.approvalId} tenant={p.tenantId} made={m} onChange={p.onPrefill} />)}
          {view.final && latest && view.questions && <QuickReplies q={view.questions} onAnswer={p.onSend} />}
          {proposals.map((x) => (
            <ApprovalInline key={x.approvalId} tenantId={p.tenantId} id={x.approvalId} title={x.title} by={x.agent} approval={p.approvals.get(x.approvalId)} onChanged={p.onApprovalChanged} />
          ))}

          {(view.final || how.people.length > 0) && (
            <Reveal label="How we got this" summary={view.final ? `${how.people.length} ${how.people.length === 1 ? "person" : "people"} · ${how.sources.length} ${how.sources.length === 1 ? "source" : "sources"}` : undefined} className="ct-how">
              <div className="ct-how-body">
                <section>
                  <h4>Who worked on it</h4>
                  <ul className="ct-people">{how.people.map((a) => <li key={a}><AgentAvatar id={a} size={22} /> <b>{nameOf(a)}</b> <span>{jobOf(a)}</span></li>)}</ul>
                </section>
                {how.tools.length > 0 && (
                  <section>
                    <h4>What they looked at</h4>
                    <ul>{how.tools.map((t) => <li key={`${t.agent}${t.words}`}><b>{nameOf(t.agent)}</b>: {t.words.charAt(0).toLowerCase() + t.words.slice(1)}{t.times > 1 ? `, ${t.times} times` : ""}</li>)}</ul>
                  </section>
                )}
                {how.skills.length > 0 && (
                  <section>
                    <h4>Skills they used</h4>
                    <ul>{how.skills.map((s) => <li key={`${s.agent}${s.name}`}><b>{nameOf(s.agent)}</b>: {s.name}</li>)}</ul>
                  </section>
                )}
                {how.sources.length > 0 && (
                  <section>
                    <h4>Where the facts came from</h4>
                    <ul>{how.sources.map((s) => <li key={s.id}>{s.title}{s.asOf ? <span className="ct-muted"> · {fmtDate(s.asOf)}</span> : null}</li>)}</ul>
                  </section>
                )}
                {how.checks.length > 0 && (
                  <section>
                    <h4>What we checked</h4>
                    <ul className="ct-checks">{how.checks.map((c) => <li key={c.text} className={c.ok ? "" : "is-bad"}><Icon name={c.ok ? "check" : "warn"} size={13} /> {c.text}</li>)}</ul>
                  </section>
                )}
                <div className="ct-how-actions">
                  {turn.turnId && view.final && <button type="button" className="btn btn-quiet btn-sm" onClick={p.onReplay}><Icon name="replay" size={14} /> Replay the work</button>}
                  {view.sessionId && view.final && <button type="button" className="btn btn-quiet btn-sm" onClick={() => nav(`/ask/${encodeURIComponent(view.sessionId!)}`)}><Icon name="brain" size={14} /> See the full work log</button>}
                </div>
              </div>
            </Reveal>
          )}

          {(turn.status === "error" || turn.status === "stopped") && (
            <div className="ct-error" role="alert">
              <Icon name="warn" size={16} />
              <span>{turn.status === "stopped" ? "Stopped before the answer was written." : plain(turn.error ?? view.error ?? "Something went wrong.")}</span>
              {latest && <button type="button" className="btn btn-ghost btn-sm" onClick={p.onRetry}>Ask again</button>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// What each person added, one quiet line each; the first few show and the rest wait behind "more".
function Notes({ notes }: { notes: ReturnType<typeof contributions> }) {
  const [all, setAll] = useState(false);
  const shown = all ? notes : notes.slice(0, 3);
  return (
    <div className="ct-notes" aria-label="What each person added">
      <ul>
        {shown.map((n, i) => (
          <li key={i} className="ct-note">
            <AgentAvatar id={n.agent} size={28} />
            <div>
              <p className="ct-note-by"><b>{nameOf(n.agent)}</b><span className="ct-role">{jobOf(n.agent)}</span></p>
              <p className="ct-note-text">{plain(n.text)}</p>
              {n.checks.length > 0 && (
                <p className="ct-note-checks">
                  {n.checks.map((c) => `${nameOf(c.by)} ${c.verdict === "ok" ? "checked it" : c.verdict === "fix" ? "asked for a fix" : "turned it down"}`).join(" · ")}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {notes.length > 3 && <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `${notes.length - 3} more`}</button>}
    </div>
  );
}

// A card waiting for the owner's OK, answered right here: Approve, Change (edit, then approve) or No.
function ApprovalInline({ tenantId, id, title, by, approval, onChanged }: {
  tenantId: string; id: string; title: string; by: AgentId; approval?: Approval; onChanged: (a: Approval) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [t, setT] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approve" | "reject", edited?: { title: string; body: string }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.decide(tenantId, id, { decision, ...(edited ? { editedPayload: { ...edited, ...(approval?.payload.target ? { target: approval.payload.target } : {}) } } : {}) });
      onChanged(r);
      window.dispatchEvent(new Event(APPROVALS_CHANGED));
      setEditing(false);
    } catch (e) {
      setError((e as Error).message || "That did not go through. Try again, or use Approvals.");
    } finally {
      setBusy(false);
    }
  };

  const decided = approval && approval.status !== "pending";
  return (
    <section className={`ct-approve${decided ? " is-done" : ""}`} aria-label="Waiting for your OK">
      <header>
        <AgentAvatar id={by} size={22} />
        <p><b>{decided ? (approval.status === "rejected" ? "You said no" : "You said OK") : "Waiting for your OK"}</b>
          <span className="ct-role">{approval ? KIND[approval.kind] : "From " + nameOf(by)}</span></p>
        {approval?.simulated && <SimBadge label="sample" />}
      </header>
      <p className="ct-approve-title">{plain(approval?.title ?? title)}</p>
      {approval && !decided && !editing && <p className="ct-approve-body">{approval.payload.body}</p>}
      {decided && <p className="ct-approve-body">{approval!.status === "rejected" ? "Nothing was changed." : plain(approval!.result ?? "Saved. Nothing goes out without your say.")}</p>}
      {editing && approval && (
        <div className="ct-edit">
          <label className="visually-hidden" htmlFor={`ct-t-${id}`}>Title</label>
          <input id={`ct-t-${id}`} className="field" value={t} onChange={(e) => setT(e.target.value)} />
          <label className="visually-hidden" htmlFor={`ct-b-${id}`}>What it says</label>
          <textarea id={`ct-b-${id}`} className="field" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
      )}
      {!decided && approval && (
        <div className="ct-approve-actions">
          {editing ? (
            <>
              <button type="button" className="btn btn-gold btn-sm" disabled={busy || !t.trim() || !body.trim()} onClick={() => void decide("approve", { title: t.trim(), body: body.trim() })}>{busy ? "Saving…" : "Approve my change"}</button>
              <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-gold btn-sm" disabled={busy} onClick={() => void decide("approve")}>{busy ? "Saving…" : "Approve"}</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setT(approval.payload.title); setBody(approval.payload.body); setEditing(true); }}>Change</button>
              <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => void decide("reject")}>No</button>
            </>
          )}
        </div>
      )}
      {!approval && <p className="ct-muted">Open Approvals to see this one.</p>}
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
    </section>
  );
}

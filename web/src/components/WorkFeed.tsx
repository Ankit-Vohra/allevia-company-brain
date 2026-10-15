// The office's side "work log": every step of a run as one readable line, in order, with who did it.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { AgentEvent, AgentId, NodeRef } from "@shared/contracts";
import { AGENTS } from "@shared/roster";
import type { RunView } from "../state/derive";
import { AgentAvatar, ChecksBadges, agentDef, fmtMs } from "./bits";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

type Entry =
  | { k: "recall"; brief: string; n: number }
  | { k: "plan"; by: AgentId; rationale: string; steps: { agent: AgentId; task: string }[] }
  | { k: "start"; agent: AgentId; task: string }
  | { k: "tool"; agent: AgentId; name: string; summary?: string; nodes: number; done: boolean }
  | { k: "handoff"; from: AgentId; to: AgentId; note: string }
  | { k: "finding"; agent: AgentId; text: string; id: string }
  | { k: "review"; agent: AgentId; author?: AgentId; verdict: "ok" | "fix" | "reject"; note: string }
  | { k: "proposal"; agent: AgentId; title: string; kind: string }
  | { k: "done"; agent: AgentId; ms: number }
  | { k: "answer" }
  | { k: "error"; message: string };

function toEntries(events: AgentEvent[]): Entry[] {
  const out: Entry[] = [];
  const tools = new Map<string, Extract<Entry, { k: "tool" }>>();
  const authors = new Map<string, AgentId>();
  let answered = false;
  for (const e of events) {
    switch (e.type) {
      case "recall": out.push({ k: "recall", brief: e.brief, n: e.ids.length }); break;
      case "plan": out.push({ k: "plan", by: e.by, rationale: e.rationale, steps: e.steps.map((s) => ({ agent: s.agent, task: s.task })) }); break;
      case "agent_start": out.push({ k: "start", agent: e.agent, task: e.task }); break;
      case "tool_call": {
        if (e.name === "show_path") break;
        const t: Extract<Entry, { k: "tool" }> = { k: "tool", agent: e.agent, name: e.name, nodes: 0, done: false };
        tools.set(e.id, t);
        out.push(t);
        break;
      }
      case "tool_result": {
        const t = tools.get(e.id);
        if (t) { t.summary = e.summary; t.nodes = e.nodes.length; t.done = true; }
        break;
      }
      case "handoff": out.push({ k: "handoff", from: e.from, to: e.to, note: e.note }); break;
      case "finding": authors.set(e.findingId, e.agent); out.push({ k: "finding", agent: e.agent, text: e.text, id: e.findingId }); break;
      case "review": out.push({ k: "review", agent: e.agent, author: authors.get(e.findingId), verdict: e.verdict, note: e.note }); break;
      case "proposal": out.push({ k: "proposal", agent: e.agent, title: e.title, kind: e.kind }); break;
      case "agent_done": out.push({ k: "done", agent: e.agent, ms: e.ms }); break;
      case "text": if (!answered) { answered = true; out.push({ k: "answer" }); } break;
      case "error": out.push({ k: "error", message: e.message }); break;
    }
  }
  return out;
}

const name = (id?: AgentId) => (id ? agentDef(id)?.name ?? id : "");

export function WorkFeed({ events, view, status, askHref, nodes, limit }: { events: AgentEvent[]; view?: RunView; status: string; askHref?: string; nodes?: Record<string, NodeRef>; limit?: number }) {
  const all = useMemo(() => toEntries(events), [events]);
  const [expanded, setExpanded] = useState(false);
  const hidden = limit && !expanded ? Math.max(0, all.length - limit) : 0;
  const entries = hidden ? all.slice(hidden) : all;
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length, view?.answer]);

  return (
    <ol
      className="feed"
      ref={listRef}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
      aria-live="polite"
      aria-relevant="additions"
    >
      {hidden > 0 && (
        <li className="feed-more">
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setExpanded(true)}>Show the {hidden} earlier steps</button>
        </li>
      )}
      {entries.map((en, i) => <FeedItem key={i + hidden} en={en} view={view} nodes={nodes} />)}
      {view?.final && (
        <li className="feed-item feed-final">
          <div className="feed-final-head">
            <Icon name="check" size={16} />
            <span>Answered in {fmtMs(view.final.ms)} by {view.final.agents.length} staff</span>
          </div>
          <ChecksBadges checks={view.final.checks} compact />
          {askHref && <Link className="btn btn-sm btn-ghost" to={askHref}>Open the full answer and graph <Icon name="chevron-right" size={14} /></Link>}
        </li>
      )}
      {status === "error" && view?.error && <li className="feed-item feed-error">{view.error}</li>}
    </ol>
  );
}

function FeedItem({ en, view, nodes }: { en: Entry; view?: RunView; nodes?: Record<string, NodeRef> }) {
  switch (en.k) {
    case "recall":
      return (
        <li className="feed-item feed-system">
          <span className="feed-icon"><Icon name="layers" size={15} /></span>
          <div><b>What we already know</b> · {en.n} earlier items<p className="feed-sub">{en.brief}</p></div>
        </li>
      );
    case "plan":
      return (
        <li className="feed-item">
          <AgentAvatar id={en.by} size={24} />
          <div>
            <b>{name(en.by)}</b> planned {en.steps.length} steps
            <p className="feed-sub">{en.rationale}</p>
            <ul className="feed-steps">
              {en.steps.map((s, i) => (
                <li key={i}><AgentAvatar id={s.agent} size={16} /><span><b>{name(s.agent)}</b> {s.task}</span></li>
              ))}
            </ul>
          </div>
        </li>
      );
    case "start":
      return (
        <li className="feed-item feed-quiet">
          <AgentAvatar id={en.agent} size={24} />
          <div><b>{name(en.agent)}</b> picked up: {en.task}</div>
        </li>
      );
    case "tool":
      return (
        <li className="feed-item feed-tool">
          <span className="feed-indent" aria-hidden="true" />
          <div>
            <code className="tool-name">{en.name}</code>
            {en.done ? <span className="feed-sub"> {en.summary}{en.nodes ? <span className="feed-nodes"> · {en.nodes} nodes</span> : null}</span> : <span className="feed-sub feed-wait"> working…</span>}
          </div>
        </li>
      );
    case "handoff":
      return (
        <li className="feed-item feed-handoff">
          <span className="feed-icon is-gold"><Icon name="file" size={15} /></span>
          <div><b>{name(en.from)}</b> → <b>{name(en.to)}</b><span className="feed-sub"> {en.note}</span></div>
        </li>
      );
    case "finding":
      return (
        <li className="feed-item feed-finding">
          <AgentAvatar id={en.agent} size={24} />
          <div>
            <b>{name(en.agent)}</b> filed a finding
            <Markdown text={en.text} nodes={nodes} className="feed-md" />
          </div>
        </li>
      );
    case "review":
      return (
        <li className={`feed-item feed-review is-${en.verdict}`}>
          <AgentAvatar id={en.agent} size={24} />
          <div>
            <b>{name(en.agent)}</b> {en.verdict === "ok" ? "approved" : en.verdict === "fix" ? "sent back" : "rejected"} {en.author ? `${name(en.author)}'s finding` : "a finding"}
            <span className={`verdict is-${en.verdict}`}><Icon name={en.verdict === "ok" ? "check" : "x"} size={12} /></span>
            <p className="feed-sub">{en.note}</p>
          </div>
        </li>
      );
    case "proposal":
      return (
        <li className="feed-item feed-proposal">
          <span className="feed-icon is-gold"><Icon name="approvals" size={15} /></span>
          <div><b>{name(en.agent)}</b> proposed an action for your approval<p className="feed-sub">{en.title} · <Link to="/approvals">Approvals</Link></p></div>
        </li>
      );
    case "done":
      return (
        <li className="feed-item feed-done">
          <span className="feed-indent" aria-hidden="true" />
          <div className="feed-sub"><Icon name="check" size={12} /> {name(en.agent)} done · {fmtMs(en.ms)}</div>
        </li>
      );
    case "answer":
      return (
        <li className="feed-item feed-answer">
          <AgentAvatar id={AGENTS[0]!.id} size={24} ring={!view?.final} />
          <div>
            <b>{name(AGENTS[0]!.id)}</b> {view?.final ? "answered" : "is writing the answer"}
            <Markdown text={view?.answer ?? ""} nodes={nodes} className="feed-md feed-answer-md" />
          </div>
        </li>
      );
    case "error":
      return <li className="feed-item feed-error">{en.message}</li>;
  }
}

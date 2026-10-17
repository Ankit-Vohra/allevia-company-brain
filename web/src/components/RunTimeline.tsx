// A run at a glance: one row per desk, a bar for the time it worked, ticks for each tool call, a note for each finding,
// a stamp for each review, and gold arcs for files handed desk to desk. The x axis is the order events arrived in, so a
// live run and a replay draw the same picture.
import { useMemo } from "react";
import type { AgentId } from "@shared/contracts";
import type { LaneView, RunView } from "../state/derive";
import { stagesOf } from "../state/derive";
import { AgentAvatar, agentDef, deptOf } from "./bits";

interface Row { lane: LaneView; label: string; sub: string; role: boolean }

const ROW_H = 26;

export function RunTimeline({ view, running, onPick }: { view: RunView; running: boolean; onPick?: (laneKey: string) => void }) {
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const st of stagesOf(view)) {
      for (const lane of st.lanes) {
        const a = agentDef(lane.agent);
        const isAnswer = lane.key.endsWith("#answer");
        const isPlan = lane.agent === view.plan?.by && !isAnswer;
        out.push({ lane, label: a?.name ?? lane.agent, sub: isAnswer ? "answer" : isPlan ? "plan" : deptOf(lane.agent)?.name ?? a?.title ?? "", role: isAnswer || isPlan });
      }
    }
    return out;
  }, [view]);

  if (!rows.length) return null;
  // x is the work clock (see deriveRun), with a little headroom while running so the newest work is not pinned right
  const end = view.clock[view.count] ?? view.count;
  const span = Math.max(8, end * (running ? 1.1 : 1) + (running ? 2 : 0));
  const x = (i: number) => (Math.max(0, Math.min(span, view.clock[Math.min(i + 1, view.count)] ?? i)) / span) * 100;
  const xStart = (i: number) => (Math.max(0, Math.min(span, view.clock[i] ?? i)) / span) * 100;
  const rowOf = new Map<AgentId, number>();
  rows.forEach((r, i) => {
    // handoffs to the Chief land on the answer row once it exists
    if (!rowOf.has(r.lane.agent) || r.lane.key.endsWith("#answer")) rowOf.set(r.lane.agent, i);
  });
  const planRow = rows.findIndex((r) => r.lane.agent === view.plan?.by && !r.lane.key.endsWith("#answer"));
  // the Chief's handoffs come from the planning row unless they were sent while writing the answer
  const fromRow = (a: AgentId, at: number) => {
    if (a !== view.plan?.by || planRow < 0) return rowOf.get(a) ?? -1;
    const answer = view.lanes[`${a}#answer`];
    return answer?.startAt !== undefined && at >= answer.startAt ? rowOf.get(a) ?? planRow : planRow;
  };
  const h = rows.length * ROW_H;
  const arcs = view.handoffs.flatMap((hf) => {
    const a = fromRow(hf.from, hf.at), b = rowOf.get(hf.to);
    if (a < 0 || b === undefined || a === b) return [];
    const x0 = x(hf.at);
    return [{ x0, y0: a * ROW_H + ROW_H / 2, x1: Math.min(100, x0 + 1.4), y1: b * ROW_H + ROW_H / 2 }];
  });

  return (
    <figure className="timeline" aria-label={`Who worked on this: ${rows.map((r) => `${r.label} (${r.sub})`).join(", ")}`}>
      <div className="timeline-rows" style={{ height: h }}>
        {rows.map((r, i) => {
          const l = r.lane;
          const hue = deptOf(l.agent)?.hue ?? 265;
          const start = l.startAt;
          const end = l.endAt ?? (l.phase === "working" ? view.count : undefined);
          const waitingOn = l.phase === "planned" && l.after?.length ? l.after.map((a) => agentDef(a)?.name ?? a).join(" and ") : null;
          return (
            <div key={l.key} className={`tl-row is-${l.phase}`} style={{ top: i * ROW_H, height: ROW_H, ["--hue" as string]: hue }}>
              <button type="button" className="tl-who" onClick={() => onPick?.(l.key)} aria-label={`${r.label}, ${r.sub}: jump to this desk's work`}>
                <AgentAvatar id={l.agent} size={18} ring={l.phase === "working"} />
                <span className="tl-name">{r.label}</span>
                <span className={`tl-sub${r.role ? " is-role" : ""}`}>{r.sub}</span>
              </button>
              <div className="tl-track">
                {start !== undefined && end !== undefined && (
                  <span className={`tl-bar${l.phase === "working" ? " is-live" : ""}`} style={{ left: `${xStart(start)}%`, width: `max(6px, ${x(end) - xStart(start)}%)` }} />
                )}
                {l.steps.map((s) => <span key={s.id} className={`tl-tick${s.done ? "" : " is-open"}`} style={{ left: `${x(s.at)}%` }} title={s.name} />)}
                {l.findings.map((f) => <span key={f.id} className="tl-note" style={{ left: `${x(f.at)}%` }} title="Finding filed" />)}
                {l.reviewsGiven.map((rv, k) => <span key={k} className={`tl-stamp is-${rv.verdict}`} style={{ left: `${x(rv.at)}%` }} title={`Review: ${rv.verdict}`} />)}
                {waitingOn && <span className="tl-wait">waits for {waitingOn}</span>}
              </div>
            </div>
          );
        })}
        <div className="tl-arcs" aria-hidden="true">
          <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none">
            {arcs.map((a, i) => (
              <path key={i} d={`M ${a.x0} ${a.y0} C ${a.x0 + 1.6} ${a.y0 + (a.y1 - a.y0) * 0.55}, ${a.x1 - 0.4} ${a.y0 + (a.y1 - a.y0) * 0.55}, ${a.x1} ${a.y1 - Math.sign(a.y1 - a.y0) * 5}`} className="tl-arc" vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          {arcs.map((a, i) => <span key={i} className="tl-arc-end" style={{ left: `${a.x1}%`, top: a.y1 }} />)}
        </div>
      </div>
      <figcaption className="timeline-key">
        <span><i className="k-bar" /> working</span>
        <span><i className="k-tick" /> tool call</span>
        <span><i className="k-note" /> finding</span>
        <span><i className="k-stamp" /> review</span>
        <span><i className="k-arc" /> handoff</span>
      </figcaption>
    </figure>
  );
}

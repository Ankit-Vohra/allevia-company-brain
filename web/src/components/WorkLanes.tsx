// The work log as lanes: the Chief's plan, then each stage of desks (side by side when they ran in parallel), then the
// answer. Every lane shows the task, each tool call with what it found and how many graph nodes it touched, the finding
// it filed, the reviews it got, and where it handed the file next.
import type { AgentId, NodeRef } from "@shared/contracts";
import type { LaneView, RunView, StepView } from "../state/derive";
import { stagesOf } from "../state/derive";
import { AgentAvatar, agentDef, deptOf, fmtMs } from "./bits";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

const name = (id?: AgentId) => (id ? agentDef(id)?.name ?? id : "");

function stageTitle(depth: number, lanes: LaneView[]) {
  if (depth === 0) return "The plan";
  if (depth === 99) return "The answer";
  const after = [...new Set(lanes.flatMap((l) => l.after ?? []))];
  const head = after.length ? `After ${after.map(name).join(" and ")}` : "First";
  return lanes.length > 1 ? `${head}, ${lanes.length} desks in parallel` : head;
}

export function WorkLanes({ view, nodes, onCite, onNodes, activeCite }: {
  view: RunView;
  nodes?: Record<string, NodeRef>;
  onCite?: (id: string) => void;
  onNodes?: (ids: string[]) => void;
  activeCite?: string;
}) {
  const stages = stagesOf(view);
  return (
    <div className="lanes">
      {view.recall && (
        <div className="recall">
          <Icon name="layers" size={15} />
          <p><b>What we already knew.</b> {view.recall.brief}</p>
        </div>
      )}
      {stages.map((st) => (
        <section key={st.depth} className={`stage stage-${st.depth === 0 ? "plan" : st.depth === 99 ? "answer" : "work"}`} aria-label={stageTitle(st.depth, st.lanes)}>
          <h4 className="stage-title">{stageTitle(st.depth, st.lanes)}</h4>
          <div className={`stage-lanes${st.lanes.length > 1 ? " is-multi" : ""}`}>
            {st.lanes.map((l) => (
              <Lane key={l.key} lane={l} view={view} nodes={nodes} onCite={onCite} onNodes={onNodes} activeCite={activeCite} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Lane({ lane, view, nodes, onCite, onNodes, activeCite }: {
  lane: LaneView; view: RunView; nodes?: Record<string, NodeRef>; onCite?: (id: string) => void; onNodes?: (ids: string[]) => void; activeCite?: string;
}) {
  const a = agentDef(lane.agent);
  const hue = deptOf(lane.agent)?.hue ?? 265;
  const isAnswer = lane.key.endsWith("#answer");
  const isPlan = lane.agent === view.plan?.by && !isAnswer;
  const steps = lane.steps.filter((s) => s.name !== "show_path");
  const reviewsOfMine = lane.findings.flatMap((f) => f.reviews.map((r) => ({ ...r, findingId: f.id })));
  return (
    <article id={`lane-${lane.key.replace(/[^a-z0-9-]/gi, "-")}`} className={`lane is-${lane.phase}`} style={{ ["--hue" as string]: hue }}>
      <header className="lane-head">
        <AgentAvatar id={lane.agent} size={28} ring={lane.phase === "working"} />
        <div className="lane-id">
          <b>{a?.name ?? lane.agent}</b>
          <span>{a?.title}</span>
        </div>
        <LanePhase lane={lane} />
      </header>
      {lane.task && <p className="lane-task">{lane.task}</p>}

      {isPlan && view.plan && (
        <ol className="lane-plan">
          {view.plan.steps.map((s, i) => (
            <li key={i}>
              <AgentAvatar id={s.agent} size={16} />
              <span><b>{name(s.agent)}</b> {s.task}{s.after?.length ? <span className="muted"> · after {s.after.map(name).join(", ")}</span> : null}</span>
            </li>
          ))}
        </ol>
      )}
      {isPlan && view.plan?.rationale && <p className="lane-why">{view.plan.rationale}</p>}

      {steps.length > 0 && (
        <ol className="lane-steps">
          {steps.map((s) => <Step key={s.id} s={s} onNodes={onNodes} />)}
        </ol>
      )}
      {lane.phase === "working" && lane.status && (
        <p className="lane-status"><span className="pulse" aria-hidden="true" />{lane.status}</p>
      )}

      {lane.findings.map((f) => (
        <div key={f.id} className="lane-finding">
          <p className="lane-label"><Icon name="file" size={13} /> Finding{f.basedOn?.length ? <span> · builds on {f.basedOn.map((b) => name(view.findings[b]?.agent)).filter(Boolean).join(" and ")}</span> : null}</p>
          <Markdown text={f.text} nodes={nodes} onCite={onCite} activeId={activeCite} className="lane-md" />
        </div>
      ))}

      {reviewsOfMine.length > 0 && (
        <ul className="lane-reviews" aria-label="Reviews of this finding">
          {reviewsOfMine.map((r, i) => (
            <li key={i} className={`review is-${r.verdict}`}>
              <span className="review-stamp"><Icon name={r.verdict === "ok" ? "check" : "x"} size={12} /></span>
              <span><b>{name(r.by)}</b> {r.verdict === "ok" ? "passed it" : r.verdict === "fix" ? "sent it back" : "rejected it"}: {r.note}</span>
            </li>
          ))}
        </ul>
      )}

      {lane.reviewsGiven.length > 0 && (
        <ul className="lane-reviews is-given" aria-label="Reviews given">
          {lane.reviewsGiven.map((r, i) => (
            <li key={i} className={`review is-${r.verdict}`}>
              <span className="review-stamp"><Icon name={r.verdict === "ok" ? "check" : "x"} size={12} /></span>
              <span>Checked <b>{name(view.findings[r.findingId]?.agent)}</b>'s finding: {r.note}</span>
            </li>
          ))}
        </ul>
      )}

      {lane.handoffsOut.length > 0 && (
        <ul className="lane-handoffs" aria-label="Handed on">
          {lane.handoffsOut.map((h, i) => (
            <li key={i}>
              <span className="handoff-file" aria-hidden="true"><Icon name="file" size={12} /></span>
              <span>to <b>{name(h.to)}</b>: {h.note}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function LanePhase({ lane }: { lane: LaneView }) {
  if (lane.phase === "working") return <span className="badge badge-gold lane-phase">Working</span>;
  if (lane.phase === "done") return <span className="lane-phase lane-done"><Icon name="check" size={13} />{lane.ms ? fmtMs(lane.ms) : "Done"}</span>;
  if (lane.phase === "failed") return <span className="badge badge-bad lane-phase">Failed</span>;
  return <span className="badge badge-ink lane-phase">Waiting</span>;
}

function Step({ s, onNodes }: { s: StepView; onNodes?: (ids: string[]) => void }) {
  return (
    <li className={`step${s.done ? "" : " is-open"}`}>
      <code className="tool-name">{s.name}</code>
      <span className="step-text">
        {s.done ? s.summary : <span className="step-wait">working…</span>}
        {s.done && s.nodes.length > 0 && (
          <button type="button" className="step-nodes" onClick={() => onNodes?.(s.nodes.map((n) => n.id))} title="Show these nodes on the graph">
            {s.nodes.length} nodes
          </button>
        )}
      </span>
    </li>
  );
}

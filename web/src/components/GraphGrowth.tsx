// "How your team's knowledge grew": the Brain page's honest answer to "does it keep growing?". Every row is a day or a
// week and its bar is what the team added then, counted in the business's own graph (GET /api/:t/graph/story, the same
// numbers as `npm run cli -- graph:story`). Two clocks: when the team learned it, and when it happened (the date of the
// document or reading it came from). Plain words; the numbers are the graph's, never drawn by hand.
import { useEffect, useState } from "react";
import { api } from "../api";
import { useAsync } from "../state/app";
import { fmtNum } from "../lib/format";
import "./graph-growth.css";

export interface GraphStoryDto {
  tenant: string; axis: "recorded" | "source"; bucket: "day" | "week";
  points: Array<{ start: string; nodes: number; edges: number; nodesByKind: Record<string, number>; edgesByKind: Record<string, number>; retired: number; totalNodes: number; totalEdges: number }>;
  totals: { nodes: number; edges: number; versions: number; retired: number; undatedNodes: number; undatedEdges: number };
  first: string | null; last: string | null;
  afterLoad: null | { loadDay: string; loadNodes: number; loadEdges: number; nodes: number; edges: number; nodesPct: number | null; edgesPct: number | null };
  kinds: Array<{ id: string; name: string }>;
}

// Owner-facing names for the kinds the server counts, and a hue each (the same OKLCH hue scale the Brain page uses).
const KIND: Record<string, { name: string; hue: number }> = {
  knowledge: { name: "Facts and sources", hue: 250 },
  company: { name: "Your company", hue: 150 },
  work: { name: "Work and decisions", hue: 60 },
  memory: { name: "What the team remembers", hue: 310 },
  actions: { name: "Ideas and approvals", hue: 20 },
  sales: { name: "Sales", hue: 190 },
  creative: { name: "Pictures and posts", hue: 350 },
  history: { name: "Changes kept", hue: 100 },
  other: { name: "Other", hue: 0 },
};

const day = (iso: string): string => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function GraphGrowthPanel({ tenantId }: { tenantId: string }) {
  const [by, setBy] = useState<"recorded" | "happened">("recorded");
  useEffect(() => setBy("recorded"), [tenantId]);
  const res = useAsync(() => api.graphStory(tenantId, by), [tenantId, by]);
  const s = res.data;
  if (s === null) return null; // demo data without the live server
  if (!s && res.error) return null; // a small panel; the rest of the page does not need it

  const max = Math.max(1, ...(s?.points ?? []).map((p) => p.nodes));
  const a = s?.afterLoad;
  return (
    <section className="gg" aria-label="How it grew">
      {!s ? <div className="bs-skel" aria-hidden="true"><span className="skeleton" /><span className="skeleton" /></div> : (
          <div className="gg-body">
            <p className="gg-lede">
              {by === "recorded" && a && (a.nodes || a.edges)
                ? <>Since the first load on {day(a.loadDay)}, using it added <b>{fmtNum(a.nodes)}</b> things{a.nodesPct !== null ? ` (+${a.nodesPct}%)` : ""} and <b>{fmtNum(a.edges)}</b> links: conversations, decisions, your OKs and your edits.</>
                : <><b>{fmtNum(s.totals.nodes)}</b> things and <b>{fmtNum(s.totals.edges)}</b> links{s.first && <>, from {day(s.first)} to {day(s.last ?? s.first)}</>}.</>}
            </p>
            <div className="gg-switch" role="group" aria-label="Which date to count by">
              <button type="button" className={`gg-chip${by === "recorded" ? " is-on" : ""}`} aria-pressed={by === "recorded"} onClick={() => setBy("recorded")}>When your team learned it</button>
              <button type="button" className={`gg-chip${by === "happened" ? " is-on" : ""}`} aria-pressed={by === "happened"} onClick={() => setBy("happened")}>When it happened</button>
            </div>
            <ol className="gg-rows">
              {s.points.map((p) => (
                <li key={p.start} className="gg-row">
                  <span className="gg-when">{s.bucket === "week" ? `Week of ${day(p.start)}` : day(p.start)}</span>
                  <span className="gg-bar" role="img" aria-label={`${fmtNum(p.nodes)} things and ${fmtNum(p.edges)} links added`}>
                    {s.kinds.filter((k) => (p.nodesByKind[k.id] ?? 0) > 0).map((k) => (
                      <span key={k.id} className="gg-seg" title={`${KIND[k.id]?.name ?? k.name}: ${fmtNum(p.nodesByKind[k.id] ?? 0)}`}
                        style={{ width: `${((p.nodesByKind[k.id] ?? 0) / max) * 100}%`, ["--hue" as string]: KIND[k.id]?.hue ?? 0 }} />
                    ))}
                  </span>
                  <span className="gg-num">+{fmtNum(p.nodes)} <span className="gg-edges">· +{fmtNum(p.edges)} links</span></span>
                </li>
              ))}
            </ol>
            <ul className="gg-key" aria-label="What the colours mean">
              {s.kinds.filter((k) => s.points.some((p) => (p.nodesByKind[k.id] ?? 0) > 0)).map((k) => (
                <li key={k.id}><span className="gg-dot" style={{ ["--hue" as string]: KIND[k.id]?.hue ?? 0 }} aria-hidden="true" />{KIND[k.id]?.name ?? k.name}</li>
              ))}
            </ul>
            {(s.totals.undatedNodes > 0 || s.totals.undatedEdges > 0) && (
              <p className="gg-note">{fmtNum(s.totals.undatedNodes)} things and {fmtNum(s.totals.undatedEdges)} links have no date on this clock.</p>
            )}
          </div>
        )}
    </section>
  );
}

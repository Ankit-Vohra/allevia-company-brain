// The morning brief as Meera writes it (src/insights/brief.ts): a goal pulse first (each goal against its day-0
// baseline and target), then what changed since yesterday, the top three, what waits on the owner and one next step.
// The text is a template filled from the graph; this splits it into its sections and keeps every [[id]] as a source chip.
// "Run today's brief" asks the server to bring the goals' readings up to date and write it again (no language model).
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { NodeRef } from "@shared/contracts";
import { api, getPublicMode } from "../api";
import { fmtAgo, fmtDate } from "../lib/format";
import { useAsync } from "../state/app";
import type { Brief } from "../types-ext";
import { AgentAvatar } from "./bits";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import "./program.css";

interface Section { title: string; lines: Array<{ n?: string; text: string }> }

export function parseBrief(text: string): { heading?: string; sections: Section[] } {
  const sections: Section[] = [];
  let heading: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const item = /^(?:[-*]\s+|(\d+)\.\s+)(.*)$/.exec(line);
    if (item) {
      if (!sections.length) sections.push({ title: "", lines: [] });
      sections[sections.length - 1]!.lines.push({ ...(item[1] ? { n: item[1] } : {}), text: item[2]! });
    } else if (!heading && !sections.length && /^morning brief\b/i.test(line)) {
      heading = line;
    } else {
      sections.push({ title: line, lines: [] });
    }
  }
  return { heading, sections };
}

type Pulse = "ok" | "warn" | "bad" | "none";
function pulseOf(line: string): Pulse {
  if (/\b(?:achieved|on track)\b/i.test(line)) return "ok";
  if (/\bat risk\b/i.test(line)) return "warn";
  if (/\boff track\b/i.test(line)) return "bad";
  return "none";
}

const tidy = (s: string) => s.replace(/ -> /g, " → ");

const words = (s: string) => s.replace(/[-_]+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());
const shortDay = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? fmtDate(iso) : iso);

/** Readable chips for the ids a brief cites, without a lookup per id: the brief's own line says what each one is. */
function citeRef(id: string): NodeRef {
  const [kind = "", ...rest] = id.split(":");
  const tail = rest.join(":");
  switch (kind) {
    case "obs": {
      const parts = tail.split(":");
      return { id, label: "Observation", name: `${words(parts[0] ?? "")}${parts.length > 1 ? `, ${shortDay(parts[parts.length - 1]!)}` : ""}` };
    }
    case "observation": return { id, label: "Observation", name: words(tail) };
    case "goal": return { id, label: "Goal", name: words(tail) };
    case "recommendation": case "rec": return { id, label: "Recommendation", name: "Recommendation" };
    case "approval": case "appr": return { id, label: "Approval", name: "Approval card" };
    case "rule": return { id, label: "Rule", name: tail.startsWith("learned-") ? "Learned rule" : words(tail) };
    default: return { id, label: words(kind), name: words(tail).slice(0, 40) };
  }
}

function citesIn(text: string): Record<string, NodeRef> {
  const out: Record<string, NodeRef> = {};
  for (const m of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) out[m[1]!] = citeRef(m[1]!);
  return out;
}

export function BriefPanel({ tenantId, onRan }: { tenantId: string; onRan?: () => void }) {
  const brief = useAsync(() => api.brief(tenantId), [tenantId]);
  const [fresh, setFresh] = useState<{ b: Brief; at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();
  useEffect(() => { setFresh(null); setError(null); }, [tenantId]);

  const b = fresh?.b ?? brief.data;
  const parsed = useMemo(() => (b ? parseBrief(b.text) : null), [b]);
  const refs = useMemo(() => (b ? citesIn(b.text) : {}), [b]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.runBrief(tenantId);
      setFresh({ b: out, at: new Date().toISOString() });
      onRan?.();
    } catch (e) {
      setError((e as Error).message || "The brief did not run. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  };
  // an approval opens its card, a recommendation the insights page, anything else the brain
  const openNode = (id: string) => {
    if (/^(?:approval|appr):/.test(id)) nav(`/approvals#${encodeURIComponent(id)}`);
    else if (/^(?:recommendation|rec):/.test(id)) nav("/insights");
    else nav(`/brain?node=${encodeURIComponent(id)}`);
  };
  const ro = getPublicMode();

  return (
    <section className="brief-card" aria-labelledby="brief-card-title" aria-busy={busy || undefined}>
      <header className="brief-card-head">
        <AgentAvatar id="chief-of-staff" size={32} />
        <div>
          <h2 id="brief-card-title" className="section-title">Morning brief</h2>
          <p className="small muted">
            From Meera{b ? <> · {fresh ? fmtAgo(fresh.at) : fmtDate(b.asOf ?? b.date)}</> : null}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={run} disabled={busy || ro} title={ro ? "Turned off in the public demo" : "Bring the goals up to date and write today's brief"}>
          <Icon name="replay" size={14} /> {busy ? "Writing…" : "Run today's brief"}
        </button>
      </header>
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
      {brief.error && !b && <p className="notice notice-bad" role="alert">The brief did not load: {brief.error}</p>}
      {brief.loading && !b ? (
        <span className="skeleton" style={{ display: "block", height: 160 }} />
      ) : !parsed || !parsed.sections.length ? (
        <p className="brief-none">No brief yet today. Run it to see the goal pulse, what changed and what waits on you.</p>
      ) : (
        <div className="brief-body">
          {parsed.sections.map((s, i) => {
            const goals = /^goals?$/i.test(s.title);
            return (
              <div key={`${s.title}-${i}`} className={`brief-sec${goals ? " is-goals" : ""}`}>
                {s.title && <h3 className="brief-sec-title">{goals ? "Goal pulse" : s.title}</h3>}
                <ul className="brief-lines">
                  {s.lines.map((l, j) => {
                    const p = goals ? pulseOf(l.text) : undefined;
                    return (
                      <li key={j} className={p ? `pulse-${p}` : l.n ? "is-numbered" : undefined}>
                        {p && <span className="pulse-dot" aria-hidden="true" />}
                        {l.n && <span className="brief-n num" aria-hidden="true">{l.n}</span>}
                        <Markdown text={tidy(l.text)} nodes={refs} onCite={openNode} className="brief-line-md" />
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

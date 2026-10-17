// "What breaks if something stops", the Brain page's tab: for one system, what stops straight away (one step) against
// everything down the line (up to four steps), each far item with the path that links it back, and who looks after it.
// Behind expanders: things that come up together (communities) and how it is worked out. Read from the business's own
// graph (GET /api/:t/graph/at-work). An empty answer says which kind: not in your records, not mapped yet, or nothing
// downstream. The same read answers "What breaks if this stops" in the map's side panel.
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { impactLine } from "../lib/brain-map";
import { useAsync } from "../state/app";
import { kindName } from "./brain-words";
import { Reveal } from "./Reveal";
import "./graph-at-work.css";

interface Thing { id: string; name: string; type: string }
interface PathStep { id: string; name: string; rel: string; dir: "in" | "out" }
interface ImpactItem extends Thing { hop: number; path: PathStep[] }
interface ImpactView { depth: number; total: number; items: ImpactItem[]; more: boolean }
export interface GraphAtWork {
  candidates: Array<Thing & { dependents: number }>;
  focus: null | (Thing & { status: "impact" | "nothing_depends" | "not_mapped"; message?: string; shallow: ImpactView; deep: ImpactView; owners: Array<Thing & { via?: string }> });
  notFound?: { asked: string; message: string; suggestions: Thing[] };
  important: Array<Thing & { score: number }>;
  groups: Array<{ label: string; size: number; members: Thing[] }>;
  errors: string[];
}

// How one step links to the one before it, in plain words (the arrow's meaning, not its name).
// Read left to right: "Instagram connector <- needs it <- Reel publisher <- … <- held up by it <- Diwali launch week".
const OUT: Record<string, string> = { DEPENDS_ON: "needs it" };
const IN: Record<string, string> = { BLOCKS: "held up by it", AFFECTS: "affected by it" };
const linkWords = (p: { rel: string; dir: "in" | "out" }) => (p.dir === "out" ? OUT[p.rel] : IN[p.rel]) ?? p.rel.toLowerCase().replace(/_/g, " ");

export function GraphAtWorkPanel({ tenantId, onPick }: { tenantId: string; onPick: (id: string) => void }) {
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const [typed, setTyped] = useState("");
  useEffect(() => { setFocus(undefined); setTyped(""); }, [tenantId]);
  const res = useAsync(() => api.graphAtWork(tenantId, focus), [tenantId, focus]);
  const d = res.data;
  if (d === null) return <p className="gw-msg">This needs your live records, so it is not in the demo.</p>;
  const f = d?.focus;
  const ask = (e: FormEvent) => { e.preventDefault(); if (typed.trim()) setFocus(typed.trim()); };

  return (
    <section className="gw" aria-label="What breaks if something stops">
      {d && d.candidates.length > 0 && (
        <form className="gw-pick" onSubmit={ask}>
          <label className="gw-pick-label" htmlFor="gw-select">If this stops</label>
          <select id="gw-select" className="field gw-select" value={f?.id ?? ""} onChange={(e) => { setTyped(""); setFocus(e.target.value || undefined); }}>
            {!d.candidates.some((c) => c.id === f?.id) && <option value={f?.id ?? ""}>{f?.name ?? "Choose…"}</option>}
            {d.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="field gw-input" type="search" placeholder="or type a name" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type the name of something to check" />
          <button type="submit" className="btn btn-ghost btn-sm" disabled={!typed.trim()}>Check</button>
        </form>
      )}

      {res.loading && !d ? <div className="bs-skel" aria-hidden="true"><span className="skeleton" /><span className="skeleton" /></div>
        : res.error ? <p className="gw-msg">We couldn't read this just now. {res.error}</p>
        : !d ? null
        : d.notFound ? (
          <div className="gw-msg gw-msg-missing" role="status">
            <p><b>{d.notFound.message}</b></p>
            {d.notFound.suggestions.length > 0 && (
              <p className="gw-sugs">Closest: {d.notFound.suggestions.map((s, i) => (
                <span key={s.id}>{i > 0 && ", "}<button type="button" className="gw-link" onClick={() => { setTyped(""); setFocus(s.id); }}>{s.name}</button></span>
              ))}</p>
            )}
          </div>
        ) : !f ? (
          <p className="gw-msg">No systems or channels are in your records yet.</p>
        ) : (
          <div className="gw-body" aria-live="polite">
            <p className={`gw-lede${f.status === "not_mapped" ? " gw-unmapped" : ""}`}>
              {impactLine(f.name, f.status, f.shallow.total, f.deep.total)}
              {f.status === "not_mapped" && <span className="gw-aside"> That is not the same as nothing depending on it.</span>}
            </p>
            <p className="gw-owner">{f.owners.length > 0 ? <>Looked after by {f.owners.map((o, i) => (
              <span key={o.id}>{i > 0 && ", "}<button type="button" className="gw-link" onClick={() => onPick(o.id)}>{o.name}</button>{o.via ? ` (through ${o.via})` : ""}</span>
            ))}</> : "No owner is recorded."}</p>

            {f.status === "impact" && (
              <div className="gw-cols">
                <div className="gw-col">
                  <h3 className="gw-col-title">Straight away</h3>
                  <ul className="gw-list">
                    {f.shallow.items.map((i) => (
                      <li key={i.id}><button type="button" className="gw-link" onClick={() => onPick(i.id)}>{i.name}</button> <span className="gw-kind">{kindName(i.type)}</span></li>
                    ))}
                  </ul>
                </div>
                <div className="gw-col">
                  <h3 className="gw-col-title">Further down the line</h3>
                  {f.deep.items.filter((i) => i.hop > 1).length === 0 ? <p className="gw-none">Nothing further.</p> : (
                    <ol className="gw-paths">
                      {f.deep.items.filter((i) => i.hop > 1).map((i) => (
                        <li key={i.id} className="gw-path">
                          <span className="gw-node is-start">{f.name}</span>
                          {i.path.map((p) => (
                            <span key={p.id} className="gw-step">
                              <span className="gw-arrow" aria-hidden="true">←</span>
                              <span className="gw-rel">{linkWords(p)}</span>
                              <button type="button" className={`gw-node${p.id === i.id ? " is-end" : ""}`} onClick={() => onPick(p.id)}>{p.name}</button>
                            </span>
                          ))}
                          <span className="gw-hop">{i.hop} steps</span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {f.deep.more && <p className="gw-none">The first 60 are shown.</p>}
                </div>
              </div>
            )}
          </div>
        )}

      {d && d.groups.length > 0 && (
        <Reveal tone="row" label="Things that come up together" summary={`${d.groups.length} groups`}>
          <ul className="gw-groups">
            {d.groups.map((g, gi) => (
              <li key={gi}>
                <span className="gw-group-size">{g.size} linked</span>
                {g.members.map((m, i) => <span key={m.id}>{i > 0 && " · "}<button type="button" className="gw-link" onClick={() => onPick(m.id)}>{m.name}</button></span>)}
              </li>
            ))}
          </ul>
        </Reveal>
      )}
      {d && (
        <Reveal label="How this is worked out">
          <ul className="gw-how">
            <li>Your team follows the links one step at a time: what <i>needs</i> the thing (DEPENDS_ON), and what it <i>holds up</i> or <i>affects</i> (BLOCKS, AFFECTS). Only links true today count.</li>
            <li>A table sees the first step. Steps two to four come from the linked records in FalkorDB, each with the path that proves it. "Come up together" is community detection on this business alone.</li>
            {d.errors.length > 0 && <li>Not shown just now: {d.errors.join("; ")}.</li>}
          </ul>
        </Reveal>
      )}
    </section>
  );
}

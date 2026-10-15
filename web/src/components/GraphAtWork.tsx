// "What breaks if this stops": the Brain page's calm view of what only connected records can answer. For one system,
// what stops straight away (one step) against everything down the line (up to four steps), each far item with the
// path that links it back, and who looks after it. Behind expanders: the most connected parts of the business
// (PageRank) and the things that come up together (communities). Everything is read from the business's own graph
// (GET /api/:t/graph/at-work). An empty answer says which kind: not in your records, not mapped yet, or nothing
// downstream.
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
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
const things = (n: number) => `${n} ${n === 1 ? "thing" : "things"}`;

export function GraphAtWorkPanel({ tenantId, onPick }: { tenantId: string; onPick: (id: string) => void }) {
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const [typed, setTyped] = useState("");
  useEffect(() => { setFocus(undefined); setTyped(""); }, [tenantId]);
  const res = useAsync(() => api.graphAtWork(tenantId, focus), [tenantId, focus]);
  const d = res.data;
  if (d === null) return null; // demo data without the live server: this panel needs the real graph
  const f = d?.focus;
  const ask = (e: FormEvent) => { e.preventDefault(); if (typed.trim()) setFocus(typed.trim()); };

  return (
    <section className="gw" aria-labelledby="gw-title">
      <div className="gw-head">
        <h2 id="gw-title" className="bs-section-title">What breaks if something stops</h2>
        <p className="gw-sub">Your records are linked, so your team can follow a problem past the first thing it touches.</p>
      </div>

      {d && d.candidates.length > 0 && (
        <form className="gw-pick" onSubmit={ask}>
          <label className="gw-pick-label" htmlFor="gw-select">Check</label>
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
            <p><b>{d.notFound.message}</b> Nothing was looked up, so this is not an answer about what depends on it.</p>
            {d.notFound.suggestions.length > 0 && (
              <p className="gw-sugs">Closest things I do have: {d.notFound.suggestions.map((s, i) => (
                <span key={s.id}>{i > 0 && ", "}<button type="button" className="gw-link" onClick={() => { setTyped(""); setFocus(s.id); }}>{s.name}</button></span>
              ))}</p>
            )}
          </div>
        ) : !f ? (
          <p className="gw-msg">No systems or channels are in your records yet.</p>
        ) : (
          <div className="gw-body" aria-live="polite">
            {f.status === "impact" ? (
              <p className="gw-lede">
                If <b>{f.name}</b> stops, <b>{things(f.shallow.total)}</b> stop straight away.
                {f.deep.total > f.shallow.total
                  ? <> Following the links further, <b>{things(f.deep.total)}</b> are affected in all.</>
                  : <> Nothing further down the line is recorded.</>}
              </p>
            ) : (
              <p className={`gw-lede${f.status === "not_mapped" ? " gw-unmapped" : ""}`}>
                {f.status === "not_mapped"
                  ? <><b>{f.name}</b> is in your records, but nobody has recorded what depends on it yet. That is not the same as nothing depending on it.</>
                  : <>Nothing in your records depends on <b>{f.name}</b>. What it needs is recorded, so this is a real "nothing downstream".</>}
              </p>
            )}
            {f.owners.length > 0 ? (
              <p className="gw-owner">Looked after by {f.owners.map((o, i) => (
                <span key={o.id}>{i > 0 && ", "}<button type="button" className="gw-link" onClick={() => onPick(o.id)}>{o.name}</button>{o.via ? ` (through ${o.via})` : ""}</span>
              ))}</p>
            ) : <p className="gw-owner">No owner is recorded for it.</p>}

            {f.status === "impact" && (
              <div className="gw-cols">
                <div className="gw-col">
                  <h3 className="gw-col-title">Straight away <span>one step</span></h3>
                  <ul className="gw-list">
                    {f.shallow.items.map((i) => (
                      <li key={i.id}><button type="button" className="gw-link" onClick={() => onPick(i.id)}>{i.name}</button> <span className="gw-kind">{kindName(i.type)}</span></li>
                    ))}
                  </ul>
                </div>
                <div className="gw-col">
                  <h3 className="gw-col-title">Further down the line <span>up to four steps</span></h3>
                  {f.deep.items.filter((i) => i.hop > 1).length === 0 ? <p className="gw-none">Nothing beyond the first step.</p> : (
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
                  {f.deep.more && <p className="gw-none">There are more; the first 60 are shown.</p>}
                </div>
              </div>
            )}
          </div>
        )}

      {d && d.important.length > 0 && (
        <Reveal tone="row" label="The most connected parts of your business" summary={`${d.important.length}`}>
          <p className="gw-blurb">The things most of your records lead to. A problem here travels furthest.</p>
          <ol className="gw-rank">
            {d.important.map((x) => (
              <li key={x.id}><button type="button" className="gw-link" onClick={() => onPick(x.id)}>{x.name}</button> <span className="gw-kind">{kindName(x.type)}</span></li>
            ))}
          </ol>
        </Reveal>
      )}
      {d && d.groups.length > 0 && (
        <Reveal tone="row" label="Things that come up together" summary={`${d.groups.length} groups`}>
          <p className="gw-blurb">Notes and the things they mention, grouped by how they link to each other.</p>
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
            <li>"What breaks" follows your records one step at a time: what <i>needs</i> the thing (DEPENDS_ON), and what it <i>holds up</i> or <i>affects</i> (BLOCKS, AFFECTS). Only links that are true today count; ended ones are kept for history but skipped.</li>
            <li>A table lookup sees the first step. Steps two to four are what a linked graph adds, and each one comes with the path that proves it.</li>
            <li>"Most connected" is PageRank, and "come up together" is community detection, both run by FalkorDB on this business's graph alone.</li>
            {d.errors.length > 0 && <li>Not shown just now: {d.errors.join("; ")}.</li>}
          </ul>
        </Reveal>
      )}
    </section>
  );
}

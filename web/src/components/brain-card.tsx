// A thing your team knows, in the slim panel beside the map (a bottom sheet on a phone): what it is in one line, two
// buttons (ask about it, what breaks if it stops), how we know (its facts and where they came from, with dates) and what
// it is linked to. Plus the search box that finds anything and the coloured dot every list uses.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { api, getMode } from "../api";
import { fmtNum } from "../lib/format";
import { askAbout, factsOf, impactLine, impactLinks, oneLine } from "../lib/brain-map";
import { TEAM, chatPath } from "../lib/chat";
import { hueFor, labelOfId } from "../lib/labels";
import type { EdgeRef, NodeRef } from "@shared/contracts";
import type { NodeDetail, SearchHit } from "../types-ext";
import { fmtValue, humanKey, kindName, relPhrase, tidyName, whenWords } from "./brain-words";
import type { GraphAtWork } from "./GraphAtWork";
import { Icon } from "./Icon";
import { Reveal } from "./Reveal";

export const Dot = ({ label }: { label: string }) => <span className="bn-dot" style={{ ["--hue" as string]: hueFor(label) }} aria-hidden="true" />;

// ---------------------------------------------------------------- search

export function SearchBox({ tenantId, onPick, placeholder = "Search what your team knows" }: { tenantId: string; onPick: (id: string) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  // The hits and the term they answer: until the search for the typed term comes back, the list says "Searching"
  // rather than "Nothing matches" (it flashed for a second before every result, 18 Oct).
  const [found, setFound] = useState<{ term: string; hits: SearchHit[]; failed?: boolean }>({ term: "", hits: [] });
  const hits = found.hits;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setFound({ term: "", hits: [] }); return; }
    let live = true;
    const t = setTimeout(() => {
      api.search(tenantId, term).then(
        (h) => { if (live) { setFound({ term, hits: h }); setActive(0); } },
        () => { if (live) setFound({ term, hits: [], failed: true }); },
      );
    }, 140);
    return () => { live = false; clearTimeout(t); };
  }, [q, tenantId]);

  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [open]);

  const pick = (h: SearchHit | undefined) => {
    if (!h) return;
    onPick(h.node.id);
    setOpen(false);
    setQ("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(hits[active]); }
    else if (e.key === "Escape") setOpen(false);
  };
  const showList = open && q.trim().length > 0;
  const searching = found.term !== q.trim();

  return (
    <div className="bn-search" ref={wrap}>
      <Icon name="search" size={18} className="bn-search-icon" />
      <input
        className="field bn-search-input"
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && hits[active] ? `${listId}-${active}` : undefined}
        aria-label={placeholder}
        placeholder={placeholder}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {showList && (
        <ul id={listId} className="search-list" role="listbox" aria-label="Matches">
          {hits.length === 0 ? (
            <li className="search-empty" role="presentation">
              {searching ? "Searching…"
                : found.failed ? "We couldn't search just now. Try again in a moment."
                : <>Nothing matches “{q.trim()}”. Try a name, a page or a month.</>}
            </li>
          ) : hits.map((h, i) => (
            <li
              key={h.node.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`search-hit${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(h); }}
            >
              <Dot label={h.node.label} />
              <span className="search-hit-text">
                <span className="search-hit-name">{tidyName(h.node.label, h.node.name)}</span>
                {h.snippet && <span className="search-hit-snip">{h.snippet}</span>}
              </span>
              <span className="search-hit-label">{kindName(h.node.label)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the panel

const SHOWN_LINKS = 6;
const SHOWN_BREAKS = 5;

/** What the map lights up for "What breaks if this stops". */
export interface ImpactShown { id: string; ids: string[]; nodes: NodeRef[]; edges: EdgeRef[] }

export function ThingPanel({ tenantId, id, detail, loading, error, onSelect, onClose, onImpact }: {
  tenantId: string; id: string; detail?: NodeDetail; loading: boolean; error?: string;
  onSelect: (id: string) => void; onClose: () => void; onImpact: (shown: ImpactShown | null) => void;
}) {
  const [impact, setImpact] = useState<{ loading: boolean; data?: GraphAtWork | null; error?: string } | null>(null);
  useEffect(() => { setImpact(null); }, [id, tenantId]);
  const canImpact = getMode() === "live";

  const checkImpact = () => {
    if (impact) { setImpact(null); onImpact(null); return; }
    setImpact({ loading: true });
    api.graphAtWork(tenantId, id).then((data) => {
      setImpact({ loading: false, data });
      const f = data?.focus;
      if (f && f.status === "impact") onImpact({ id, ...impactLinks(f, f.deep.items) });
    }, (e: unknown) => setImpact({ loading: false, error: (e as Error)?.message ?? String(e) }));
  };

  const links = useMemo(() => {
    const cited = new Set((detail?.sources ?? []).map((s) => s.id)); // already listed under "How we know"
    const seen = new Set<string>();
    return (detail?.neighbors ?? []).filter((n) => {
      if (n.edge.type === "SOURCED_FROM" && cited.has(n.node.id)) return false;
      const k = `${n.node.id}|${n.edge.type}|${n.direction}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [detail]);

  const head = (label: string, when?: string) => (
    <div className="tp-head">
      <p className="tp-kind"><Dot label={label} />{kindName(label)}{when ? ` · ${whenWords(when)}` : ""}</p>
      <button type="button" className="btn btn-quiet btn-icon btn-sm" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
    </div>
  );

  if (!detail) {
    return (
      <div className="tp">
        {head(labelOfId(id))}
        {loading ? (
          <><span className="skeleton" style={{ display: "block", height: 28, width: "70%" }} /><span className="skeleton" style={{ display: "block", height: 44 }} /></>
        ) : (
          <p className="tp-line">{error ? `We couldn't open this: ${error}` : "Your team doesn't have this one in its notes."}</p>
        )}
      </div>
    );
  }

  const n = detail.node;
  const name = tidyName(n.label, n.name);
  const line = oneLine(n.summary) ?? `${kindName(n.label)}, linked to ${fmtNum(links.length)} ${links.length === 1 ? "thing" : "things"}.`;
  const facts = factsOf(detail.props);
  const f = impact?.data?.focus;

  return (
    <div className="tp">
      {head(n.label, n.asOf)}
      <h2 className="tp-name">{name}</h2>
      {n.simulated && <span className="badge badge-warn tp-sample">Sample numbers</span>}
      <p className="tp-line">{line}</p>
      <div className="tp-actions">
        <Link className="btn btn-gold btn-sm" to={`${chatPath(TEAM)}?q=${encodeURIComponent(askAbout(name))}`}><Icon name="ask" size={14} /> Ask about this</Link>
        {canImpact && (
          <button type="button" className={`btn btn-ghost btn-sm${impact ? " is-on" : ""}`} aria-pressed={!!impact} onClick={checkImpact}>
            <Icon name="warn" size={14} /> What breaks if this stops
          </button>
        )}
      </div>

      {impact && (
        <section className="tp-breaks" aria-live="polite" aria-label="What breaks if this stops">
          {impact.loading ? <span className="skeleton" style={{ display: "block", height: 40 }} />
            : impact.error ? <p className="tp-muted">We couldn't check this just now. {impact.error}</p>
            : !f ? <p className="tp-muted">{impact.data?.notFound?.message ?? "We couldn't check this one."}</p>
            : (
              <>
                <p className="tp-breaks-line">{impactLine(name, f.status, f.shallow.total, f.deep.total)}</p>
                {f.status === "impact" && (
                  <ul className="tp-rows">
                    {f.deep.items.slice(0, SHOWN_BREAKS).map((i) => (
                      <li key={i.id}>
                        <button type="button" className="tp-row" onClick={() => onSelect(i.id)}>
                          <Dot label={i.type} /><span className="tp-row-name">{i.name}</span>
                          <span className="tp-row-note">{i.hop === 1 ? "straight away" : `${i.hop} steps away`}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {f.status === "impact" && f.deep.total > SHOWN_BREAKS && <p className="tp-muted">and {f.deep.total - SHOWN_BREAKS} more, lit up on the map</p>}
                {f.owners.length > 0 && <p className="tp-muted">Looked after by {f.owners.map((o) => o.name).join(", ")}</p>}
              </>
            )}
        </section>
      )}

      {(facts.length > 0 || detail.sources.length > 0) && (
        <section className="tp-section" aria-label="How we know">
          <h3 className="tp-title">How we know</h3>
          {facts.length > 0 && (
            <dl className="tp-facts">
              {facts.map(([k, v]) => <div key={k}><dt>{humanKey(k)}</dt><dd>{fmtValue(v)}</dd></div>)}
            </dl>
          )}
          {detail.sources.length > 0 && (
            <ul className="tp-rows">
              {detail.sources.slice(0, 4).map((s) => (
                <li key={s.id}>
                  <button type="button" className="tp-row" onClick={() => onSelect(s.id)}>
                    <Icon name="file" size={13} /><span className="tp-row-name">{s.title}</span>
                    {s.asOf && <span className="tp-row-note">{whenWords(s.asOf)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {links.length > 0 && (
        <section className="tp-section" aria-label="Linked to">
          <h3 className="tp-title">Linked to <span className="tp-count">{fmtNum(links.length)}</span></h3>
          <LinkRows list={links.slice(0, SHOWN_LINKS)} onSelect={onSelect} />
          {links.length > SHOWN_LINKS && (
            <Reveal label={`Show ${links.length - SHOWN_LINKS} more`} openLabel="Show fewer">
              <LinkRows list={links.slice(SHOWN_LINKS)} onSelect={onSelect} />
            </Reveal>
          )}
        </section>
      )}
    </div>
  );
}

function LinkRows({ list, onSelect }: { list: NodeDetail["neighbors"]; onSelect: (id: string) => void }) {
  return (
    <ul className="tp-rows">
      {list.map((nb) => (
        <li key={`${nb.node.id}|${nb.edge.type}|${nb.direction}`}>
          <button type="button" className="tp-row" onClick={() => onSelect(nb.node.id)}>
            <Dot label={nb.node.label} />
            <span className="tp-row-name">{tidyName(nb.node.label, nb.node.name)}</span>
            <span className="tp-row-note">{relPhrase(nb.edge.type, nb.direction).toLowerCase()}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

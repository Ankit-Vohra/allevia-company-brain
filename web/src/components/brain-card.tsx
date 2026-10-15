// A thing your team knows, as a readable card (what it is, what it says, where it comes from, what it is connected to),
// and the search box that finds one. The technical detail (properties, history, the id) sits behind "Show how we know this".
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { fmtNum } from "../lib/format";
import { fmtDate } from "./bits";
import { hueFor, labelOfId } from "../lib/labels";
import type { NodeDetail, SearchHit } from "../types-ext";
import { fmtValue, humanKey, kindName, relPhrase, tidyName, whenWords } from "./brain-words";
import { Icon } from "./Icon";
import { Reveal } from "./Reveal";

export const Dot = ({ label }: { label: string }) => <span className="bn-dot" style={{ ["--hue" as string]: hueFor(label) }} aria-hidden="true" />;

// ---------------------------------------------------------------- search

export function SearchBox({ tenantId, onPick, placeholder = "Search what your team knows" }: { tenantId: string; onPick: (id: string) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => { api.search(tenantId, term).then((h) => { if (live) { setHits(h); setActive(0); } }, () => {}); }, 140);
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
            <li className="search-empty" role="presentation">Nothing matches “{q.trim()}”. Try a name, a page or a month.</li>
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

// ---------------------------------------------------------------- the card

const SHOWN_LINKS = 6;

export function NodeCard({ id, detail, loading, error, onSelect, onClose, onExplore, variant }: {
  id: string; detail?: NodeDetail; loading: boolean; error?: string;
  onSelect: (id: string) => void; onClose?: () => void; onExplore?: () => void; variant: "page" | "panel";
}) {
  const groups = useMemo(() => {
    const m = new Map<string, NodeDetail["neighbors"]>();
    const cited = new Set((detail?.sources ?? []).map((s) => s.id)); // already listed under "Where this comes from"
    for (const n of detail?.neighbors ?? []) {
      if (n.edge.type === "SOURCED_FROM" && cited.has(n.node.id)) continue;
      const k = `${n.direction}|${n.edge.type}`;
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return [...m.entries()];
  }, [detail]);

  const close = onClose && (
    <button type="button" className="btn btn-quiet btn-icon btn-sm" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
  );

  if (!detail) {
    return (
      <div className={`bn-card is-${variant}`}>
        <div className="bn-head"><p className="bn-kind">{kindName(labelOfId(id))}</p>{close}</div>
        {loading ? (
          <><span className="skeleton" style={{ display: "block", height: 32, width: "70%" }} /><span className="skeleton" style={{ display: "block", height: 72 }} /></>
        ) : (
          <p className="empty">{error ? `We couldn't open this: ${error}` : "Your team doesn't have this one in its notes."}</p>
        )}
      </div>
    );
  }

  const n = detail.node;
  const props = Object.entries(detail.props).filter(([k]) => k !== "asOf" && k !== "simulated");
  const flat = groups.flatMap(([k, list]) => list!.map((nb) => ({ k, nb })));
  const renderGroups = (subset: typeof flat) => {
    const by = new Map<string, typeof flat>();
    for (const x of subset) by.set(x.k, [...(by.get(x.k) ?? []), x]);
    return (
      <div className="bn-links">
        {[...by.entries()].map(([k, list]) => {
          const [dir, type] = k.split("|") as ["out" | "in", string];
          return (
            <div key={k} className="bn-link-group">
              <p className="bn-rel">{relPhrase(type, dir)}</p>
              <ul>
                {list.map(({ nb }) => (
                  <li key={nb.node.id + k}>
                    <button type="button" className="bn-row" onClick={() => onSelect(nb.node.id)}>
                      <Dot label={nb.node.label} />
                      <span className="bn-row-name">{tidyName(nb.node.label, nb.node.name)}</span>
                      <span className="bn-row-kind">{kindName(nb.node.label)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className={`bn-card is-${variant}`}>
      <div className="bn-head">
        <p className="bn-kind"><Dot label={n.label} />{kindName(n.label)}{n.asOf ? ` · ${whenWords(n.asOf)}` : ""}</p>
        {close}
      </div>
      <h2 className="bn-name">{tidyName(n.label, n.name)}</h2>
      {n.simulated && <span className="badge badge-warn bn-sample">Sample numbers</span>}
      {n.summary && <p className="bn-summary">{n.summary}</p>}
      <div className="bn-actions">
        <Link className="btn btn-gold" to={`/ask?q=${encodeURIComponent(`What should I know about ${n.name}?`)}`}><Icon name="ask" size={15} /> Ask about this</Link>
        {onExplore && <button type="button" className="btn btn-ghost" onClick={onExplore}>Explore around it</button>}
      </div>

      {detail.sources.length > 0 && (
        <section className="bn-section" aria-labelledby={`bn-src-${variant}`}>
          <h3 id={`bn-src-${variant}`} className="bn-section-title">Where this comes from</h3>
          <ul className="bn-sources">
            {detail.sources.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => onSelect(s.id)} className="bn-row">
                  <Icon name="file" size={14} />
                  <span className="bn-row-name">{s.title}</span>
                  {s.asOf && <span className="bn-row-kind">{whenWords(s.asOf)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {flat.length > 0 && (
        <section className="bn-section" aria-labelledby={`bn-nb-${variant}`}>
          <h3 id={`bn-nb-${variant}`} className="bn-section-title">Connected to <span className="bn-count">{fmtNum(flat.length)}</span></h3>
          {renderGroups(flat.slice(0, SHOWN_LINKS))}
          {flat.length > SHOWN_LINKS && (
            <Reveal label={`Show ${flat.length - SHOWN_LINKS} more`} openLabel="Show fewer">{renderGroups(flat.slice(SHOWN_LINKS))}</Reveal>
          )}
        </section>
      )}

      <Reveal label="Show how we know this" className="bn-how">
        <div className="bn-how-body">
          {props.length > 0 && (
            <dl className="bn-props">
              {props.map(([k, v]) => <div key={k}><dt>{humanKey(k)}</dt><dd>{fmtValue(v)}</dd></div>)}
              <div><dt>Importance</dt><dd>{fmtNum(Math.round((n.rank ?? 0) * 100))} out of 100</dd></div>
            </dl>
          )}
          {detail.versions.length > 0 && (
            <>
              <p className="bn-section-title">How it changed</p>
              <ol className="bn-history">
                {[...detail.versions].reverse().map((v, i) => (
                  <li key={i} className={v.until ? "" : "is-current"}>
                    <p className="bn-history-when">{fmtDate(v.since)} to {v.until ? fmtDate(v.until) : "now"}</p>
                    <p className="bn-history-what">{Object.entries(v.props).map(([k, val]) => `${humanKey(k)}: ${fmtValue(val)}`).join(" · ")}</p>
                    {v.src && <button type="button" className="bn-history-src" onClick={() => onSelect(v.src!)}>{v.src.split(":").slice(1).join(":")}</button>}
                  </li>
                ))}
              </ol>
            </>
          )}
          <p className="bn-id"><code>{n.id}</code></p>
        </div>
      </Reveal>
    </div>
  );
}

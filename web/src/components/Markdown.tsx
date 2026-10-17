// Answer markdown with its [[node-id]] citations drawn the way Claude and Gemini draw them: a small superscript number at the
// end of the clause (web/src/lib/cites.ts numbers them), a popover with what it is, where it was read and when, and one
// quiet "Sources (N)" row at the end that opens the numbered list.
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import type { NodeRef } from "@shared/contracts";
import { CITE_HREF, citeAria, citeInfo, idsOfHref, markerText, numberCitations, type CiteInfo, type CiteSources } from "../lib/cites";
import { Reveal } from "./Reveal";

interface CiteCtx { nodes?: Record<string, NodeRef>; sources?: CiteSources; onCite?: (id: string) => void; activeId?: string }

/** One source's details and its action, as the popover and the Sources list both show it. */
function CiteDetail({ c, onCite, onDone }: { c: CiteInfo; onCite?: (id: string) => void; onDone?: () => void }) {
  return (
    <div className="cite-detail">
      <p className="cite-kind"><span className="cite-dot" style={{ ["--hue" as string]: c.hue } as CSSProperties} aria-hidden="true" />{c.kind}</p>
      <p className="cite-name">{c.name}</p>
      <p className="cite-from">
        <span>{c.from}</span>
        {c.open === "approval" ? (
          <Link className="cite-open" to={`/approvals#${encodeURIComponent(c.id)}`} onClick={onDone}>Open</Link>
        ) : onCite ? (
          <button type="button" className="cite-open" onClick={() => { onCite(c.id); onDone?.(); }}>Open on the map</button>
        ) : null}
      </p>
    </div>
  );
}

/** The superscript marker for one group of sources (¹, or ¹, ² together), with its popover on hover, tap or Enter. */
export function CiteMarker({ cites, onCite, active }: { cites: CiteInfo[]; onCite?: (id: string) => void; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const hoverT = useRef<number | undefined>(undefined);
  const byKey = useRef(false);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);

  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect();
    if (!b) return;
    const w = Math.min(300, window.innerWidth - 32);
    const left = Math.max(16, Math.min(b.left + b.width / 2 - w / 2, window.innerWidth - 16 - w));
    const h = pop.current?.offsetHeight ?? 120;
    const above = b.bottom + 8 + h > window.innerHeight && b.top - 8 - h > 0;
    setPos({ left, top: above ? b.top - 6 - h : b.bottom + 6, above });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    // opened from the keyboard: focus moves into the popover (its action, else the popover itself)
    if (byKey.current) (pop.current?.querySelector<HTMLElement>("a, button") ?? pop.current)?.focus();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !pop.current?.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); btn.current?.focus(); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  const hover = (on: boolean) => (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    window.clearTimeout(hoverT.current);
    hoverT.current = window.setTimeout(() => setOpen(on), on ? 120 : 220);
  };

  const ns = cites.map((c) => c.n);
  const label = cites.length === 1 ? citeAria(cites[0]!) : `Sources ${markerText(ns)}: ${cites.map((c) => `${c.n}, ${c.name}`).join("; ")}`;
  return (
    <sup className="cite-sup">
      <button
        ref={btn}
        type="button"
        className={`cite-mark${active ? " is-active" : ""}${open ? " is-open" : ""}`}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => { e.preventDefault(); window.clearTimeout(hoverT.current); byKey.current = e.detail === 0; setOpen((v) => !v); }}
        onPointerEnter={hover(true)}
        onPointerLeave={hover(false)}
      >
        {markerText(ns)}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        // on the page's body, not inside the sentence: a <p> may not hold it, and it must not inherit the superscript's size
        <div
          ref={pop}
          id={id}
          role="dialog"
          aria-label={cites.length === 1 ? `Source ${ns[0]}` : `Sources ${markerText(ns)}`}
          className={`cite-pop${pos?.above ? " is-above" : ""}`}
          style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
          tabIndex={-1}
          onPointerEnter={hover(true)}
          onPointerLeave={hover(false)}
          onKeyDown={(e) => {
            // Tab out of the popover returns to the marker, so the reading order stays the sentence's
            const items = [...(pop.current?.querySelectorAll<HTMLElement>("a, button") ?? [])];
            const edge = e.shiftKey ? items[0] : items[items.length - 1];
            if (e.key === "Tab" && (!items.length || document.activeElement === edge || document.activeElement === pop.current)) {
              e.preventDefault(); close(); btn.current?.focus();
            }
          }}
        >
          {cites.map((c) => (
            <div key={c.id} className="cite-pop-item">
              <span className="cite-pop-n" aria-hidden="true">{c.n}</span>
              <CiteDetail c={c} onCite={onCite} onDone={close} />
            </div>
          ))}
        </div>,
        document.body,
      )}
    </sup>
  );
}

/** The numbered list behind "Sources (N)". */
export function SourcesList({ cites, onCite }: { cites: CiteInfo[]; onCite?: (id: string) => void }) {
  return (
    <ol className="cite-list">
      {cites.map((c) => (
        <li key={c.id} className="cite-list-item">
          <span className="cite-pop-n" aria-hidden="true">{c.n}</span>
          <CiteDetail c={c} onCite={onCite} />
        </li>
      ))}
    </ol>
  );
}

interface Props {
  text: string;
  nodes?: Record<string, NodeRef>;
  /** Where each cited thing was read (lib/cites citeSources), for the popover's "read 7 Oct" line. */
  sources?: CiteSources;
  onCite?: (id: string) => void;
  activeId?: string;
  className?: string;
  /** Show the "Sources (N)" row under the text (answers and notes; not a one-line finding). */
  sourcesRow?: boolean;
}

export const Markdown = memo(function Markdown({ text, nodes, sources, onCite, activeId, className, sourcesRow }: Props) {
  const { md, ids } = numberCitations(text);
  const ctx: CiteCtx = { nodes, sources, onCite, activeId };
  const infoOf = (id: string) => citeInfo(id, ids.indexOf(id) + 1, ctx.nodes?.[id], ctx.sources?.[id]);
  const components: Components = {
    a: ({ href, children }) => {
      if (href?.startsWith(CITE_HREF)) {
        const group = idsOfHref(href).filter((id) => ids.includes(id)).map(infoOf);
        return group.length ? <CiteMarker cites={group} onCite={onCite} active={!!activeId && group.some((c) => c.id === activeId)} /> : null;
      }
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
  };
  return (
    <div className={`md ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(u) => u}>
        {md}
      </ReactMarkdown>
      {sourcesRow && ids.length > 0 && (
        <Reveal className="cite-sources" label={`Sources (${ids.length})`}>
          <SourcesList cites={ids.map(infoOf)} onCite={onCite} />
        </Reveal>
      )}
    </div>
  );
});

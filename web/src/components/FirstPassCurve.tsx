// The first-pass curve (product design §3.2 "Learning made visible"): the share of drafts approved without an edit over
// the 30 days up to each day of the program, drawn across the whole 90 days so the line visibly grows into its window.
// The dashed line is the program's target: about 30% by day 30, 60% by day 90. One series, so no legend: the title
// names it. Hover or focus reads any day.
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { FirstPassPoint } from "@shared/contracts";
import { fmtDate, fmtPct } from "../lib/format";

const DAY = 86_400_000;
const W = 300, H = 64; // viewBox; drawn with non-scaling strokes, so it stretches to any width
const TARGET: Array<[number, number]> = [[30, 0.3], [90, 0.6]];

const dayOf = (startDate: string, date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY);

export function FirstPassCurve({ series, startDate, day, length = 90 }: { series: FirstPassPoint[]; startDate: string; day: number; length?: number }) {
  const x = (d: number) => (Math.max(0, Math.min(length, d)) / length) * W;
  const y = (r: number) => H - 3 - r * (H - 6);
  const pts = useMemo(() => series.map((p) => ({ ...p, d: dayOf(startDate, p.date) })).filter((p) => p.d >= 0 && p.d <= length), [series, startDate, length]);
  const known = pts.filter((p) => p.rate !== null);

  // the line, broken where a day has no decision yet
  const { line, area } = useMemo(() => {
    let line = "", area = "", run: typeof pts = [];
    const flush = () => {
      if (!run.length) return;
      const seg = run.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(2)} ${y(p.rate!).toFixed(2)}`).join("");
      line += seg;
      area += `${seg}L${x(run[run.length - 1]!.d).toFixed(2)} ${H}L${x(run[0]!.d).toFixed(2)} ${H}Z`;
      run = [];
    };
    for (const p of pts) { if (p.rate === null) flush(); else run.push(p); }
    flush();
    return { line, area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, length]);

  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pick = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const d = Math.round(((e.clientX - r.left) / r.width) * length);
    setHover(Math.max(0, Math.min(day, d)));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); setHover((h) => Math.max(0, (h ?? day) - 1)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setHover((h) => Math.min(day, (h ?? day) + 1)); }
    else if (e.key === "Escape") setHover(null);
  };
  const hp = hover === null ? undefined : pts.find((p) => p.d === hover);
  const last = known[known.length - 1];
  const pctX = (d: number) => `${(Math.max(0, Math.min(length, d)) / length) * 100}%`;
  const pctY = (r: number) => `${(y(r) / H) * 100}%`;

  const summary = last
    ? `Drafts you approved as they were: ${fmtPct(last.rate!)} so far, heading for about 60% by the end of month 3.`
    : "No drafts decided yet.";

  return (
    <figure className="fp-curve">
      <div
        ref={box}
        className="fp-plot"
        role="img"
        aria-label={summary}
        tabIndex={0}
        onPointerMove={pick}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover(day)}
        onBlur={() => setHover(null)}
        onKeyDown={onKey}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <rect className="fp-future" x={x(day)} y="0" width={Math.max(0, W - x(day))} height={H} />
          {[0.3, 0.6].map((r) => <line key={r} className="fp-grid" x1="0" x2={W} y1={y(r)} y2={y(r)} vectorEffect="non-scaling-stroke" />)}
          <line className="fp-base" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} vectorEffect="non-scaling-stroke" />
          <polyline className="fp-target" points={TARGET.map(([d, r]) => `${x(d)},${y(r)}`).join(" ")} vectorEffect="non-scaling-stroke" />
          {area && <path className="fp-area" d={area} />}
          {line && <path className="fp-line" d={line} vectorEffect="non-scaling-stroke" />}
          <line className="fp-today" x1={x(day)} x2={x(day)} y1="0" y2={H} vectorEffect="non-scaling-stroke" />
          {hover !== null && <line className="fp-cross" x1={x(hover)} x2={x(hover)} y1="0" y2={H} vectorEffect="non-scaling-stroke" />}
        </svg>
        <span className="fp-axis-r" style={{ top: pctY(0.6) }}>60%</span>
        <span className="fp-axis-r" style={{ top: pctY(0.3) }}>30%</span>
        {last && <span className="fp-dot" style={{ left: pctX(last.d), top: pctY(last.rate!) }} aria-hidden="true" />}
        {hp?.rate != null && <span className="fp-dot is-hover" style={{ left: pctX(hp.d), top: pctY(hp.rate) }} aria-hidden="true" />}
        {!known.length && <span className="fp-empty">No drafts decided yet. The curve starts with your first approval.</span>}
        {hover !== null && (
          <span className={`fp-tip${hover > length * 0.6 ? " is-left" : ""}`} style={{ left: pctX(hover) }} role="status">
            <b>{fmtDate(hp?.date ?? new Date(Date.parse(`${startDate}T00:00:00Z`) + hover * DAY).toISOString().slice(0, 10))}</b>
            <br />
            {hp?.rate != null ? <>{fmtPct(hp.rate)} approved as they were · {hp.firstPass} of {hp.decided}</> : "No decisions yet"}
          </span>
        )}
      </div>
      <figcaption className="fp-axis">
        <span>Start</span><span>Month 1</span><span>Month 2</span><span>Month 3</span>
      </figcaption>
    </figure>
  );
}

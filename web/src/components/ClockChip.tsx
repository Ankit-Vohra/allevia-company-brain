// The office clock chip: "Raipur · 11:42 · morning", with a sun or a moon. It opens a slider that previews the office at
// any time of day (a demo feature: the office is lit by the business's own clock, and this lets you see the whole day).
import { useEffect, useRef, useState } from "react";
import { PHASE_LABEL, fmtClock, placeOf, setPreviewMinutes, useOfficeClock } from "../lib/daylight";
import { useApp } from "../state/app";
import { Icon } from "./Icon";

const PRESETS: { label: string; at: number }[] = [
  { label: "Morning", at: 9 * 60 },
  { label: "Midday", at: 13 * 60 },
  { label: "Golden hour", at: 17 * 60 + 30 },
  { label: "Evening", at: 19 * 60 + 30 },
  { label: "Night", at: 22 * 60 },
];

export function ClockChip() {
  const { tenant } = useApp();
  const clock = useOfficeClock(tenant.timeZone);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const night = clock.phase === "night" || clock.phase === "evening";
  const place = placeOf(tenant.city, tenant.timeZone);
  const label = `${place} · ${fmtClock(clock.minutes)} · ${PHASE_LABEL[clock.phase]}`;
  return (
    <div className="clock" ref={ref}>
      <button type="button" className={`clock-chip${clock.previewing ? " is-preview" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="See the office at any time of day">
        <Icon name={night ? "moon" : "sun"} size={15} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="clock-pop" role="dialog" aria-label="Preview the office at any time of day">
          <p className="clock-pop-title">The office follows {place} time</p>
          <p className="clock-pop-sub">Drag to see it at any hour. The light changes smoothly, from morning sun to evening lamps.</p>
          <input
            className="clock-range"
            type="range"
            min={0}
            max={1439}
            step={5}
            value={Math.round(clock.minutes)}
            onChange={(e) => setPreviewMinutes(Number(e.target.value))}
            aria-label="Time of day"
            aria-valuetext={`${fmtClock(clock.minutes)}, ${PHASE_LABEL[clock.phase]}`}
          />
          <div className="clock-scale" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
          <div className="clock-presets">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" className="clock-preset" onClick={() => setPreviewMinutes(p.at)}>{p.label}</button>
            ))}
          </div>
          {clock.previewing && (
            <button type="button" className="btn btn-ghost btn-sm clock-live" onClick={() => setPreviewMinutes(null)}>Back to {fmtClock(clock.real)} now</button>
          )}
        </div>
      )}
    </div>
  );
}

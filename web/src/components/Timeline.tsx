// The three months as one line, with the monthly check-ins marked (used by the growth plan page).
import type { ProgramCheckpoint } from "@shared/contracts";
import { monthWeek } from "../lib/plainwords";

const NAME: Record<number, string> = { 0: "Start", 30: "Month 1", 60: "Month 2", 90: "Month 3" };

export function Timeline({ day, checkpoints }: { day: number; checkpoints: ProgramCheckpoint[] }) {
  const pct = (d: number) => `${(Math.max(0, Math.min(90, d)) / 90) * 100}%`;
  return (
    <div className="p90-line" role="img" aria-label={`${monthWeek(day)} of your first three months. Monthly check-ins: ${checkpoints.filter((c) => c.day > 0).map((c) => `${NAME[c.day]} ${c.status === "done" ? "done" : "coming"}`).join(", ")}.`}>
      <span className="p90-track" aria-hidden="true"><span className="p90-fill" style={{ width: pct(day) }} /></span>
      <span className="p90-today" style={{ left: pct(day) }} aria-hidden="true" />
      {checkpoints.map((c) => (
        <span key={c.day} className={`p90-cp is-${c.status}${c.day === 0 ? " is-start" : c.day === 90 ? " is-end" : ""}`} style={{ left: pct(c.day) }} aria-hidden="true">
          <span className="p90-cp-dot" />
          <span className="p90-cp-label">{NAME[c.day]}</span>
        </span>
      ))}
    </div>
  );
}

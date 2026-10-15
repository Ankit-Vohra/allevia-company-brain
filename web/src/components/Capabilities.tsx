// The capability ladder as chips (product design §2.3): each source at the best access mode Allevia has for it, with
// the one action that would move it up a rung on hover. Used on the 90-day card and next to an answer's checks.
import type { AccessMode, CapabilityState } from "@shared/contracts";
import { MODE, MODE_ORDER, SHORT_NAME, STATUS_NOTE } from "../lib/capabilities";
import { Tip } from "./Tip";
import "./capabilities.css";

type Cap = Pick<CapabilityState, "key" | "name" | "accessMode" | "status"> & Partial<Pick<CapabilityState, "upgradeHint" | "lastOkAt">>;

function hintFor(c: Cap) {
  const m = MODE[c.accessMode];
  const note = STATUS_NOTE[c.status];
  // the server's hint already opens with what the mode means ("Using industry benchmarks, …"); without one, say it here
  return (
    <>
      <span className="tip-title">{c.name} · {m.chip}{note ? `, ${note}` : ""}</span>
      <span className="tip-line">{c.upgradeHint ?? `${m.long[0]!.toUpperCase()}${m.long.slice(1)}.`}</span>
    </>
  );
}

export function ModeGlyph({ mode }: { mode: AccessMode }) {
  return <span className={`mode-glyph tone-${MODE[mode].tone}`} aria-hidden="true" />;
}

export function CapabilityChip({ cap, showMode }: { cap: Cap; showMode?: boolean }) {
  const m = MODE[cap.accessMode];
  const note = STATUS_NOTE[cap.status];
  return (
    <Tip tip={hintFor(cap)} className={`cap-chip tone-${m.tone}${note ? " has-note" : ""}`}>
      <ModeGlyph mode={cap.accessMode} />
      <span className="cap-name">{SHORT_NAME[cap.key] ?? cap.name}</span>
      {showMode && <span className="cap-mode">{m.chip}</span>}
      {note && <span className={`cap-note is-${cap.status}`}>{cap.status === "down" ? "down" : "stale"}</span>}
      <span className="visually-hidden">: {m.long}{note ? `, ${note}` : ""}.</span>
    </Tip>
  );
}

/** Every capability, grouped by mode, best rung first. */
export function CapabilityLadder({ caps }: { caps: Cap[] }) {
  const groups = MODE_ORDER.map((mode) => ({ mode, items: caps.filter((c) => c.accessMode === mode) })).filter((g) => g.items.length);
  return (
    <dl className="ladder">
      {groups.map((g) => (
        <div key={g.mode} className="ladder-row">
          <dt><ModeGlyph mode={g.mode} /> {MODE[g.mode].chip} <span className="num">{g.items.length}</span></dt>
          <dd>{g.items.map((c) => <CapabilityChip key={c.key} cap={c} />)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Next to an answer's checks: the sources it drew on at a mode other than live, and whether it said so. */
export function AnswerModes({ caps, disclosed }: { caps: Cap[]; disclosed: boolean | undefined }) {
  if (!caps.length) return null;
  return (
    <div className="answer-modes" aria-label="Where this answer's data came from">
      <span className="answer-modes-label">Data from</span>
      {caps.map((c) => <CapabilityChip key={c.key} cap={c} showMode />)}
      {disclosed === false && <span className="badge badge-warn">The answer does not say so</span>}
    </div>
  );
}

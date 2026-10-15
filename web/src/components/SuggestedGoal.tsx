import { useState, type FormEvent } from "react";
import { api } from "../api";
import { fmtNum } from "../lib/format";
import type { GoalSetup } from "../types-ext";
import { Icon } from "./Icon";
import "../pages/owner-page.css";

/** One goal the team suggests: OK as it is, or change the number. One tap each. `tenantId` is the business it belongs to
 *  (during set-up that is the business just created, not necessarily the one open in the app). */
export function SuggestedRow({ s, tenantId, onSet }: { s: GoalSetup; tenantId: string; onSet: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(s.target === null ? "" : String(s.target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const unit = s.unit ? ` ${s.unit}` : "";
  const per = s.period === "week" ? "a week" : "a month";
  const send = async (target?: number) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.setGoal(tenantId, s.id, target);
      onSet();
    } catch (e) {
      setError((e as Error)?.message ?? "That didn't save. Try again.");
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value.replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) { setError("Type a number above zero."); return; }
    void send(n);
  };
  return (
    <li className="owner-suggest-row">
      <div className="owner-suggest-text">
        <span className="owner-card-name">{s.name}</span>
        <p className="owner-suggest-title">{s.target === null ? s.name : `Get to ${fmtNum(s.target)}${unit} ${per}`}</p>
        <p className="owner-card-why">{s.baseline === null ? "We'll know where you started after your first full week." : `You're at ${fmtNum(s.baseline)} now.`}</p>
      </div>
      {editing ? (
        <form className="owner-edit" onSubmit={save}>
          <label className="visually-hidden" htmlFor={`goal-${s.id}`}>Your goal for {s.name}</label>
          <input id={`goal-${s.id}`} className="owner-input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus disabled={busy} />
          <span className="owner-edit-unit">{unit.trim()} {per}</span>
          <button type="submit" className="btn btn-gold btn-sm" disabled={busy}>Save</button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setEditing(false); setError(undefined); }} disabled={busy}>Cancel</button>
        </form>
      ) : (
        <div className="owner-suggest-actions">
          <button type="button" className="btn btn-gold btn-sm" onClick={() => void send()} disabled={busy}><Icon name="check" size={14} /> OK</button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditing(true)} disabled={busy}>Change the number</button>
        </div>
      )}
      {error && <p className="owner-error" role="alert">{error}</p>}
    </li>
  );
}


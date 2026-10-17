import { useEffect, useRef, useState, type FormEvent } from "react";
import { keySheetReady, keySheetWords } from "../lib/keysheet";
import type { KeyForm } from "../types-ext";

// The small sheet that asks for a tool's key when it has no sign-in page (Higgsfield and others on Composio). Password-type boxes,
// nothing remembered by the browser, the key sent once and cleared from the page when the sheet closes. An error from the server
// (a plain sentence: "Higgsfield didn't accept that key ...") shows inside the sheet so the owner can fix it there.
export function KeySheet({ form, onSave, onClose }: { form: KeyForm; onSave: (values: Record<string, string>) => Promise<void>; onClose: () => void }) {
  const w = keySheetWords(form);
  const ref = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open && typeof d.showModal === "function") d.showModal();
    return () => setValues({});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!keySheetReady(form, values) || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(values);
      setValues({});
    } catch (er) {
      setError((er as Error)?.message || "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="cx-sheet" aria-labelledby="cx-sheet-h" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <form className="cx-sheet-body" onSubmit={submit} autoComplete="off">
        <h2 id="cx-sheet-h" className="cx-sheet-h">{w.title}</h2>
        {w.hint && <p className="cx-quiet"><a href={w.hint.href} target="_blank" rel="noopener noreferrer">{w.hint.text}</a></p>}
        {w.boxes.map((b, i) => (
          <label key={b.name} className="cx-sheet-field" htmlFor={b.id}>
            <span className="cx-sheet-label">{b.label}</span>
            <input
              id={b.id} name={b.name} className="field" type={b.type} autoComplete={b.autoComplete} spellCheck={false} autoCapitalize="off" autoCorrect="off"
              autoFocus={i === 0} value={values[b.name] ?? ""} disabled={busy}
              onChange={(e) => setValues((v) => ({ ...v, [b.name]: e.target.value }))}
            />
            {/* the tool's own field notes are long and technical; the link above says where the key is */}
          </label>
        ))}
        {error && <p className="notice notice-bad" role="alert">{error}</p>}
        <p className="cx-sheet-promise">{w.promise}</p>
        <div className="cx-sheet-act">
          <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-gold btn-sm" disabled={busy || !keySheetReady(form, values)}>{busy ? w.saving : w.save}</button>
        </div>
      </form>
    </dialog>
  );
}

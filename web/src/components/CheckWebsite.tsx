import { useEffect, useRef, useState } from "react";
import { api, getMode, getPublicMode } from "../api";
import type { CheckupStatus } from "../types-ext";
import { ShowDetails } from "./ShowDetails";
import "./numbers.css";

// "Check my website": the free check-up (speed on phones, Google basics, a call button on the first screen...) runs in
// the background for a few minutes; this card says where it stands, then shows the verdict and the first fix, with the
// rest of the top five behind "Show how". The weekly check-up is one switch. Live server only.
const POLL_MS = 10_000;

export function CheckWebsite({ tenantId }: { tenantId: string }) {
  const [s, setS] = useState<CheckupStatus | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = getMode() === "live";
  const readOnly = getPublicMode();

  const load = () => api.checkup(tenantId).then(setS, (e: Error) => setError(e.message));
  useEffect(() => { if (live) void load(); return () => clearTimeout(timer.current); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps
  const working = s?.status === "waiting" || s?.status === "running";
  // while it runs, look again every few seconds; stop once it is done
  useEffect(() => {
    clearTimeout(timer.current);
    if (working) timer.current = setTimeout(() => void load(), POLL_MS);
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!live || !s) return null;
  const act = async (fn: () => Promise<CheckupStatus>) => {
    setBusy(true);
    setError(undefined);
    try {
      setS(await fn());
    } catch (e) {
      setError((e as Error)?.message ?? "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const [first, ...rest] = s.last?.top ?? [];

  return (
    <div className="connect" aria-live="polite">
      <h3 className="plan-h">Your website</h3>
      <p className="connect-line">{s.message}</p>
      {s.last && !working && (
        <div className="numbers-done">
          <p className="numbers-headline">{s.last.verdict}</p>
          {first && <p className="numbers-lede"><b>First fix: {first.title}.</b> {first.what}</p>}
          {rest.length > 0 && (
            <ShowDetails label="Show the other fixes" openLabel="Hide the other fixes">
              <ol className="numbers-notes">
                {rest.map((f) => <li key={f.title}><b>{f.title}.</b> {f.what} <span className="numbers-quiet">({f.effort})</span></li>)}
              </ol>
            </ShowDetails>
          )}
        </div>
      )}
      {!readOnly && s.website && (
        <div className="numbers-actions">
          <button type="button" className="btn btn-gold btn-sm" disabled={busy || working} onClick={() => void act(() => api.startCheckup(tenantId))}>
            {working ? "Checking…" : "Check my website"}
          </button>
          <label className="numbers-ask">
            <input type="checkbox" checked={s.weekly} disabled={busy} onChange={(e) => void act(() => api.setCheckupWeekly(tenantId, e.target.checked))} />
            Check it every week
          </label>
        </div>
      )}
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
    </div>
  );
}

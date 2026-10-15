import { useEffect, useState } from "react";
import { api, getMode } from "../api";
import type { ConnectorStatus } from "../types-ext";
import "./numbers.css";

// "Connect Search Console": one line on where the connection stands, in plain words, and the one next step. The owner is
// sent to Google to say yes (read-only), and comes back here with ?connect=search-console&result=... which is said once.
const BACK: Record<string, string> = {
  connected: "Search Console is connected. Your team will read it every day.",
  denied: "No problem. Nothing was connected.",
  choose: "You're connected. Pick which website to read.",
  missing_scope: "We need permission to read your Search Console, and that box wasn't ticked. Connect again and leave it ticked.",
  no_refresh: "Google didn't give us lasting access. Remove Allevia from the apps with access in your Google account, then connect again.",
};

function comingBack(): string | undefined {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("connect") !== "search-console") return undefined;
    const result = q.get("result") ?? "";
    const reason = q.get("reason") ?? "";
    q.delete("connect"); q.delete("result"); q.delete("reason");
    history.replaceState(null, "", `${location.pathname}${q.toString() ? `?${q}` : ""}${location.hash}`);
    return result === "problem" ? BACK[reason] ?? "That didn't work. Try connecting again in a minute." : BACK[result];
  } catch {
    return undefined;
  }
}

export function ConnectSearchConsole({ tenantId, onChanged }: { tenantId: string; onChanged?: () => void }) {
  const [status, setStatus] = useState<ConnectorStatus | undefined>();
  const [note] = useState<string | undefined>(() => comingBack());
  const [site, setSite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const live = getMode() === "live";

  const load = () => api.searchConsole(tenantId).then(setStatus, (e: Error) => setError(e.message));
  useEffect(() => { if (live) void load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // parked on the server (ALLEVIA_SEARCH_CONSOLE off) or not set up: nothing to offer the owner yet
  if (!live || status?.state === "not_configured") return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e) {
      setError((e as Error)?.message ?? "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const connect = () => run(async () => { const { url } = await api.connectSearchConsole(tenantId); window.location.assign(url); });

  return (
    <div className="connect" aria-live="polite">
      <h3 className="plan-h">Search Console</h3>
      {note && <p className="notice notice-ok" role="status">{note}</p>}
      {status && <p className="connect-line">{status.message}</p>}
      {status?.state === "not_connected" && <button type="button" className="btn btn-gold btn-sm" disabled={busy} onClick={() => void connect()}>Connect Search Console</button>}
      {status?.state === "needs_reconnect" && <button type="button" className="btn btn-gold btn-sm" disabled={busy} onClick={() => void connect()}>Connect again</button>}
      {status?.state === "choose_property" && status.sites?.length ? (
        <form className="numbers-ask" onSubmit={(e) => { e.preventDefault(); if (site) void run(() => api.chooseSearchConsoleSite(tenantId, site)); }}>
          <label className="numbers-ask"><span className="visually-hidden">Which website</span>
            <select value={site} onChange={(e) => setSite(e.target.value)} disabled={busy}>
              <option value="">Pick a website...</option>
              {status.sites.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <button type="submit" className="btn btn-gold btn-sm" disabled={busy || !site}>Use this one</button>
        </form>
      ) : null}
      {status?.state === "connected" && <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => void run(() => api.disconnectSearchConsole(tenantId))}>Disconnect</button>}
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
    </div>
  );
}

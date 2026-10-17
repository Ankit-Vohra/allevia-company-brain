import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api, getMode } from "../api";
import type { ConnectionRow, ConnectionsPage, KeyForm } from "../types-ext";
import { Icon } from "./Icon";
import { KeySheet } from "./KeySheet";
import "./connections.css";

// The Connections list, on its own page and as the "Connect your tools" step of setting up a business. Calm and plain: a tool,
// "Read only" or "Read and act", one line on what the team does with it, and one button. What it reads and what it may do
// (always after the owner's OK) open from that line. Nothing about tokens, scopes or APIs. docs/owner-words.md governs every word.

const GROUP_LABEL: Record<ConnectionRow["group"], string> = { google: "Google", meta: "Meta", commerce: "Commerce and money", customers: "Customers", team: "Team" };

const BACK: Record<string, string> = {
  connected: "Connected. Your team is reading it now.",
  choose: "Connected. Pick which one to read below.",
  denied: "No problem. Nothing was connected.",
  problem: "That didn't work. Try connecting again in a minute.",
};
const REASON: Record<string, string> = {
  missing_scope: "A box on the sign-in page wasn't ticked, and we need it. Connect again and leave every box ticked.",
  no_refresh: "The sign-in didn't give us lasting access. Remove Allevia from the apps with access in your account, then connect again.",
  not_active: "That sign-in didn't finish. Try connecting again.",
};

/** The tools shown at once: the best fits, plus any tool that is connected or needs attention. The rest wait behind "N more tools". */
const FIRST = 6;
/** "Your team reads …" on every row is a repeated label: the row says "Reads …". */
const blurbWords = (s: string) => { const t = s.replace(/^Your team\s+/i, ""); return t.charAt(0).toUpperCase() + t.slice(1); };

/** When the owner comes back from a provider's page: which tool, and what to say. Reads and removes the address's ?connect=&result=. */
export function comingBack(): { id: string; text: string } | undefined {
  try {
    const q = new URLSearchParams(location.search);
    const id = q.get("connect");
    if (!id) return undefined;
    const result = q.get("result") ?? "";
    const reason = q.get("reason") ?? "";
    for (const k of ["connect", "result", "reason"]) q.delete(k);
    history.replaceState(null, "", `${location.pathname}${q.toString() ? `?${q}` : ""}${location.hash}`);
    return { id, text: result === "problem" && REASON[reason] ? REASON[reason]! : BACK[result] ?? "" };
  } catch {
    return undefined;
  }
}

function Logo({ row }: { row: Pick<ConnectionRow, "name" | "logo"> }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="cx-logo" aria-hidden="true">
      {row.logo && !broken ? <img src={row.logo} alt="" width={28} height={28} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <span className="cx-letter">{row.name.charAt(0)}</span>}
    </span>
  );
}

interface RowProps {
  row: ConnectionRow;
  busy: boolean;
  live: boolean;
  focus: boolean;
  /** Why connecting it just failed, in one sentence ("Higgsfield needs your API key"). */
  failed?: string;
  onConnect: (row: ConnectionRow, opts?: { inbox?: boolean }) => void;
  onDisconnect: (row: ConnectionRow) => void;
  onSelect: (row: ConnectionRow, value: string) => void;
  onRead: (row: ConnectionRow) => void;
}

function Row({ row, busy, live, focus, failed, onConnect, onDisconnect, onSelect, onRead }: RowProps) {
  const ref = useRef<HTMLLIElement>(null);
  const [pick, setPick] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [focus]);
  const connected = row.state === "connected";
  const attention = row.state === "needs_attention";
  return (
    <li ref={ref} className={`cx-row is-${row.state}${focus ? " is-focus" : ""}`} data-connection={row.id}>
      <Logo row={row} />
      <div className="cx-main">
        <div className="cx-top">
          <h3 className="cx-name">{row.name}</h3>
          <span className={`cx-pill ${row.access === "read" ? "is-read" : "is-act"}`}>{row.access === "read" ? "Read only" : "Read and act"}</span>
        </div>
        <button type="button" className="cx-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="cx-line-text">{blurbWords(row.blurb)}</span><Icon name="chevron" size={14} className="cx-line-chev" />
        </button>
        {open && row.reads[0] && <p className="cx-meta"><span>It reads</span> {row.reads[0]}</p>}
        {open && row.acts[0] && <p className="cx-meta"><span>It may</span> {row.acts[0]}</p>}
        {(connected || attention) && <p className={`cx-status ${attention ? "is-bad" : "is-ok"}`} role="status">{row.message}</p>}
        {!row.available && <p className="cx-status">{row.soon ? "Coming soon." : row.unavailableWords}</p>}
        {failed && <p className="cx-status is-bad" role="alert">{failed}</p>}
        {row.choose && (
          <form className="cx-pick" onSubmit={(e: FormEvent) => { e.preventDefault(); if (pick) onSelect(row, pick); }}>
            <label className="visually-hidden" htmlFor={`pick-${row.id}`}>{row.choose.label}</label>
            <select id={`pick-${row.id}`} className="field" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
              <option value="">{row.choose.label}</option>
              {row.choose.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <button type="submit" className="btn btn-gold btn-sm" disabled={busy || !pick}>Use this one</button>
          </form>
        )}
        {row.id === "gmail" && connected && !row.extras?.length && (
          <p className="cx-meta"><button type="button" className="cx-link" disabled={busy} onClick={() => onConnect(row, { inbox: true })}>Let your team read your inbox too</button> (optional)</p>
        )}
        {open && row.extras?.map((x) => <p key={x} className="cx-meta"><span>Also allowed</span> {x}</p>)}
      </div>
      <div className="cx-act">
        {!connected && !attention && row.available && (
          <button type="button" className="btn btn-gold btn-sm" disabled={busy || !live} onClick={() => onConnect(row)} aria-label={`Connect ${row.name}`}>Connect</button>
        )}
        {attention && <button type="button" className="btn btn-gold btn-sm" disabled={busy || !live} onClick={() => onConnect(row)}>Connect again</button>}
        {connected && <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => onRead(row)}>Read now</button>}
        {(connected || attention) && <button type="button" className="btn btn-quiet btn-sm cx-off" disabled={busy} onClick={() => onDisconnect(row)} aria-label={`Disconnect ${row.name}`}>Disconnect</button>}
      </div>
    </li>
  );
}

export function ConnectionsPanel({ tenantId, variant = "page", onChanged }: { tenantId: string; variant?: "page" | "onboard"; onChanged?: (connected: number) => void }) {
  const live = getMode() === "live";
  const [data, setData] = useState<ConnectionsPage | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [note] = useState(() => comingBack());
  const [waiting, setWaiting] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Array<{ id: string; name: string; description: string }> | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [failed, setFailed] = useState<{ id: string; text: string } | undefined>();
  const [sheet, setSheet] = useState<{ id: string; form: KeyForm } | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const seen = useRef(-1); // -1: tell the page the first count too, even when it is 0

  const load = useCallback(async () => {
    try {
      const d = await api.connections(tenantId);
      setData(d);
      const n = [...d.recommended, ...d.more].filter((r) => r.state === "connected").length;
      if (n !== seen.current) { seen.current = n; onChanged?.(n); }
      return d;
    } catch (e) {
      setError((e as Error).message || "We couldn't load your tools just now.");
      return null;
    }
  }, [tenantId, onChanged]);
  useEffect(() => { void load(); }, [load]);

  // while someone is connecting in another tab, look every few seconds until it says connected (or five minutes pass)
  useEffect(() => {
    if (!waiting.size) return;
    const stop = Date.now() + 5 * 60_000;
    const t = setInterval(async () => {
      const d = await load();
      const rows = d ? [...d.recommended, ...d.more] : [];
      setWaiting((w) => { const left = new Set([...w].filter((id) => rows.find((r) => r.id === id)?.state !== "connected")); return left.size === w.size && Date.now() < stop ? w : left; });
      if (Date.now() > stop) setWaiting(new Set());
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, load]);

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(undefined);
    setFailed(undefined);
    try { await fn(); await load(); } catch (e) { setFailed({ id, text: (e as Error)?.message || "That didn't work. Try again." }); } finally { setBusy(undefined); }
  };
  const onConnect = (row: ConnectionRow, opts: { inbox?: boolean } = {}) => run(row.id, async () => {
    setDone(undefined);
    const start = await api.connectConnection(tenantId, row.id, { ...opts, returnTo: variant === "onboard" ? "popup" : "connections" });
    if (start.key) { setSheet({ id: row.id, form: start.key }); return; } // no sign-in page: ask for its key here
    if (variant === "onboard") {
      window.open(start.url, "_blank", "noopener");
      setWaiting((w) => new Set(w).add(row.id));
    } else {
      window.location.assign(start.url);
    }
  });
  const onSaveKey = async (values: Record<string, string>) => {
    if (!sheet) return;
    const r = await api.connectWithKey(tenantId, sheet.id, values); // a refusal throws its sentence, shown in the sheet
    setSheet(undefined);
    setDone(r.message);
    setFound((f) => (f ? f.filter((x) => x.id !== sheet.id) : f));
    await load();
  };
  const onDisconnect = (row: ConnectionRow) => run(row.id, () => api.disconnectConnection(tenantId, row.id));
  const onSelect = (row: ConnectionRow, v: string) => run(row.id, () => api.selectConnection(tenantId, row.id, v));
  const onRead = (row: ConnectionRow) => run(row.id, () => api.pullConnection(tenantId, row.id));

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    try { setFound(await api.searchConnections(tenantId, q.trim())); } catch (er) { setError((er as Error).message); }
  };

  const focusId = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("connect") ?? note?.id;

  // groups ordered by how well their best tool fits this business; tools inside keep the recommended order
  const { groups, rest } = useMemo(() => {
    if (!data) return { groups: [], rest: [] as ConnectionRow[] };
    const order = new Map(data.recommended.map((r, i) => [r.id, i]));
    const shown = data.recommended.filter((r, i) => i < FIRST || r.state !== "not_connected" || r.id === focusId);
    const rest = [...data.recommended.filter((r) => !shown.includes(r)), ...data.more];
    const by = new Map<ConnectionRow["group"], ConnectionRow[]>();
    for (const r of shown) by.set(r.group, [...(by.get(r.group) ?? []), r]);
    return { groups: [...by.entries()].sort((a, b) => Math.min(...a[1].map((r) => order.get(r.id)!)) - Math.min(...b[1].map((r) => order.get(r.id)!))), rest };
  }, [data, focusId]);

  const connectedRows = data ? [...data.recommended, ...data.more].filter((r) => r.state === "connected") : [];
  const never = data?.never ?? "We never post, send, spend or book without your OK, and your data stays in your own space.";
  const rowProps = (row: ConnectionRow): RowProps => ({ row, busy: busy === row.id, live, focus: focusId === row.id, ...(failed?.id === row.id ? { failed: failed.text } : {}), onConnect, onDisconnect, onSelect, onRead });

  if (!data && !error) return <div className="cx-skel" aria-busy="true"><span className="skeleton" /><span className="skeleton" /></div>;
  if (data && !data.ready) return <p className="cx-quiet">{data.message ?? "Connecting your tools isn't switched on yet. Your team is setting it up and will let you know when it's ready."}</p>;

  return (
    <div className={`cx cx-${variant}`}>
      {note?.text && <p className={`notice ${note.text.startsWith("Connected") ? "notice-ok" : ""}`} role="status">{note.text}</p>}
      {/* on the Your tools page the promise sits at the foot, not as a sentence under the heading */}
      {variant === "onboard" && <p className="cx-never"><Icon name="check" size={15} /><span>{never} <span className="cx-never-tail">Disconnect any time.</span></span></p>}
      {!live && <p className="cx-quiet">Connecting works in the live app.</p>}
      {done && <p className="notice notice-ok" role="status">{done}</p>}
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
      {sheet && <KeySheet form={sheet.form} onSave={onSaveKey} onClose={() => setSheet(undefined)} />}
      {waiting.size > 0 && <p className="cx-quiet" role="status">Waiting for you to finish in the other tab. This updates by itself.</p>}

      {variant === "onboard" && connectedRows.length > 0 && (
        <ul className="cx-progress" aria-live="polite" aria-label="Connected so far">
          {connectedRows.map((r) => <li key={r.id}>{r.message}</li>)}
        </ul>
      )}

      {groups.map(([g, rows]) => (
        <section key={g} className="cx-group" aria-labelledby={`cx-g-${g}`}>
          <h2 id={`cx-g-${g}`} className="cx-group-h">{GROUP_LABEL[g]}</h2>
          <ul className="cx-list">{rows.map((r) => <Row key={r.id} {...rowProps(r)} />)}</ul>
        </section>
      ))}

      {rest.length > 0 && (
        <section className="cx-group">
          <button type="button" className="cx-more" aria-expanded={showMore} onClick={() => setShowMore((s) => !s)}>{showMore ? "Fewer tools" : `${rest.length} more tools`}</button>
          {showMore && <ul className="cx-list">{rest.map((r) => <Row key={r.id} {...rowProps(r)} />)}</ul>}
        </section>
      )}

      {live && (
        <section className="cx-group" aria-label="Find another tool">
          <form className="cx-search" onSubmit={search}>
            <label className="visually-hidden" htmlFor="cx-q">Find another tool</label>
            <input id="cx-q" className="field" placeholder="Find another tool: Notion, Zendesk, Square ..." value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="submit" className="btn btn-sm" disabled={q.trim().length < 2}>Search</button>
          </form>
          {found && (found.length ? (
            <ul className="cx-list">
              {found.map((f) => (
                <li key={f.id} className="cx-row">
                  <Logo row={{ name: f.name, logo: `https://logos.composio.dev/api/${f.id.slice(4)}` }} />
                  <div className="cx-main"><h3 className="cx-name">{f.name}</h3><p className="cx-line">{f.description || `Your team can use ${f.name}.`}</p><p className="cx-meta">Anything it changes in {f.name} waits for your OK.</p>{failed?.id === f.id && <p className="cx-status is-bad" role="alert">{failed.text}</p>}</div>
                  <div className="cx-act"><button type="button" className="btn btn-gold btn-sm" disabled={busy === f.id} onClick={() => onConnect({ id: f.id, name: f.name } as ConnectionRow)}>Connect</button></div>
                </li>
              ))}
            </ul>
          ) : <p className="cx-quiet">Nothing by that name. Try another word.</p>)}
        </section>
      )}

      {variant === "page" && data && data.starters.length > 0 && (
        <section className="cx-group" aria-labelledby="cx-starters">
          <h2 id="cx-starters" className="cx-group-h">Try these now</h2>
          <ul className="cx-chips">
            {data.starters.slice(0, 3).map((s) => (
              <li key={s.id}><Link className="chat-chip" to={`/chat?q=${encodeURIComponent(s.ask)}`} title={s.ask}>{s.label}{s.needsOk ? <span className="cx-ok"> · after your OK</span> : null}</Link></li>
            ))}
          </ul>
        </section>
      )}
      {variant === "page" && <p className="cx-never is-foot"><Icon name="check" size={14} /><span>{never} <span className="cx-never-tail">Disconnect any time.</span></span></p>}
    </div>
  );
}

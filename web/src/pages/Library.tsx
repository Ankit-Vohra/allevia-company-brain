// The Library: everything the team made for this business (posters, ads, product shoots, clips) and every photo the owner sent,
// newest first, so nothing made is lost in a chat thread. Making things happens in Chat (attach a photo, say what you want); this
// page keeps them. A tile shows the picture, what it is, where it stands and what it cost; a tap opens a sheet with the big
// picture, "How this was made", Download, Make a variation and Ask about it (both open Chat with the words typed), and OK or Look
// while it waits. A picture from a photo's card that waits also has "What to change?" and "Make a 5-second clip" (priced first),
// which run the Studio's own routes as a turn in the photo's thread. Brand holds the brand files the team puts on posters. Words: web/src/lib/library.ts.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { LibraryItem } from "@shared/contracts";
import { api, getMode, getPublicMode } from "../api";
import { AssetLineage } from "../components/AssetLineage";
import { BrandLibrary } from "../components/BrandLibrary";
import { Icon } from "../components/Icon";
import { Sheet } from "../components/Sheet";
import { APPROVALS_CHANGED } from "../components/TopBar";
import { chatPath, TEAM } from "../lib/chat";
import { ChangeField, ClipOffer } from "../components/MadeCard";
import { EMPTY, emptyFor, FILTERS, filterItems, isFilter, sheetActions, sheetChange, tileWords, type LibraryFilter, type PhotoChange } from "../lib/library";
import { useApp, useAsync } from "../state/app";
import "./library.css";

export default function LibraryPage() {
  const { tenant } = useApp();
  const [params, setParams] = useSearchParams();
  const show = params.get("show");
  const filter: LibraryFilter = isFilter(show) ? show : "all";
  const setFilter = (f: LibraryFilter) => {
    const next = new URLSearchParams(params);
    if (f === "all") next.delete("show"); else next.set("show", f);
    setParams(next, { replace: true });
  };
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener(APPROVALS_CHANGED, on);
    return () => window.removeEventListener(APPROVALS_CHANGED, on);
  }, []);
  const lib = useAsync(() => api.library(tenant.id), [tenant.id, tick]);
  const items = useMemo(() => filterItems(lib.data?.items ?? [], filter), [lib.data, filter]);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { setOpenId(null); }, [tenant.id]);
  const open = (lib.data?.items ?? []).find((i) => i.id === openId) ?? null;
  const nothingAtAll = !lib.loading && !lib.error && (lib.data?.items.length ?? 0) === 0;

  return (
    <div className="library-page">
      <header className="lib-head">
        <div>
          <h1 className="page-title">Library</h1>
          <p className="lib-sub">Everything your team made, and the photos you sent.</p>
        </div>
        <Link to={chatPath(TEAM)} className="btn btn-ghost btn-sm lib-make"><Icon name="attach" size={14} /> Make in Chat</Link>
      </header>

      <div className="lib-filters" role="tablist" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`lib-filter${filter === f.id ? " is-on" : ""}`} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {filter === "brand" ? (
        <BrandLibrary tenant={tenant.id} open />
      ) : lib.loading && !lib.data ? (
        <ul className="lib-grid" aria-hidden="true">{[0, 1, 2, 3].map((i) => <li key={i} className="lib-tile"><span className="lib-thumb skeleton" /></li>)}</ul>
      ) : lib.error ? (
        <p className="notice notice-bad" role="alert">The Library couldn't be read just now. Try again in a moment.</p>
      ) : nothingAtAll ? (
        <Empty line={EMPTY.line} />
      ) : items.length === 0 ? (
        <p className="lib-none">{emptyFor(filter)}</p>
      ) : (
        <ul className="lib-grid" aria-label="Your library">
          {items.map((it) => <Tile key={it.id} item={it} onOpen={() => setOpenId(it.id)} />)}
        </ul>
      )}

      <Sheet open={!!open} onClose={() => setOpenId(null)} label={open ? tileWords(open).alt : "Picture"}>
        {open && <ItemSheet key={open.id} tenant={tenant.id} item={open} onChanged={() => { lib.reload(); window.dispatchEvent(new Event(APPROVALS_CHANGED)); }} />}
      </Sheet>
    </div>
  );
}

function Empty({ line }: { line: string }) {
  return (
    <div className="lib-empty">
      <span className="lib-empty-icon" aria-hidden="true"><Icon name="image" size={22} /></span>
      <p>{line}</p>
      <Link to={chatPath(TEAM)} className="btn btn-gold">{EMPTY.cta}</Link>
    </div>
  );
}

function Tile({ item, onOpen }: { item: LibraryItem; onOpen: () => void }) {
  const w = tileWords(item);
  return (
    <li className="lib-tile">
      <button type="button" className="lib-tile-btn" onClick={onOpen} aria-label={`${w.alt}${w.state ? `, ${w.state.toLowerCase()}` : ""}`}>
        <span className="lib-thumb">
          {item.media === "video"
            ? <video src={item.thumb} muted playsInline preload="metadata" aria-hidden="true" />
            : <img src={item.thumb} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />}
          {item.media === "video" && <span className="lib-play" aria-hidden="true"><Icon name="play" size={14} /></span>}
          {w.state && <span className={`lib-state is-${w.tone}`}>{w.state}</span>}
        </span>
        <span className="lib-title">{w.title}</span>
        <span className="lib-meta">{[w.kind, w.date, w.credits].filter(Boolean).join(" · ")}</span>
      </button>
    </li>
  );
}

function ItemSheet({ tenant, item, onChanged }: { tenant: string; item: LibraryItem; onChanged: () => void }) {
  const w = tileWords(item);
  const a = sheetActions(item);
  const edit = sheetChange(item);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const readOnly = getPublicMode() || getMode() !== "live";
  const ok = async () => {
    if (!item.approvalId) return;
    setBusy(true); setSaid(null);
    try {
      const r = await api.studioApprove(tenant, { approvalId: item.approvalId, variantId: item.id });
      setSaid({ ok: true, text: r.approval?.result ? r.approval.result : "Saved as a draft post. Nothing was posted." });
      onChanged();
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message || "That didn't go through. Try again, or use Needs your OK." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="lib-sheet">
      <figure className="lib-big">
        {item.media === "video"
          ? <video src={item.url} controls playsInline preload="metadata" />
          : <img src={item.url} alt={w.alt} />}
      </figure>
      <header className="lib-sheet-head">
        <h2 className="lib-sheet-title">{w.title}</h2>
        <p className="lib-meta">{[w.kind, w.date, w.credits].filter(Boolean).join(" · ")}{w.state && <> · <span className={`lib-state-text is-${w.tone}`}>{w.state}</span></>}</p>
      </header>

      {a.decide && !said?.ok && (
        <div className="lib-decide">
          <button type="button" className="btn btn-gold btn-sm" disabled={busy || readOnly} onClick={() => void ok()}><Icon name="check" size={14} /> {busy ? "Saving…" : "OK"}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => nav(`/approvals#${encodeURIComponent(item.approvalId!)}`)}>Look</button>
        </div>
      )}
      {said && <p className={`lib-said${said.ok ? "" : " is-bad"}`} role="status">{said.ok && <Icon name="check" size={14} />} {said.text}</p>}

      {edit.change && !said?.ok && <SheetChange tenant={tenant} item={item} clip={edit.clip} onChanged={onChanged} />}

      <div className="lib-actions">
        <a className="btn btn-ghost btn-sm" href={a.download.href} download={a.download.filename}><Icon name="download" size={14} /> Download</a>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => nav(a.variation)}><Icon name="sparkle" size={14} /> Make a variation</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => nav(a.ask)}><Icon name="chat" size={14} /> Ask about it</button>
      </div>

      <AssetLineage tenant={tenant} rootId={item.id} refreshKey={`${item.state ?? ""}|${said?.text ?? ""}`} />
    </article>
  );
}

// Change this picture, or make a 5 second clip from it: the Studio's own routes (POST /chat/photo/change), as a turn in the thread
// the photo was sent in, so the new option is a card there and a tile here. The work keeps going on the server if the sheet closes.
function SheetChange({ tenant, item, clip, onChanged }: { tenant: string; item: LibraryItem; clip: boolean; onChanged: () => void }) {
  const [run, setRun] = useState<{ busy: boolean; lines: string[]; answer: string | null; bad: boolean; sessionId: string | null }>({ busy: false, lines: [], answer: null, bad: false, sessionId: null });
  const send = async (change: PhotoChange) => {
    setRun({ busy: true, lines: [], answer: null, bad: false, sessionId: null });
    let answer = "";
    let bad = false;
    try {
      await api.changePhoto(tenant, change, (e) => {
        if (e.type === "session") setRun((r) => ({ ...r, sessionId: e.sessionId }));
        else if (e.type === "agent_status") setRun((r) => ({ ...r, lines: [...r.lines.slice(-3), e.text] }));
        else if (e.type === "final") answer = e.answer;
        else if (e.type === "error") { answer = e.message; bad = true; }
      });
    } catch (e) {
      answer = (e as Error).message || "That didn't go through. Try again in a moment.";
      bad = true;
    }
    setRun((r) => ({ ...r, busy: false, answer, bad }));
    onChanged();
  };
  return (
    <section className="lib-change" aria-label="Change it">
      <ChangeField approvalId={item.approvalId!} variantId={item.id} busy={run.busy} onSend={(c) => void send(c)} />
      {clip && <ClipOffer tenant={tenant} approvalId={item.approvalId!} variantId={item.id} {...(item.label ? { label: item.label } : {})} busy={run.busy} onYes={(c) => void send(c)} />}
      {run.busy && run.lines.length > 0 && <ol className="lib-change-log" aria-live="polite">{run.lines.map((l, i) => <li key={i}>{l}</li>)}</ol>}
      {run.answer && <p className={`lib-said${run.bad ? " is-bad" : ""}`} role="status">{run.answer}</p>}
      {run.sessionId && !run.busy && <Link className="btn btn-quiet btn-sm" to={chatPath(TEAM, run.sessionId)}><Icon name="chat" size={14} /> See it in Chat</Link>}
    </section>
  );
}

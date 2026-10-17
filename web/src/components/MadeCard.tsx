// What the team made in a turn (a poster, a picture, a reel draft): each option with its check, Approve on the ones that may
// be approved, and a way to change it. On a card made from the owner's photo (the Studio's, `studio`), Change is a small field
// ("what to change") that goes to the Studio's own change path, and each checked option has "Make a 5-second clip", priced first;
// both come back as a new card in this thread (POST /chat/photo/change). On any other card, Change puts "Change option A: " in
// the composer so the owner says what in their own words. Nothing here posts anything: Approve saves a draft, the same decision
// as the Approvals page and Discord.
import { useState, type FormEvent } from "react";
import type { AgentEvent } from "@shared/contracts";
import { api, getMode, getPublicMode } from "../api";
import { canChangeCard, canClipOption, CHANGE_COST, CHANGE_PLACEHOLDER, changeFrom, CLIP_COST, clipWords, type PhotoChange } from "../lib/library";
import { Icon } from "./Icon";
import "./made-card.css";

type Made = Extract<AgentEvent, { type: "deliverable" }>;
type Questions = Extract<AgentEvent, { type: "quick_replies" }>;

const src = (t: string, id: string, w: number) => `/api/${encodeURIComponent(t)}/assets/${encodeURIComponent(id)}?w=${w}`;
const raw = (t: string, id: string) => `/api/${encodeURIComponent(t)}/assets/${encodeURIComponent(id)}`;
const BADGE: Record<Made["options"][number]["badge"], string> = { ok: "Checked", held: "Held back", unchecked: "Not double-checked" };

export function MadeCard({ tenant, made, onChange, onStudio }: {
  tenant: string; made: Made; onChange: (prefill: string) => void;
  /** Sends a change to a photo's card as a turn in this thread; absent, Change prefills the composer. */
  onStudio?: (change: PhotoChange, label?: string) => void;
}) {
  const [state, setState] = useState<{ approved?: string; error?: string; busy?: string }>({});
  const studio = !!onStudio && canChangeCard(made);
  const clipCard = made.studio === true && made.kind === "clip";
  const approve = async (assetId: string, label: string) => {
    setState({ busy: label });
    try {
      await api.studioApprove(tenant, { approvalId: made.approvalId, variantId: assetId });
      setState({ approved: label });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : "That didn't go through. Try again, or use Approvals." });
    }
  };
  return (
    <section className="made" aria-label={made.title}>
      <h3 className="made-title"><Icon name="pen" size={16} /> {made.title}</h3>
      <ul className="made-options">
        {made.options.map((o) => (
          <li key={o.assetId} className={`made-option is-${o.badge}`}>
            {made.kind === "clip"
              ? <video src={raw(tenant, o.assetId)} controls muted playsInline preload="metadata" className="made-media" />
              : <img src={src(tenant, o.assetId, 720)} alt={`Option ${o.label}`} loading="lazy" className="made-media" />}
            {clipCard ? <p className="made-label"><b>Clip</b>{o.note ? ` · ${o.note}` : ""}</p> : <>
              <p className="made-label"><b>Option {o.label}</b>{o.assetId === made.recommended ? " · our pick" : ""}{o.aiEdited ? " · AI artwork" : ""}</p>
              <p className={`made-badge is-${o.badge}`}>{BADGE[o.badge]}{o.note ? `: ${o.note}` : ""}</p>
            </>}
            {clipCard ? null : state.approved === o.label ? <p className="made-done"><Icon name="check" size={14} /> Saved as a draft. Nothing was posted.</p> : (
              <div className="made-actions">
                {o.badge !== "held" && !state.approved && (
                  <button type="button" className="btn btn-sm btn-gold" disabled={!!state.busy} onClick={() => void approve(o.assetId, o.label)}>{state.busy === o.label ? "Saving…" : "Approve"}</button>
                )}
                {!studio && <button type="button" className="btn btn-sm btn-quiet" onClick={() => onChange(`Change option ${o.label}: `)}>Change</button>}
              </div>
            )}
            {studio && !state.approved && canClipOption(made, o) && <ClipOffer tenant={tenant} approvalId={made.approvalId} variantId={o.assetId} label={o.label} onYes={onStudio!} />}
          </li>
        ))}
      </ul>
      {made.notes.length > 0 && <ul className="made-notes">{made.notes.slice(0, 4).map((n) => <li key={n}>{n}</li>)}</ul>}
      {studio && !state.approved && <ChangeField approvalId={made.approvalId} onSend={onStudio!} />}
      {state.error && <p className="made-error" role="alert">{state.error}</p>}
    </section>
  );
}

const readOnly = () => getPublicMode() || getMode() !== "live";

/** "What to change?": the owner's words go to the Studio's change path; the cost line says what is free and what is priced. */
export function ChangeField({ approvalId, variantId, onSend, busy }: { approvalId: string; variantId?: string; onSend: (c: PhotoChange) => void; busy?: boolean }) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = changeFrom(text, { approvalId, ...(variantId ? { variantId } : {}) });
    if (!c || busy) return;
    onSend(c);
    setText("");
  };
  return (
    <form className="made-change" onSubmit={submit}>
      <label className="made-change-row">
        <span className="visually-hidden">What to change</span>
        <input type="text" className="field" value={text} maxLength={400} placeholder={CHANGE_PLACEHOLDER} disabled={busy || readOnly()} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn btn-sm btn-ghost" disabled={busy || !text.trim() || readOnly()}>{busy ? "Working…" : "Change"}</button>
      </label>
      <p className="made-cost">{CHANGE_COST}</p>
    </form>
  );
}

/** "Make a 5-second clip": the price first (POST /studio/clip, nothing is made), then the clip only when the owner says yes. */
export function ClipOffer({ tenant, approvalId, variantId, label, onYes, busy }: {
  tenant: string; approvalId: string; variantId: string; label?: string; onYes: (c: PhotoChange, label?: string) => void; busy?: boolean;
}) {
  const [offer, setOffer] = useState<{ message: string; words: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ask = async () => {
    setAsking(true); setNote(null);
    try {
      const r = await api.studioClipQuote(tenant, { approvalId, variantId });
      if (r.ok && r.words) setOffer({ message: r.message, words: r.words });
      else setNote(r.message);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "The clip's price couldn't be checked just now.");
    } finally {
      setAsking(false);
    }
  };
  return (
    <div className="made-clip">
      {!offer ? <>
        <button type="button" className="btn btn-sm btn-quiet" disabled={asking || busy || readOnly()} onClick={() => void ask()}>
          <Icon name="play" size={14} /> {asking ? "Checking the price…" : clipWords()}
        </button>
        <p className="made-cost">{CLIP_COST}</p>
      </> : <>
        <p className="made-cost" role="status">{offer.message}</p>
        <div className="made-actions">
          <button type="button" className="btn btn-sm btn-gold" disabled={busy} onClick={() => { onYes({ approvalId, clip: true, variantId }, label); setOffer(null); }}>{clipWords(offer.words)}</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOffer(null)}>No thanks</button>
        </div>
      </>}
      {note && <p className="made-cost" role="status">{note}</p>}
    </div>
  );
}

// A few questions the team needs answered first: tap an answer, or type your own.
export function QuickReplies({ q, onAnswer }: { q: Questions; onAnswer: (text: string) => void }) {
  return (
    <section className="quick" aria-label="Quick questions">
      {q.questions.map((item) => (
        <div key={item.question} className="quick-q">
          <p className="quick-text">{item.question}</p>
          {item.options.length > 0
            ? <div className="quick-chips">{item.options.map((o) => <button key={o} type="button" className="chip" onClick={() => onAnswer(o)}>{o}</button>)}</div>
            : <p className="quick-hint">Type your answer below.</p>}
        </div>
      ))}
    </section>
  );
}

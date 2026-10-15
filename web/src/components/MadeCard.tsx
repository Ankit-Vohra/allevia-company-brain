// What the team made in a turn (a poster, a picture, a reel draft): each option with its check, Approve on the ones that may
// be approved, and Change, which puts "Change option A: " in the composer so the owner says what in their own words. Nothing
// here posts anything: Approve saves a draft, the same decision as the Approvals page and Discord.
import { useState } from "react";
import type { AgentEvent } from "@shared/contracts";
import { api } from "../api";
import { Icon } from "./Icon";

type Made = Extract<AgentEvent, { type: "deliverable" }>;
type Questions = Extract<AgentEvent, { type: "quick_replies" }>;

const src = (t: string, id: string, w: number) => `/api/${encodeURIComponent(t)}/assets/${encodeURIComponent(id)}?w=${w}`;
const raw = (t: string, id: string) => `/api/${encodeURIComponent(t)}/assets/${encodeURIComponent(id)}`;
const BADGE: Record<Made["options"][number]["badge"], string> = { ok: "Checked", held: "Held back", unchecked: "Not double-checked" };

export function MadeCard({ tenant, made, onChange }: { tenant: string; made: Made; onChange: (prefill: string) => void }) {
  const [state, setState] = useState<{ approved?: string; error?: string; busy?: string }>({});
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
            <p className="made-label"><b>Option {o.label}</b>{o.assetId === made.recommended ? " · our pick" : ""}{o.aiEdited ? " · AI artwork" : ""}</p>
            <p className={`made-badge is-${o.badge}`}>{BADGE[o.badge]}{o.note ? `: ${o.note}` : ""}</p>
            {state.approved === o.label ? <p className="made-done"><Icon name="check" size={14} /> Saved as a draft. Nothing was posted.</p> : (
              <div className="made-actions">
                {o.badge !== "held" && !state.approved && (
                  <button type="button" className="btn btn-sm btn-gold" disabled={!!state.busy} onClick={() => void approve(o.assetId, o.label)}>{state.busy === o.label ? "Saving…" : "Approve"}</button>
                )}
                <button type="button" className="btn btn-sm btn-quiet" onClick={() => onChange(`Change option ${o.label}: `)}>Change</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {made.notes.length > 0 && <ul className="made-notes">{made.notes.slice(0, 4).map((n) => <li key={n}>{n}</li>)}</ul>}
      {state.error && <p className="made-error" role="alert">{state.error}</p>}
    </section>
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

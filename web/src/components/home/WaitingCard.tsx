// "Waiting for your OK", on Home: each draft with its real content (the poster options and our pick, the email and who it goes to,
// the meeting and when, the words of a post or a fix) and Approve, Change and No thanks right there. The first few are decided
// here; the rest wait on the Approvals page. Nothing leaves without the owner's OK, and on Discord the same cards carry the same
// three buttons. An edit becomes a habit the team keeps (the answer carries the `learned` events).
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ActionKind } from "@shared/contracts";
import { api, getPublicMode } from "../../api";
import { ACTION } from "../../lib/actions";
import { kindWords } from "../../lib/approval-words";
import { firstFew, meetingWords, plainTitle, type WaitingItem } from "../../lib/home";
import type { Approval, LearnedEvent } from "../../types-ext";
import { AgentAvatar, agentDef } from "../bits";
import { Icon } from "../Icon";
import { whenWords } from "../insights-words";
import { LearnedChips } from "../Learning";
import { APPROVALS_CHANGED } from "../TopBar";
import { CardSkeleton, HomeCard } from "./HomeCard";

type Payload = Approval["payload"];
/** `failed`: the owner said OK but the tool refused, in the executor's own plain words ("Nothing was done."). */
interface Done { id: string; title: string; kind: ActionKind; outcome: "approved" | "edited" | "rejected"; learned: LearnedEvent[]; failed?: string; draftOnly?: boolean }

const bodyOf = (a: Approval) => a.payload.body.replace(/^Evidence: .*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
/** A website address or a place ("Instagram post"); never a repo name or a one-word tag, which is plumbing. */
const aboutOf = (a: Approval): string | undefined => {
  const t = a.payload.target?.trim();
  return t && t.length <= 90 && !/^[\w.-]+\/[\w.-]+$/.test(t) && (/^https?:\/\//.test(t) || /\s/.test(t)) ? t : undefined;
};

export function WaitingCard({ tenantId, tz, locale, items, loading, error, onChanged, onLearned }: {
  tenantId: string; tz?: string; locale?: string;
  items: WaitingItem<Approval>[];
  loading: boolean; error?: string;
  /** A draft was decided: reload the lists that show it. */
  onChanged: () => void;
  onLearned: () => void;
}) {
  const [done, setDone] = useState<Done[]>([]);
  useEffect(() => { setDone([]); }, [tenantId]);
  const { shown, more } = firstFew(items, 3);
  const readOnly = getPublicMode();

  const decide = async (a: Approval, decision: "approve" | "reject", edited?: Payload) => {
    const out = await api.decide(tenantId, a.id, { decision, ...(edited ? { editedPayload: edited } : {}) });
    const failed = decision === "approve" && out.action?.status === "failed" ? out.action.result : undefined;
    setDone((d) => [{
      id: a.id, title: plainTitle(a.title), kind: a.kind, outcome: decision === "reject" ? "rejected" as const : edited ? "edited" as const : "approved" as const,
      learned: out.learned ?? [], ...(failed ? { failed } : {}), ...(a.preview?.draftOnly ? { draftOnly: true } : {}),
    }, ...d].slice(0, 2));
    window.dispatchEvent(new Event(APPROVALS_CHANGED));
    if (out.learned?.length) onLearned();
    onChanged();
  };

  const calm = !loading && shown.length === 0;
  return (
    <HomeCard id="waiting" title="Waiting for your OK" count={items.length} to="/approvals" toLabel={items.length > 3 ? `See all ${items.length}` : "See all"} tone={calm ? "calm" : undefined} busy={loading && !items.length}>
      {error && <p className="notice notice-bad" role="alert">Your drafts did not load: {error}</p>}
      {loading && !items.length && !done.length && <CardSkeleton lines={3} />}
      {shown.length > 0 && (
        <ul className="hm-drafts">
          {shown.map((w) => (
            <li key={w.approval.id} className="hm-draft-li">
              <Draft w={w} tenantId={tenantId} tz={tz} locale={locale} readOnly={readOnly} onDecide={decide} />
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="hm-more"><Link to="/approvals">{more} more waiting for you</Link></p>}
      {done.map((d) => (
        <div key={d.id} className={`hm-done${d.failed ? " is-failed" : ""}`} role="status">
          <p className="hm-done-line">
            <Icon name={d.failed ? "warn" : d.outcome === "rejected" ? "x" : "check"} size={15} />
            <span><b>{d.failed ? "Did not go through" : d.outcome === "rejected" ? "You said no" : d.outcome === "edited" ? "Approved with your edits" : "Approved"}:</b> {d.title}</span>
          </p>
          <p className="small muted">{d.failed ? d.failed : d.outcome === "rejected" ? "Nothing was changed." : kindWords({ kind: d.kind, title: d.title, preview: { draftOnly: d.draftOnly } }).done}</p>
          <LearnedChips events={d.learned} edited={d.outcome === "edited"} />
        </div>
      ))}
      {calm && (
        <div className="hm-calm">
          <span className="hm-calm-icon" aria-hidden="true"><Icon name="check" size={18} /></span>
          <p><b>Nothing needs you right now.</b> Your team leaves new drafts here, and nothing goes out without your OK.</p>
        </div>
      )}
    </HomeCard>
  );
}

function Draft({ w, tenantId, tz, locale, readOnly, onDecide }: {
  w: WaitingItem<Approval>; tenantId: string; tz?: string; locale?: string; readOnly: boolean;
  onDecide: (a: Approval, d: "approve" | "reject", edited?: Payload) => Promise<void>;
}) {
  const a = w.approval;
  const k = kindWords(a);
  const who = agentDef(a.by);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Payload>(a.payload);
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<string | null>(null);
  const changed = draft.title !== a.payload.title || draft.body !== a.payload.body;

  const go = async (d: "approve" | "reject") => {
    setBusy(d);
    setError(null);
    try {
      await onDecide(a, d, d === "approve" && editing && changed ? draft : undefined);
    } catch (e) {
      setError((e as Error).message || "That did not go through. Try again.");
      setBusy(null);
    }
  };
  const off = busy !== null || readOnly;
  const title = plainTitle(a.title);

  return (
    <article className={`hm-draft${editing ? " is-editing" : ""}`} aria-labelledby={`hm-d-${a.id}`} data-approval={a.id}>
      <p className="hm-draft-kind">
        <Icon name={ACTION[a.kind].icon} size={14} /> {k.label}
        {w.big && <span className="hm-badge">Big one</span>}
        {a.simulated && <span className="hm-sample" title="These numbers are samples">sample numbers</span>}
      </p>
      <h3 id={`hm-d-${a.id}`} className="hm-draft-title">{title}</h3>
      <p className="hm-draft-from">
        <AgentAvatar id={a.by} size={22} />
        <span><b>{who?.name}</b>{who ? `, ${who.title.toLowerCase()}` : ""} · {whenWords(a.createdAt, tz, locale)}</span>
      </p>
      {w.why && <p className="hm-draft-why">{w.why}</p>}

      {editing ? (
        <div className="hm-edit">
          <label className="visually-hidden" htmlFor={`hm-t-${a.id}`}>Title</label>
          <input id={`hm-t-${a.id}`} className="field" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <label className="visually-hidden" htmlFor={`hm-b-${a.id}`}>Draft</label>
          <textarea id={`hm-b-${a.id}`} className="field" rows={Math.min(10, Math.max(4, draft.body.split("\n").length + 1))} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <p className="hm-hint">Your change becomes a habit {who?.name ?? "your team"} keeps on the next draft.</p>
        </div>
      ) : (
        <Content a={a} tenantId={tenantId} tz={tz} locale={locale} />
      )}

      {!editing && <p className="hm-effect">{k.effect(a.payload.target)}</p>}

      <div className="hm-actions">
        {editing ? (
          <>
            <button type="button" className="btn btn-gold hm-yes" onClick={() => go("approve")} disabled={off || !draft.title.trim()}>
              <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : changed ? "Approve with edits" : "Approve"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => { setEditing(false); setDraft(a.payload); }} disabled={busy !== null}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-gold hm-yes" onClick={() => go("approve")} disabled={off} title={readOnly ? "Turned off in the public demo" : undefined}>
              <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)} disabled={off}><Icon name="pen" size={15} /> Change</button>
            <button type="button" className="btn btn-quiet" onClick={() => go("reject")} disabled={off}>{busy === "reject" ? "Saying no…" : "No thanks"}</button>
          </>
        )}
      </div>
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
    </article>
  );
}

/** What the draft says: the picture options, the email, the meeting, or the words. */
function Content({ a, tenantId, tz, locale }: { a: Approval; tenantId: string; tz?: string; locale?: string }) {
  const p = a.preview;
  const body = bodyOf(a);
  const about = aboutOf(a);
  const when = p?.when ? meetingWords(p.when, { timeZone: tz, locale }) : "";
  return (
    <div className="hm-content">
      {p?.media && <Options tenantId={tenantId} media={p.media} />}
      {(a.kind === "email_send" && (p?.to || p?.subject)) && (
        <dl className="hm-facts">
          {p.to && <div className="hm-fact"><dt>To</dt><dd>{p.to}</dd></div>}
          {p.cc && <div className="hm-fact"><dt>Copy</dt><dd>{p.cc}</dd></div>}
          {p.subject && <div className="hm-fact"><dt>Subject</dt><dd>{p.subject}</dd></div>}
        </dl>
      )}
      {a.kind === "calendar_event" && when && (
        <dl className="hm-facts">
          <div className="hm-fact"><dt>When</dt><dd>{when}</dd></div>
          {p?.when && p.when.guests.length > 0 && <div className="hm-fact"><dt>With</dt><dd>{p.when.guests.join(", ")}</dd></div>}
        </dl>
      )}
      {about && !p?.media && a.kind !== "email_send" && a.kind !== "calendar_event" && (
        <dl className="hm-facts"><div className="hm-fact"><dt>About</dt><dd className="hm-about">{about}</dd></div></dl>
      )}
      {body && <Words text={body} label={p?.media ? "Caption" : undefined} />}
    </div>
  );
}

/** The words, five lines of them, and the rest one tap away. */
function Words({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 260 || text.split("\n").length > 5;
  return (
    <div className="hm-words">
      {label && <p className="hm-words-label">{label}</p>}
      <p className={`hm-draft-body${open || !long ? " is-open" : ""}`}>{text}</p>
      {long && <button type="button" className="hm-showall" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Show less" : "Show all"}</button>}
    </div>
  );
}

const assetSrc = (t: string, id: string, w: number) => `/api/${encodeURIComponent(t)}/assets/${encodeURIComponent(id)}?w=${w}`;
const rawSrc = (t: string, id: string) => `/api/${encodeURIComponent(t)}/assets/${encodeURIComponent(id)}`;
const KIND_NOUN = { photo: "photo", poster: "poster", image: "picture", clip: "clip" } as const;

/** The picture or clip options a post comes with. Approving uses our pick. */
function Options({ tenantId, media }: { tenantId: string; media: NonNullable<NonNullable<Approval["preview"]>["media"]> }) {
  const noun = KIND_NOUN[media.kind];
  const many = media.options.length > 1;
  return (
    <div className="hm-options-wrap">
      <ul className={`hm-options${many ? "" : " is-single"}`} aria-label={`The ${noun}${many ? " options" : ""}`}>
        {media.options.map((o) => (
          <li key={o.id} className={`hm-option${o.pick ? " is-pick" : ""}${o.held ? " is-held" : ""}`}>
            {media.kind === "clip" ? (
              <video className="hm-option-img" src={rawSrc(tenantId, o.id)} muted playsInline preload="metadata" aria-label={`Option ${o.label}`} />
            ) : (
              <img className="hm-option-img" src={assetSrc(tenantId, o.id, 260)} alt={many ? `Option ${o.label}` : `The ${noun}`} loading="lazy" width={104} height={130} />
            )}
            <span className="hm-option-label"><b>{many ? `Option ${o.label}` : `The ${noun}`}</b>{o.pick && many ? <span className="hm-pick">Our pick</span> : o.held ? <span className="hm-held">Held back</span> : null}</span>
          </li>
        ))}
      </ul>
      {many && <p className="hm-hint">Approving uses our pick.</p>}
    </div>
  );
}

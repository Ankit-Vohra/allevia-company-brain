// One draft in full, for the sheet that opens from a row ("Look"): the real content (the picture options and our pick, the
// email and who it goes to, the meeting and when, the words of a post or a fix), what saying OK does, and Approve, Change,
// No thanks. The same card on Home and on the Approvals page, and the same three buttons on Discord.
import { useState } from "react";
import { Link } from "react-router";
import { usesWords } from "@shared/credits";
import { ACTION } from "../../lib/actions";
import { kindWords } from "../../lib/approval-words";
import { meetingWords, plainTitle } from "../../lib/home";
import type { Approval } from "../../types-ext";
import { AgentAvatar, agentDef } from "../bits";
import { Icon } from "../Icon";
import { whenWords } from "../insights-words";
import type { Payload } from "./decide";
import "../credits.css";
import "./approval.css";

const bodyOf = (a: Approval) => a.payload.body.replace(/^Evidence: .*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
/** A website address or a place ("Instagram post"); never a repo name or a one-word tag, which is plumbing. */
const aboutOf = (a: Approval): string | undefined => {
  const t = a.payload.target?.trim();
  return t && t.length <= 90 && !/^[\w.-]+\/[\w.-]+$/.test(t) && (/^https?:\/\//.test(t) || /\s/.test(t)) ? t : undefined;
};

/** What saying OK does, in one line. */
function effectLine(a: Approval): string {
  const p = a.preview?.post;
  if (a.kind === "publish_post" && p) {
    return `${p.when ? `If you say OK, this is set for ${p.when.words} on ${p.where}` : `If you say OK, this goes to ${p.where} straight away`}. Nothing is posted before.${p.textOnly ? " Text only: the picture stays out." : ""}`;
  }
  return kindWords(a).effect(a.payload.target);
}

export function DraftView({ a, why, big, stake, tz, locale, tenantId, readOnly, onDecide }: {
  a: Approval;
  /** One line on why it matters. */
  why?: string;
  big?: boolean;
  /** How big: the idea's figure ("≈3× reach per reel"). */
  stake?: string;
  tz?: string; locale?: string; tenantId: string; readOnly: boolean;
  onDecide: (a: Approval, d: "approve" | "reject", edited?: Payload) => Promise<void>;
}) {
  const k = kindWords(a);
  const who = agentDef(a.by);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Payload>(a.payload);
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<string | null>(null);
  const changed = draft.title !== a.payload.title || draft.body !== a.payload.body;
  const off = busy !== null || readOnly;
  const credits = usesWords(a.credits ?? 0);

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

  return (
    <article className={`dr${editing ? " is-editing" : ""}`} aria-labelledby={`dr-${a.id}`} data-approval={a.id}>
      <p className="dr-kind">
        <Icon name={ACTION[a.kind].icon} size={14} /> {k.label}
        {big && <span className="ap-badge">Big one</span>}
        {a.simulated && <span className="ap-sample">sample numbers</span>}
      </p>
      <h2 id={`dr-${a.id}`} className="dr-title">{plainTitle(a.title)}</h2>
      <p className="dr-from">
        <AgentAvatar id={a.by} size={22} />
        <span><b>{who?.name ?? "Your team"}</b> · {whenWords(a.createdAt, tz, locale)}{stake ? <> · <b className="dr-stake">{stake}</b></> : null}</span>
      </p>
      {why && <p className="dr-why">{why}</p>}

      {editing ? (
        <div className="dr-edit">
          <label className="visually-hidden" htmlFor={`dr-t-${a.id}`}>Title</label>
          <input id={`dr-t-${a.id}`} className="field" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <label className="visually-hidden" htmlFor={`dr-b-${a.id}`}>Draft</label>
          <textarea id={`dr-b-${a.id}`} className="field" rows={Math.min(14, Math.max(5, draft.body.split("\n").length + 1))} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <p className="dr-hint">{who?.name ?? "Your team"} remembers your change next time.</p>
        </div>
      ) : (
        <Content a={a} tenantId={tenantId} tz={tz} locale={locale} />
      )}

      {!editing && <p className="dr-effect">{effectLine(a)}{credits ? <span className="uses-credits"> {credits}.</span> : null}</p>}

      <div className="dr-actions">
        {editing ? (
          <>
            <button type="button" className="btn btn-gold dr-yes" onClick={() => go("approve")} disabled={off || !draft.title.trim()}>
              <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : changed ? "Approve with edits" : "Approve"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => { setEditing(false); setDraft(a.payload); }} disabled={busy !== null}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-gold dr-yes" onClick={() => go("approve")} disabled={off} title={readOnly ? "Turned off in the public demo" : undefined}>
              <Icon name="check" size={16} /> {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)} disabled={off}><Icon name="pen" size={15} /> Change</button>
            <button type="button" className="btn btn-quiet" onClick={() => go("reject")} disabled={off}>{busy === "reject" ? "Saying no…" : "No thanks"}</button>
          </>
        )}
      </div>
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
      {a.recommendationId && <p className="dr-more"><Link to="/insights">Why we suggest it</Link></p>}
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
    <div className="dr-content">
      {p?.media && <Options tenantId={tenantId} media={p.media} />}
      {(a.kind === "email_send" && (p?.to || p?.subject)) && (
        <dl className="dr-facts">
          {p.to && <div className="dr-fact"><dt>To</dt><dd>{p.to}</dd></div>}
          {p.cc && <div className="dr-fact"><dt>Copy</dt><dd>{p.cc}</dd></div>}
          {p.subject && <div className="dr-fact"><dt>Subject</dt><dd>{p.subject}</dd></div>}
        </dl>
      )}
      {a.kind === "publish_post" && p?.post && (
        <dl className="dr-facts">
          <div className="dr-fact"><dt>Posts to</dt><dd>{p.post.where}</dd></div>
          <div className="dr-fact"><dt>When</dt><dd>{p.post.when ? `${p.post.when.words}${p.post.when.timeZone ? ` (${p.post.when.timeZone.replace(/_/g, " ")})` : ""}` : "As soon as you say OK"}</dd></div>
        </dl>
      )}
      {a.kind === "calendar_event" && when && (
        <dl className="dr-facts">
          <div className="dr-fact"><dt>When</dt><dd>{when}</dd></div>
          {p?.when && p.when.guests.length > 0 && <div className="dr-fact"><dt>With</dt><dd>{p.when.guests.join(", ")}</dd></div>}
        </dl>
      )}
      {about && !p?.media && a.kind !== "email_send" && a.kind !== "calendar_event" && a.kind !== "publish_post" && (
        <dl className="dr-facts"><div className="dr-fact"><dt>About</dt><dd className="dr-about">{about}</dd></div></dl>
      )}
      {body && <Words text={body} label={p?.media ? "Caption" : undefined} />}
    </div>
  );
}

/** The words, eight lines of them, and the rest one tap away. */
function Words({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420 || text.split("\n").length > 8;
  return (
    <div className="dr-words">
      {label && <p className="dr-words-label">{label}</p>}
      <p className={`dr-body${open || !long ? " is-open" : ""}`}>{text}</p>
      {long && <button type="button" className="dr-showall" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Show less" : "Show more"}</button>}
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
    <div className="dr-options-wrap">
      <ul className={`dr-options${many ? "" : " is-single"}`} aria-label={`The ${noun}${many ? " options" : ""}`}>
        {media.options.map((o) => (
          <li key={o.id} className={`dr-option${o.pick ? " is-pick" : ""}${o.held ? " is-held" : ""}`}>
            {media.kind === "clip" ? (
              <video className="dr-option-img" src={rawSrc(tenantId, o.id)} muted playsInline preload="metadata" aria-label={`Option ${o.label}`} />
            ) : (
              <img className="dr-option-img" src={assetSrc(tenantId, o.id, 260)} alt={many ? `Option ${o.label}` : `The ${noun}`} loading="lazy" width={104} height={130} />
            )}
            <span className="dr-option-label"><b>{many ? `Option ${o.label}` : `The ${noun}`}</b>{o.pick && many ? <span className="dr-pick">Our pick</span> : o.held ? <span className="dr-held">Held back</span> : null}</span>
          </li>
        ))}
        {(media.extras ?? []).map((x) => (
          <li key={x.id} className="dr-option">
            <video className="dr-option-img is-clip" src={rawSrc(tenantId, x.id)} muted playsInline controls preload="metadata" aria-label={`${x.label}: ${x.note}`} />
            <span className="dr-option-label"><b>{x.label}</b></span>
          </li>
        ))}
      </ul>
      {(many || (media.extras ?? []).length > 0) && <p className="dr-hint">{many ? "OK uses our pick." : ""}{(media.extras ?? []).length > 0 ? `${many ? " " : ""}The clip goes with it.` : ""}</p>}
    </div>
  );
}

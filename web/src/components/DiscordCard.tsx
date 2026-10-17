// Where the owner joins their team on Discord, in plain words. Two uses:
//  - the onboarding "done" screen shows what the done event carried (a join link, or "we'll send it shortly");
//  - the Home page asks the server where this business stands (a link, joined, the link ran out, not ready yet).
// Nothing at all is shown on a server with no Discord hub, and the link is never put in the page address or logged.
import { useState } from "react";
import type { DiscordHome, DiscordInfo } from "@shared/contracts";
import { api } from "../api";
import { DISCORD_WORDS as W, viewOfHome, viewOfInfo, type DiscordView as View } from "../lib/discord";
import { useApp, useAsync } from "../state/app";
import { Icon } from "./Icon";
import "./discord-card.css";

function Card({ view, onNewLink, busy, error, quiet }: { view: View; onNewLink?: () => void; busy?: boolean; error?: string; quiet?: boolean }) {
  return (
    <section className={`discord-card${quiet ? " is-quiet" : ""}`} aria-label="Your team on Discord">
      {view.state === "invite" && view.inviteUrl && (
        <>
          <div className="discord-text">
            <h2 className="discord-title">{W.inviteTitle}</h2>
            <p className="discord-sub">{W.inviteLine}</p>
          </div>
          <a className="btn btn-gold discord-btn" href={view.inviteUrl} target="_blank" rel="noopener noreferrer">{W.inviteButton} <Icon name="chevron-right" size={16} /></a>
        </>
      )}
      {view.state === "later" && (
        <div className="discord-text">
          <h2 className="discord-title">Your team on Discord</h2>
          <p className="discord-sub">{W.laterLine}</p>
        </div>
      )}
      {view.state === "expired" && (
        <>
          <div className="discord-text">
            <h2 className="discord-title">{W.expiredTitle}</h2>
            <p className="discord-sub">Links work for a week. Get a new one and join your team.</p>
          </div>
          {onNewLink && <button type="button" className="btn btn-gold discord-btn" onClick={onNewLink} disabled={busy}>{busy ? "Making a new link…" : W.expiredButton}</button>}
        </>
      )}
      {view.state === "joined" && (
        <>
          <div className="discord-text">
            <h2 className="discord-title">{W.joinedTitle}</h2>
            <p className="discord-sub">Ask questions and say OK to things there, or here. It is the same team.</p>
          </div>
          {view.openUrl && <a className="btn btn-quiet discord-btn" href={view.openUrl} target="_blank" rel="noopener noreferrer">{W.openButton} <Icon name="chevron-right" size={16} /></a>}
        </>
      )}
      {error && <p className="discord-error" role="alert">{error}</p>}
    </section>
  );
}

/** The onboarding "done" screen. */
export function DiscordJoin({ info }: { info?: DiscordInfo }) {
  const view = viewOfInfo(info);
  return view ? <Card view={view} /> : null;
}

/** The Home page: asks the server where this business stands; renders nothing without a hub (or in the public demo). */
export function DiscordHomeCard() {
  const { tenant } = useApp();
  const home = useAsync<DiscordHome>(() => api.discord(tenant.id), [tenant.id]);
  const [fresh, setFresh] = useState<DiscordHome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const view = viewOfHome(fresh ?? home.data);
  // "we'll send your link shortly" with no link is a promise, not a place to go: the office shows the card once a link exists
  if (!view || view.state === "later") return null;

  const newLink = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await api.discordNewLink(tenant.id));
    } catch (e) {
      setError((e as Error).message || "We could not make a new link just now. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  };
  return <Card quiet view={view} onNewLink={newLink} busy={busy} error={error} />;
}

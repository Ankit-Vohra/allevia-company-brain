// "Your tools", on Home: what is connected, and the one tool that would help most, said as what it lets the team do ("Connect
// Google Analytics to see visits"). The free website check-up sits here too, where it can be found. Connecting is one tap and goes
// through the provider's own page; on Discord it is /connect (a link only the owner sees), and the check-up is /checkup. Reading
// is straight away; anything that sends, posts, books or spends waits for the owner's OK.
import { useState } from "react";
import { Link } from "react-router";
import type { ProgramGoal } from "@shared/contracts";
import { api, getMode, getPublicMode } from "../../api";
import { toolsSummary } from "../../lib/home";
import type { ConnectionsPage } from "../../types-ext";
import { CheckWebsite } from "../CheckWebsite";
import { comingBack } from "../ConnectionsPanel";
import { Icon } from "../Icon";
import { CardSkeleton, HomeCard } from "./HomeCard";

export function ToolsCard({ tenantId, page, loading, goals }: {
  tenantId: string; page: ConnectionsPage | null | undefined; loading: boolean;
  goals: Array<Pick<ProgramGoal, "metricKey" | "current" | "status">>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [note] = useState(() => comingBack());
  const live = getMode() === "live" && !getPublicMode();
  const rows = page ? [...page.recommended, ...page.more] : undefined;
  const s = toolsSummary(rows, goals);

  const connect = async (id: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await api.connectConnection(tenantId, id, { returnTo: "home" });
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message || "That didn't work. Try again.");
      setBusy(false);
    }
  };

  const unavailable = page && !page.ready;
  return (
    <HomeCard id="tools" title="Your tools" count={s.connected.length} to="/connections" busy={loading && page === undefined}>
      {note?.text && (
        <p className={`notice ${note.text.startsWith("Connected") ? "notice-ok" : ""}`} role="status">
          {note.text}{/Pick which one/.test(note.text) && <> <Link to={`/connections?connect=${encodeURIComponent(note.id)}`}>Choose which one</Link></>}
        </p>
      )}
      {loading && page === undefined ? (
        <CardSkeleton lines={2} />
      ) : unavailable ? (
        <p className="hm-quiet">{page.message ?? "Connecting your tools isn't switched on yet. Your team is setting it up and will let you know when it's ready."}</p>
      ) : (
        <>
          {s.connected.length > 0 ? (
            <ul className="hm-tools" aria-label="Connected">
              {s.connected.slice(0, 8).map((t) => <li key={t.id} className="hm-tool"><Icon name="check" size={13} />{t.name}</li>)}
              {s.connected.length > 8 && <li className="hm-tool is-more">+{s.connected.length - 8} more</li>}
            </ul>
          ) : (
            <p className="hm-quiet">Nothing is connected yet. Your team works from your website and what you tell it.</p>
          )}
          {s.next && (
            <div className={`hm-next${s.next.reconnect ? " is-attention" : ""}`}>
              <p className="hm-next-line">{s.next.line}.</p>
              {live ? (
                <button type="button" className="btn btn-gold btn-sm" disabled={busy} onClick={() => void connect(s.next!.tool.id)} aria-label={`${s.next.reconnect ? "Connect again" : "Connect"} ${s.next.tool.name}`}>
                  {busy ? "Opening…" : s.next.reconnect ? "Connect again" : "Connect"}
                </button>
              ) : (
                <Link className="btn btn-ghost btn-sm" to="/connections">See your tools</Link>
              )}
            </div>
          )}
          {error && <p className="notice notice-bad" role="alert">{error}</p>}
          <p className="hm-quiet">Reading is straight away. Anything that sends, posts, books or spends waits for your OK.</p>
        </>
      )}
      <div className="hm-site"><CheckWebsite tenantId={tenantId} /></div>
    </HomeCard>
  );
}

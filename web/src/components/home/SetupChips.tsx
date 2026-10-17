// "Set up", on Home: one small row of chips, shown only while something is not set up yet (goals to say OK to, a first tool
// to connect, a tool that stopped working). It goes away once there is nothing left. Connecting goes through the provider's
// own page and comes back here; on Discord it is /connect. Everything else about tools lives on /connections.
import { useState } from "react";
import { Link } from "react-router";
import type { ProgramGoal } from "@shared/contracts";
import { api, getMode, getPublicMode } from "../../api";
import { toolsSummary } from "../../lib/home";
import type { ConnectionsPage } from "../../types-ext";
import { comingBack } from "../ConnectionsPanel";
import { Icon } from "../Icon";

export function SetupChips({ tenantId, page, goals, toOk }: {
  tenantId: string;
  page: ConnectionsPage | null | undefined;
  goals: Array<Pick<ProgramGoal, "metricKey" | "current" | "status">>;
  /** Suggested goals the owner has not said OK to yet. */
  toOk: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [note] = useState(() => comingBack());
  const live = getMode() === "live" && !getPublicMode();
  const rows = page && page.ready ? [...page.recommended, ...page.more] : undefined;
  const s = toolsSummary(rows, goals);
  // a first tool only while nothing is connected; a tool that stopped working, always
  const tool = s.next && (s.next.reconnect || s.connected.length === 0) ? s.next : null;

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

  if (!note?.text && !tool && toOk === 0) return null;
  return (
    <section className="hm-setup" aria-label="Set up">
      {note?.text && (
        <p className={`notice ${note.text.startsWith("Connected") ? "notice-ok" : ""}`} role="status">
          {note.text}{/Pick which one/.test(note.text) && <> <Link to={`/connections?connect=${encodeURIComponent(note.id)}`}>Choose which one</Link></>}
        </p>
      )}
      {(tool || toOk > 0) && (
        <ul className="hm-setup-row">
          <li className="hm-setup-label">Set up</li>
          {toOk > 0 && <li><Link className="hm-chip is-setup" to="/program"><Icon name="check" size={14} />OK your {toOk === 1 ? "goal" : `${toOk} goals`}</Link></li>}
          {tool && (
            <li>
              {live ? (
                <button type="button" className={`hm-chip is-setup${tool.reconnect ? " is-attention" : ""}`} disabled={busy} onClick={() => void connect(tool.tool.id)} title={tool.line}>
                  <Icon name="link" size={14} />{busy ? "Opening…" : `${tool.reconnect ? "Reconnect" : "Connect"} ${tool.tool.name}`}
                </button>
              ) : (
                <Link className={`hm-chip is-setup${tool.reconnect ? " is-attention" : ""}`} to="/connections" title={tool.line}>
                  <Icon name="link" size={14} />{tool.reconnect ? "Reconnect" : "Connect"} {tool.tool.name}
                </Link>
              )}
            </li>
          )}
        </ul>
      )}
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
    </section>
  );
}

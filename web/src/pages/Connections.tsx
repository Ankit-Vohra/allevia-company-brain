import { useState } from "react";
import { ConnectionsPanel } from "../components/ConnectionsPanel";
import { useApp } from "../state/app";
import "./owner-page.css";

/** Connections: the tools the team works with. One calm list; connecting is one tap; disconnecting is always there. */
export default function ConnectionsPage() {
  const { tenant } = useApp();
  const [connected, setConnected] = useState<number | null>(null);
  return (
    <div className="owner-page is-tight">
      <header className="owner-head">
        <h1 className="owner-title">Your tools</h1>
        <p className="owner-quiet">{connected === null ? " " : connected === 0 ? "None connected yet · connect what you use" : `${connected} connected`}</p>
      </header>
      <ConnectionsPanel tenantId={tenant.id} variant="page" onChanged={setConnected} />
    </div>
  );
}

/** Where a provider's page sends the owner when they connect from another tab during set-up. */
export function ConnectedPage() {
  const q = new URLSearchParams(location.search);
  const ok = q.get("result") === "connected" || q.get("result") === "choose";
  return (
    <div className="owner-page">
      <h1 className="owner-title">{ok ? "Connected." : q.get("result") === "denied" ? "Nothing was connected." : "That didn't finish."}</h1>
      <p className="owner-lede">{ok ? "You can close this tab and go back to Allevia. Your team is reading it now." : "You can close this tab and try again from Allevia."}</p>
    </div>
  );
}

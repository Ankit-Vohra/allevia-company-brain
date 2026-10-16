import { ConnectionsPanel } from "../components/ConnectionsPanel";
import { useApp } from "../state/app";
import "./owner-page.css";

/** Connections: the tools the team works with. One calm list; connecting is one tap; disconnecting is always there. */
export default function ConnectionsPage() {
  const { tenant } = useApp();
  return (
    <div className="owner-page">
      <header className="owner-head">
        <p className="owner-eyebrow">Connections</p>
        <h1 className="owner-title">Your tools</h1>
        <p className="owner-lede">Your team works better with your real numbers and your real tools. Connect what you use. Reading is straight away; anything that sends, posts, books or spends waits for your OK.</p>
      </header>
      <ConnectionsPanel tenantId={tenant.id} variant="page" />
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

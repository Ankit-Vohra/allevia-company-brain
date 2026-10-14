// Small shared pieces: agent avatars and chips, the simulated badge, check badges, time formatting.
import type { AgentId, TurnChecks } from "@shared/contracts";
import { AGENTS, DEPARTMENTS } from "@shared/roster";
import { avatarUrl } from "../office/sprites";
import { Icon } from "./Icon";

export const agentDef = (id: AgentId) => AGENTS.find((a) => a.id === id);
export const deptOf = (id: AgentId) => DEPARTMENTS.find((d) => d.id === agentDef(id)?.department);

export function AgentAvatar({ id, size = 28, ring }: { id: AgentId; size?: number; ring?: boolean }) {
  const dept = deptOf(id);
  return (
    <span className={`avatar${ring ? " has-ring" : ""}`} style={{ width: size, height: size, ["--hue" as string]: dept?.hue ?? 265 }}>
      <img src={avatarUrl(id, 4)} width={size} height={size} alt="" draggable={false} />
    </span>
  );
}

export function AgentChip({ id, sub }: { id: AgentId; sub?: string }) {
  const a = agentDef(id);
  return (
    <span className="agent-chip">
      <AgentAvatar id={id} size={22} />
      <span className="agent-chip-name">{a?.name ?? id}</span>
      {sub && <span className="agent-chip-sub">{sub}</span>}
    </span>
  );
}

export function SimBadge({ label = "simulated" }: { label?: string }) {
  return <span className="sim-badge" title="Synthetic data, labelled as such">{label}</span>;
}

export function ChecksBadges({ checks, compact }: { checks: TurnChecks; compact?: boolean }) {
  const items: { ok: boolean; good: string; bad: string; detail?: string }[] = [
    { ok: checks.citationsValid, good: "Sources verified", bad: "Unverified citation", detail: checks.invalidCitations.join(", ") },
    { ok: checks.numbersGrounded, good: "Numbers grounded", bad: "Unverified number", detail: checks.ungroundedNumbers.join(", ") },
    { ok: checks.simulatedDisclosed, good: "Simulated data disclosed", bad: "Simulated data not disclosed" },
    { ok: checks.freshnessDisclosed, good: "Dates stated", bad: "Freshness not stated" },
  ];
  const shown = compact ? items.filter((i, idx) => !i.ok || idx < 2) : items;
  return (
    <ul className="checks" aria-label="Answer checks">
      {shown.map((i) => (
        <li key={i.good} className={`badge ${i.ok ? "badge-ok" : "badge-warn"}`} title={i.detail || undefined}>
          <Icon name={i.ok ? "check" : "warn"} size={13} />
          {i.ok ? i.good : i.bad}
          {!i.ok && i.detail ? <span className="mono"> · {i.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function fmtMs(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

export function fmtDate(iso?: string, withTime = false) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) });
}

export function fmtAgo(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate(iso);
}

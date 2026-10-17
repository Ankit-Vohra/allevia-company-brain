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
      {(sub ?? deptOf(id)?.name) && <span className="agent-chip-sub">{sub ?? deptOf(id)?.name}</span>}
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
    // absent on turns saved before the capability ladder: unknown, so not claimed either way
    ...(checks.modeDisclosed === undefined ? [] : [{ ok: checks.modeDisclosed, good: "Data source stated", bad: "Data source not stated" }]),
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

export { fmtAgo, fmtDate, fmtMs } from "../lib/format";

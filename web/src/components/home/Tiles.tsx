// Home's small tiles, one idea each and one tap from its full page: today's note in a line, the goals in one figure, the
// credits left. On Discord the note is /brief and the daily post; the goals ride in the note.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { goalsTally, noteLine, type PlanSummary, type StandupLike } from "../../lib/home";
import { AgentAvatar } from "../bits";
import { Icon, type IconName } from "../Icon";

export function Tile({ id, to, label, icon, avatar, busy, children }: {
  id: string; to: string; label: string; icon?: IconName; avatar?: ReactNode; busy?: boolean; children: ReactNode;
}) {
  return (
    <Link to={to} className="hm-tile" data-home-card={id} aria-busy={busy || undefined}>
      <span className="hm-tile-label">{avatar ?? (icon && <Icon name={icon} size={14} />)}{label}<Icon name="chevron-right" size={13} className="hm-tile-go" /></span>
      {busy ? <span className="skeleton hm-tile-skel" aria-hidden="true" /> : children}
    </Link>
  );
}

export function NoteTile({ standup }: { standup: StandupLike | null | undefined }) {
  return (
    <Tile id="note" to="/insights" label="Today's note" avatar={<AgentAvatar id="chief-of-staff" size={18} />} busy={standup === undefined}>
      <span className="hm-tile-line is-note">{noteLine(standup)}</span>
    </Tile>
  );
}

export function GoalsTile({ plan, loading, toOk }: { plan: PlanSummary | null | undefined; loading: boolean; toOk: number }) {
  const t = goalsTally(plan ?? null);
  return (
    <Tile id="plan" to="/program" label="Goals" icon="insights" busy={loading && plan === undefined}>
      {t ? (
        <>
          <span className="hm-tile-big num">{t.big}</span>
          <span className="hm-tile-line">{toOk > 0 ? `${toOk} need your OK` : t.line}</span>
          <span className="hm-minibars" aria-hidden="true">
            {plan!.goals.map((g) => <span key={g.name} className={`hm-minibar tone-${g.status?.tone ?? "none"}`}><span style={{ width: `${g.progress === null ? 0 : Math.max(4, g.progress * 100)}%` }} /></span>)}
          </span>
        </>
      ) : (
        <>
          <span className="hm-tile-big">Soon</span>
          <span className="hm-tile-line">Your team suggests 3</span>
        </>
      )}
    </Tile>
  );
}

export function CreditsTile({ left, share }: { left: number | null | undefined; share: number }) {
  return (
    <Tile id="credits" to="/plan" label="Credits" icon="layers" busy={left === undefined}>
      {left === null ? (
        <span className="hm-tile-line">See your plan</span>
      ) : (
        <>
          <span className="hm-tile-big num">{(left ?? 0) > 0 ? (left ?? 0).toLocaleString() : "0"}</span>
          <span className="hm-tile-line">left this month</span>
          <span className="hm-minibars" aria-hidden="true"><span className="hm-minibar is-credits"><span style={{ width: `${Math.max(4, (1 - share) * 100)}%` }} /></span></span>
        </>
      )}
    </Tile>
  );
}

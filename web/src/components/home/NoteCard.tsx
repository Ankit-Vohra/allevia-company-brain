// Today's note, on Home: the stand-up's picks with their reasons, folded to its first line. One tap opens the picks; the whole
// note, with how every number was reached, is on "What we noticed". On Discord the same note is /brief and the daily post.
import { useId, useState } from "react";
import { Link } from "react-router";
import { noteLine, notePicks, type StandupLike } from "../../lib/home";
import { AgentAvatar, agentDef } from "../bits";
import { Icon } from "../Icon";
import { CardSkeleton, HomeCard } from "./HomeCard";

export function NoteCard({ standup, loading }: { standup: (StandupLike & { lessons?: string[] }) | null | undefined; loading: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const picks = notePicks(standup);
  const line = noteLine(standup);
  const lessons = standup?.lessons ?? [];
  return (
    <HomeCard id="note" title="Today's note" to="/insights" toLabel="Read it all" busy={loading && standup === undefined}>
      {loading && standup === undefined ? (
        <CardSkeleton lines={1} />
      ) : (
        <>
          <button type="button" className="hm-note-line" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} disabled={picks.length === 0 && lessons.length === 0}>
            <AgentAvatar id="chief-of-staff" size={26} />
            <span className="hm-note-text">{line}</span>
            {(picks.length > 0 || lessons.length > 0) && <Icon name="chevron" size={16} className="hm-note-chev" />}
          </button>
          {open && (
            <div id={id} className="hm-note-body">
              {picks.length > 0 && (
                <ol className="hm-picks">
                  {picks.map((p) => (
                    <li key={p.key} className="hm-pick-row">
                      <AgentAvatar id={p.agent} size={20} />
                      <span className="hm-pick-text">
                        <span className="hm-pick-title">{agentdName(p.agent)} drafted {lowerFirst(p.title)}</span>
                        {p.why && <span className="hm-pick-why">{p.why}</span>}
                      </span>
                      {p.approvalId && <Link className="hm-pick-go" to={`/approvals#${encodeURIComponent(p.approvalId)}`} aria-label={`Look at: ${p.title}`}><Icon name="chevron-right" size={14} /></Link>}
                    </li>
                  ))}
                </ol>
              )}
              {lessons.length > 0 && (
                <ul className="hm-lessons" aria-label="What your team remembered">
                  {lessons.slice(0, 2).map((l) => <li key={l}>{l}</li>)}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </HomeCard>
  );
}

const agentdName = (id: Parameters<typeof agentDef>[0]) => agentDef(id)?.name ?? "Your team";
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

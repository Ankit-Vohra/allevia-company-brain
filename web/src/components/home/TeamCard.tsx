// "Your team", on Home: a small office strip. Everyone on the team stands on one floor, the people working right now first and lit
// with the gold ring, the ones switched off resting and dimmed. A tap on a person opens a chat with them; "Open the office" is the
// whole living office, its own page. On Discord the same people answer in the hub.
import { Link } from "react-router";
import { chatPath } from "../../lib/chat";
import { teamStrip } from "../../lib/home";
import type { AgentView } from "../../types-ext";
import { AgentAvatar } from "../bits";
import { CardSkeleton, HomeCard } from "./HomeCard";

export function TeamCard({ team, working, loading }: { team: AgentView[] | undefined; working: ReadonlySet<string>; loading: boolean }) {
  const strip = teamStrip(team, working);
  return (
    <HomeCard id="team" title="Your team" to="/office" toLabel="Open the office" busy={loading && team === undefined}>
      {loading && team === undefined ? (
        <CardSkeleton lines={2} />
      ) : (
        <>
          <p className="hm-team-line" role="status" aria-live="polite">{strip.line}</p>
          {/* two even rows whatever the size of the team (13 people today: 7 and 6) */}
          <ul className="hm-floor" aria-label="Your team" style={{ ["--cols" as string]: Math.ceil(strip.people.length / 2) }}>
            {strip.people.map((p) => (
              <li key={p.id} className={`hm-person is-${p.dot}`}>
                <Link to={chatPath(p.id)} className="hm-person-link" aria-label={`${p.name}, ${p.title}: ${p.dot === "working" ? "working now" : p.dot === "off" ? "resting" : "ready"}. Open a chat.`}>
                  <span className="hm-person-face"><AgentAvatar id={p.id} size={36} ring={p.dot === "working"} /><span className="hm-person-dot" aria-hidden="true" /></span>
                  <span className="hm-person-name">{p.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </HomeCard>
  );
}

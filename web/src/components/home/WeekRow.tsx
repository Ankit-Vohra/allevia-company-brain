// "Your team this week" on Home: one compact row of five counts from the business's graph (GET /api/:t/week), each a link
// to its list. A quiet week shows plain zeros and one calm line; if the counts cannot be read, the row stays away (Home
// stays calm). The words are in lib/week.ts.
import { Link } from "react-router";
import type { WeekDto } from "@shared/week";
import { weekItemLabel, weekItems, weekLine } from "../../lib/week";

/** `week`: undefined while loading, null when it could not be read. */
export function WeekRow({ week }: { week: WeekDto | null | undefined }) {
  if (week === null) return null;
  const line = week ? weekLine(week) : null;
  return (
    <section className="hm-week" aria-labelledby="hm-week-title" aria-busy={week === undefined || undefined}>
      <h2 id="hm-week-title" className="hm-week-title">Your team this week</h2>
      {line && <p className="hm-week-line">{line}</p>}
      {week === undefined ? (
        <span className="skeleton hm-week-skel" aria-hidden="true" />
      ) : (
        <ul className="hm-week-row">
          {weekItems(week).map((i) => (
            <li key={i.key}>
              <Link to={i.to} className="hm-week-item" data-week={i.key} aria-label={weekItemLabel(i)}>
                <span className="hm-week-n num">{i.n}</span>
                <span className="hm-week-l">{i.label}</span>
                {i.note && <span className="hm-week-note">{i.note}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

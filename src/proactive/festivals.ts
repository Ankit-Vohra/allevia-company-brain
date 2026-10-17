// The festival calendar (calendar.ts, a fixed table in code) as nodes in the business's own graph: each date the stand-up looks at is an
// Event {kind:'festival', date}, so a pick for Diwali or the wedding season is EVIDENCED_BY something a person can open, and "which of
// our cards were for Diwali" is a traversal. Written (idempotently) by gatherSignals for the dates it is about to use; a date that has
// gone by stays in the graph with its cards.
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";
import { cap1, dayMs } from "../insights/text.js";
import { entityId } from "../util/ids.js";
import type { Upcoming } from "./calendar.js";

export const FESTIVAL_SRC = "allevia:festival-calendar";
// When the table in calendar.ts was last checked against the published calendars (its header says so): the date of what the Events state.
export const FESTIVAL_AS_OF = "2026-10-16";

/** The Event node for a calendar entry: its key is stable ("diwali-2026"), so the same date is the same node every year it is looked at. */
export const festivalEventId = (key: string): string => entityId("Event", `festival ${key}`);

/** Writes (or refreshes) the Event for each upcoming date. Returns their ids. */
export async function writeFestivals(g: GraphHandle, dates: readonly Upcoming[], o: { now: number; countryCode?: string }): Promise<string[]> {
  const ids: string[] = [];
  for (const d of dates) {
    const id = festivalEventId(d.key);
    await upsertNode(g, {
      type: "Event", id, name: cap1(d.name),
      summary: `${cap1(d.name)}: ${d.until ? `from ${d.date} to ${d.until}` : d.date}${d.approx ? " (a moon-calendar date: the published expectation)" : ""}.`,
      props: {
        kind: "festival", date: d.date, at: dayMs(d.date), occasion: d.kind, ...(d.until ? { until: d.until } : {}), ...(d.approx ? { approx: true } : {}),
        ...(d.suits?.length ? { suits: [...d.suits] } : {}), ...(o.countryCode ? { country: o.countryCode.toUpperCase() } : {}),
      },
      src: FESTIVAL_SRC, asOf: FESTIVAL_AS_OF,
    }, o.now);
    ids.push(id);
  }
  return ids;
}

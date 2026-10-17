// Home's small tiles, as data. Home lays them out in one row under "Needs your OK" by `order` (smaller is first); on a phone a
// `wide` tile takes the whole row and the rest sit two by two. To add an area to Home (Sales, #41, adds "Leads"), add one entry
// here: it gets everything Home has already loaded in `ctx`, and the layout needs no change. Keep a tile to one idea: a label,
// one figure or one line, and a tap into its full page. Anything the owner can do from a tile needs a Discord path too
// (docs/founder-os.md, "Home and Discord").
import type { ReactNode } from "react";
import { CreditsTile, GoalsTile, IdeasTile } from "../components/home/Tiles";
import { goalsTally, type PlanSummary, type StandupLike } from "../lib/home";
import type { Tenant } from "../types-ext";

/** What Home has loaded for the business on screen. `undefined` means still loading; `null`, nothing there (no plan, no note yet). */
export interface HomeCtx {
  tenant: Tenant;
  standup: StandupLike | null | undefined;
  plan: { data: PlanSummary | null | undefined; loading: boolean };
  /** Suggested goals the owner has not said OK to yet. */
  goalsToOk: number;
  /** The best idea right now (repeats folded), in the owner's words; null when there is none. */
  topIdea: string | null | undefined;
  /** Credits left this month, and how much of the month is used (0 to 1). */
  credits: { left: number | null | undefined; used: number };
}

/** `wide`: takes a whole row on a phone, and twice the room on a wide screen. `show`: leave the tile out while it has
 *  nothing to say (no empty tiles on Home). */
export interface HomeTileDef { id: string; order: number; wide?: boolean; show?: (c: HomeCtx) => boolean; render: (c: HomeCtx) => ReactNode }

export const HOME_TILES: HomeTileDef[] = [
  { id: "ideas", order: 10, wide: true, render: (c) => <IdeasTile top={c.topIdea} standup={c.standup} /> },
  // the goals tile waits until a goal has a number
  { id: "plan", order: 20, show: (c) => !!c.plan.data && !c.plan.data.allWaiting && !!goalsTally(c.plan.data), render: (c) => <GoalsTile plan={c.plan.data} loading={c.plan.loading} toOk={c.goalsToOk} /> },
  { id: "credits", order: 30, render: (c) => <CreditsTile left={c.credits.left} share={c.credits.used} /> },
];

export const tilesInOrder = (tiles: readonly HomeTileDef[] = HOME_TILES, c?: HomeCtx): HomeTileDef[] =>
  [...tiles].filter((t) => !c || !t.show || t.show(c)).sort((a, b) => a.order - b.order);

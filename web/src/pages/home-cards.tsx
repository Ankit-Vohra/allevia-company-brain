// The cards on Home, as data. Home puts each card in a column by `column` and `order` (smaller is higher): "main" is the wide
// column (on a phone it comes first), "side" the narrow one. To add an area to Home (Sales, #41, adds "Leads and meetings"),
// add one entry here: it gets everything Home has already loaded in `ctx`, and the layout, the spacing and the phone order
// need no change. Keep a card to one calm block with a title, the one thing to do, and a "See all" link into its full page
// (HomeCard); anything the owner can do on a card needs a Discord path too (docs/founder-os.md, "Home and Discord").
import type { ReactNode } from "react";
import type { ProgramScorecard } from "@shared/contracts";
import { NoteCard } from "../components/home/NoteCard";
import { PlanCard } from "../components/home/PlanCard";
import { TeamCard } from "../components/home/TeamCard";
import { ToolsCard } from "../components/home/ToolsCard";
import { WaitingCard } from "../components/home/WaitingCard";
import type { StandupLike, WaitingItem } from "../lib/home";
import type { Approval, AgentView, ConnectionsPage, Tenant } from "../types-ext";

/** What Home has loaded for the business on screen. `undefined` means still loading; `null`, nothing there (no plan, no stand-up yet). */
export interface HomeCtx {
  tenant: Tenant;
  waiting: WaitingItem<Approval>[];
  approvals: { loading: boolean; error?: string };
  standup: StandupLike | null | undefined;
  program: { data: ProgramScorecard | null | undefined; loading: boolean; error?: string };
  /** Suggested goals the owner has not said OK to yet. */
  goalsToOk: number;
  connections: { data: ConnectionsPage | null | undefined; loading: boolean };
  team: { data: AgentView[] | undefined; loading: boolean };
  /** Roster ids working this moment. */
  working: ReadonlySet<string>;
  /** Reload what a decision changes (the drafts, the plan, the team's habits). */
  changed: () => void;
  learned: () => void;
}

export type HomeColumn = "main" | "side";
export interface HomeCardDef { id: string; column: HomeColumn; order: number; render: (c: HomeCtx) => ReactNode }

export const HOME_CARDS: HomeCardDef[] = [
  {
    id: "waiting", column: "main", order: 10,
    render: (c) => <WaitingCard tenantId={c.tenant.id} tz={c.tenant.timeZone} locale={c.tenant.locale} items={c.waiting} loading={c.approvals.loading} error={c.approvals.error} onChanged={c.changed} onLearned={c.learned} />,
  },
  { id: "note", column: "main", order: 20, render: (c) => <NoteCard standup={c.standup} loading={c.standup === undefined} /> },
  {
    id: "plan", column: "side", order: 10,
    render: (c) => <PlanCard program={c.program.data} loading={c.program.loading} error={c.program.error} toOk={c.goalsToOk} />,
  },
  {
    id: "tools", column: "side", order: 20,
    render: (c) => <ToolsCard tenantId={c.tenant.id} page={c.connections.data} loading={c.connections.loading} goals={c.program.data?.goals ?? []} />,
  },
  { id: "team", column: "side", order: 30, render: (c) => <TeamCard team={c.team.data} working={c.working} loading={c.team.loading} /> },
];

export const cardsIn = (column: HomeColumn, cards: readonly HomeCardDef[] = HOME_CARDS): HomeCardDef[] =>
  cards.filter((c) => c.column === column).sort((a, b) => a.order - b.order);

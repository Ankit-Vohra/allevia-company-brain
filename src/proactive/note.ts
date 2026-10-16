// Reading and wording a day's stand-up, apart from running it (Today's note and the API read it without pulling in the
// signals and drafting code).
import type { GraphHandle } from "../graph/client.js";
import { plural } from "../insights/text.js";
import { entityId } from "../util/ids.js";
import type { Skipped } from "./choose.js";
import { draftedLine, type DraftedItem } from "./draft.js";

export const standupDocId = (tenant: string, date: string): string => entityId("Document", `standup ${tenant} ${date}`);

export const QUIET_LINE = "Nothing new worth your time today.";

export interface Reviewed {
  newNumbers: number; bigMoves: number; uploads: number; goals: number; goalsMoved: number; decisions: number; saidNo: number; learned: number;
  publicData: boolean; reviews: number; competitorMoves: number; websiteChecked: boolean; websiteFails: number; dates: string[]; openIdeas: number;
}

export interface Standup {
  id: string;
  tenant: string;
  date: string;                 // UTC date, the same day Today's note uses
  localDate: string;            // the business's own date
  generatedAt: number;
  quiet: boolean;
  by: "meera" | "rules";
  items: DraftedItem[];         // drafted (and failed) items, in Meera's order
  heading: string;              // "Your team noticed 2 things and drafted them"
  lines: string[];              // the note's lines under the heading
  reviewed: Reviewed;
  considered: number;
  skipped: Skipped[];
  lessons: string[];
  attendees: string[];          // roster ids at the stand-up: Meera and whoever got work
  paidUsed: number;
  reused?: boolean;
}

export function noteSection(items: DraftedItem[], lessons: string[]): { heading: string; lines: string[] } {
  const done = items.filter((i) => i.status === "drafted" && i.approvalId);
  const extra = lessons.slice(0, 1).map((l) => `- ${l}`);
  if (!done.length) return { heading: "Your team met this morning", lines: [`- ${QUIET_LINE}`, ...extra] };
  return {
    heading: `Your team noticed ${plural(done.length, "thing")} and drafted ${done.length === 1 ? "it" : "them"}`,
    lines: [...done.map((d, i) => `${i + 1}. ${draftedLine(d)}: ${d.why.replace(/\.$/, "")}. [[${d.approvalId}]]`), ...extra],
  };
}

interface DocRow { id: string; props: Record<string, unknown> }

const parse = <T>(v: unknown, d: T): T => {
  if (typeof v !== "string") return d;
  try { return JSON.parse(v) as T; } catch { return d; }
};

export function standupFrom(r: DocRow): Standup {
  const p = r.props;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    id: r.id, tenant: String(p.tenant ?? ""), date: String(p.date ?? ""), localDate: String(p.localDate ?? p.date ?? ""), generatedAt: num(p.generatedAt),
    quiet: p.quiet === true, by: p.by === "meera" ? "meera" : "rules", items: parse<DraftedItem[]>(p.items, []), heading: String(p.heading ?? ""),
    lines: parse<string[]>(p.lines, []), reviewed: parse<Reviewed>(p.reviewed, {} as Reviewed), considered: num(p.considered),
    skipped: parse<Skipped[]>(p.skipped, []), lessons: parse<string[]>(p.lessons, []), attendees: parse<string[]>(p.attendees, []), paidUsed: num(p.paidUsed),
  };
}

/** The stand-up of a day (UTC date), or the newest when no date is given. */
export async function readStandup(g: Pick<GraphHandle, "roQuery">, date?: string): Promise<Standup | null> {
  const [r] = await g.roQuery<DocRow>(
    `MATCH (d:Document) WHERE d.kind = 'standup' AND ($date IS NULL OR d.date = $date)
     RETURN d.id AS id, properties(d) AS props ORDER BY coalesce(d.generatedAt, 0) DESC, id LIMIT 1`, { date: date ?? null });
  return r ? standupFrom(r) : null;
}


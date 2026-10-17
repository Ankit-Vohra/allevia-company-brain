// meetings_read: what was said in the business's meetings, from the records "remember this meeting" made (src/agent/meeting.ts)
// and the calls the Sales desk booked. Answers "what did we decide with Kettle & Crumb?" (the meetings with a person, a company,
// a lead or a deal, and the decisions about them) and "what's pending from the meeting on 16 Oct?" (its tasks, their owners and
// due dates, open ones only when asked). Each meeting comes with its decisions, its tasks and the follow-up card's state.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import {
  Collector, EDGE, InputError, NODE, defineTool, ftEntities, getNodes, ro, type EdgeRow, type NodeRow,
} from "./common.js";

const MEETINGS_CAP = 5;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const DONE = new Set(["done", "closed", "completed", "cancelled", "canceled"]);
const WITH_TYPES = ["Person", "Client", "Supplier", "Partner", "Competitor", "Lead", "Deal", "Product"];

// soonest due first; a task with no due date last
const byDue = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);

interface MeetingRow { m: NodeRow; date: string | null; start: number | null; summary: string | null; facts: string[] | null; status: string | null }

async function meetingsWith(ctx: ToolContext, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await ro<{ id: string }>(ctx,
    `UNWIND $ids AS x MATCH (n:Entity {id:x}) WITH n MATCH (m:Meeting)-[r]-(n) WHERE r.until IS NULL RETURN DISTINCT m.id AS id
     UNION
     UNWIND $ids AS x MATCH (n:Entity {id:x}) WITH n MATCH (m:Meeting)-[r:MEETING_WITH]->(:Person)-[w:MEMBER_OF]->(n) WHERE r.until IS NULL AND w.until IS NULL RETURN DISTINCT m.id AS id
     UNION
     UNWIND $ids AS x MATCH (n:Entity {id:x}) WITH n MATCH (d:Decision)-[a:AFFECTS]->(n) WHERE a.until IS NULL WITH d MATCH (d)-[p:PART_OF]->(m:Meeting) WHERE p.until IS NULL RETURN DISTINCT m.id AS id
     UNION
     UNWIND $ids AS x MATCH (n:Entity {id:x}) WITH n MATCH (t:Task)-[k:MENTIONS]->(n) WHERE k.until IS NULL WITH t MATCH (t)-[f:FOLLOWS_UP]->(m:Meeting) WHERE f.until IS NULL RETURN DISTINCT m.id AS id`,
    { ids });
  return rows.map((r) => r.id);
}

async function runMeetings(args: { with?: string; date?: string; open?: boolean }, ctx: ToolContext) {
  const date = args.date?.trim();
  if (date && !ISO_DAY.test(date)) throw new InputError("date must be YYYY-MM-DD, e.g. \"2026-10-16\".");
  const col = new Collector();

  // who or what the meetings were with: an id, or a name searched among people, companies, leads, deals and products
  let withIds: string[] = [];
  let withMatched: Array<{ id: string; name: string | null }> = [];
  if (args.with?.trim()) {
    const w = args.with.trim();
    const byId = w.includes(":") ? await getNodes(ctx, [w]) : new Map<string, NodeRow>();
    const hits = byId.size ? [...byId.values()] : (await ftEntities(ctx, w, WITH_TYPES, 4)).map((h) => h.n);
    withIds = hits.map((n) => n.id);
    withMatched = hits.map((n) => ({ id: n.id, name: n.name }));
    for (const n of hits) col.node(n);
    if (!withIds.length) return col.result(ctx, { meetings: [], with: w }, `Nothing in the records is called "${w}". Try search, or another spelling.`);
  }

  let ids: string[];
  if (withIds.length) {
    ids = await meetingsWith(ctx, withIds);
  } else if (date) {
    const from = Date.parse(`${date}T00:00:00Z`);
    ids = (await ro<{ id: string }>(ctx,
      "MATCH (m:Meeting) WHERE m.date = $date OR (m.start >= $from AND m.start < $to) RETURN m.id AS id ORDER BY id LIMIT 50",
      { date, from: from - DAY_MS / 2, to: from + DAY_MS * 1.5 })).map((r) => r.id);
  } else {
    ids = (await ro<{ id: string }>(ctx,
      "MATCH (m:Meeting) WITH m, coalesce(m.start, 0) AS at RETURN m.id AS id ORDER BY at DESC, id LIMIT $k", { k: MEETINGS_CAP })).map((r) => r.id);
  }
  if (!ids.length) {
    return col.result(ctx, { meetings: [], ...(withMatched.length ? { with: withMatched } : {}), ...(date ? { date } : {}) },
      "No meeting is in the records for that. The owner can paste notes after \"Remember this meeting\" to add one.");
  }

  const metas = await ro<MeetingRow>(ctx,
    `UNWIND $ids AS mid MATCH (m:Entity {id:mid}) RETURN ${NODE("m")} AS m, m.date AS date, m.start AS start, m.summary AS summary, m.facts AS facts, m.status AS status`,
    { ids: [...new Set(ids)] });
  // a date asked for keeps the meetings near it; the rest, newest first
  const dateOf = (r: MeetingRow): string => r.date ?? (typeof r.start === "number" ? new Date(r.start).toISOString().slice(0, 10) : "");
  const picked = metas.filter((r) => !date || dateOf(r) === date || !withIds.length)
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || a.m.id.localeCompare(b.m.id)).slice(0, MEETINGS_CAP);
  const mids = picked.map((r) => r.m.id);

  const [attendees, decisions, tasks, cards] = await Promise.all([
    ro<{ mid: string; p: NodeRow; e: EdgeRow }>(ctx,
      `UNWIND $mids AS mid MATCH (m:Entity {id:mid}) WITH mid, m MATCH (m)-[r:MEETING_WITH]->(p:Person) WHERE r.until IS NULL RETURN mid, ${NODE("p")} AS p, ${EDGE("r")} AS e`, { mids }),
    ro<{ mid: string; d: NodeRow; e: EdgeRow; text: string | null; status: string | null }>(ctx,
      `UNWIND $mids AS mid MATCH (m:Entity {id:mid}) WITH mid, m MATCH (d:Decision)-[r:PART_OF]->(m) WHERE r.until IS NULL
       RETURN mid, ${NODE("d")} AS d, ${EDGE("r")} AS e, coalesce(d.text, d.summary, d.name) AS text, d.status AS status`, { mids }),
    ro<{ mid: string; t: NodeRow; e: EdgeRow; status: string | null; due: string | null }>(ctx,
      `UNWIND $mids AS mid MATCH (m:Entity {id:mid}) WITH mid, m MATCH (t:Task)-[r:FOLLOWS_UP]->(m) WHERE r.until IS NULL
       RETURN mid, ${NODE("t")} AS t, ${EDGE("r")} AS e, t.status AS status, t.due AS due`, { mids }),
    ro<{ mid: string; id: string; status: string | null; title: string | null }>(ctx,
      `UNWIND $mids AS mid MATCH (m:Entity {id:mid}) WITH mid, m MATCH (rec:Recommendation)-[r:EVIDENCED_BY]->(m) WHERE r.until IS NULL
       WITH mid, rec MATCH (rec)-[p:PROPOSES]->(a:Approval) WHERE p.until IS NULL RETURN mid, a.id AS id, a.status AS status, a.title AS title`, { mids }),
  ]);
  const tids = [...new Set(tasks.map((t) => t.t.id))];
  const owners = tids.length ? await ro<{ tid: string; o: NodeRow; e: EdgeRow }>(ctx,
    `UNWIND $tids AS tid MATCH (t:Entity {id:tid}) WITH tid, t MATCH (o:Entity)-[w:OWNS]->(t) WHERE w.until IS NULL RETURN tid, ${NODE("o")} AS o, ${EDGE("w")} AS e`, { tids }) : [];
  const ownerOf = new Map(owners.map((o) => [o.tid, o]));

  const isOpen = (s: string | null): boolean => !DONE.has((s ?? "open").toLowerCase());
  const meetings = picked.map((r) => {
    col.node(r.m);
    const mine = <T extends { mid: string }>(xs: T[]): T[] => xs.filter((x) => x.mid === r.m.id);
    const people = mine(attendees).map((a) => { col.node(a.p); col.edge(a.e); return a.p.name ?? a.p.id; });
    const decided = mine(decisions).sort((a, b) => a.d.id.localeCompare(b.d.id)).map((x) => { col.node(x.d); col.edge(x.e); return { id: x.d.id, text: x.text ?? x.d.name, status: x.status }; });
    const todo = mine(tasks).filter((x) => !args.open || isOpen(x.status)).sort((a, b) => byDue(a.due, b.due) || a.t.id.localeCompare(b.t.id)).map((x) => {
      col.node(x.t);
      col.edge(x.e);
      const o = ownerOf.get(x.t.id);
      if (o) { col.node(o.o); col.edge(o.e); }
      return { id: x.t.id, text: x.t.name, owner: o ? (o.o.name ?? o.o.id) : null, due: x.due, status: x.status ?? "open" };
    });
    const followUps = mine(cards).sort((a, b) => a.id.localeCompare(b.id)).map((c) => ({ id: c.id, title: c.title, status: c.status }));
    return {
      id: r.m.id, name: r.m.name, date: dateOf(r) || null, status: r.status, with: people,
      ...(r.summary ? { summary: r.summary } : {}), ...(r.facts?.length ? { numbers: r.facts } : {}),
      ...(r.m.simulated ? { simulated: true } : {}),
      decisions: decided, tasks: todo, ...(followUps.length ? { followUps } : {}),
    };
  });
  const open = meetings.reduce((n, m) => n + m.tasks.filter((t) => isOpen(t.status)).length, 0);
  return col.result(ctx, {
    meetings, ...(withMatched.length ? { with: withMatched } : {}), ...(date ? { date } : {}), openTasks: open,
  }, meetings.some((m) => m.simulated) ? "Some of these meetings come from a sample transcript: say they are sample data." : undefined);
}

export const meetingsRead = defineTool({
  name: "meetings_read",
  description:
    "The business's meetings: date, who was there, decisions, tasks (owner, due, status) and the follow-up card. For \"what did we decide with X?\" pass with; for \"what's pending from the meeting on <date>?\" pass date and open. Example: {\"with\":\"Kettle & Crumb\"} or {\"date\":\"2026-10-16\",\"open\":true}",
  input: {
    with: z.string().max(120).optional().describe("A person, company, lead, deal or product the meeting was with or about: a name or an id"),
    date: z.string().max(10).optional().describe("The meeting's day, YYYY-MM-DD"),
    open: z.boolean().optional().describe("Only tasks still open"),
  },
  run: runMeetings,
});

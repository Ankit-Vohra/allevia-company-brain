// Forget a SAMPLE recorded meeting, so the demo can show it arriving again (a retake of the video, a second rehearsal). Only a
// meeting marked sample (simulated) can be forgotten: a real call's minutes, decisions and tasks are the business's memory and stay.
// What goes: everything the meeting turn wrote from that call (the nodes whose source is its transcript: the meeting, its lines,
// decisions, tasks, the minutes, and any person or company first named in it), the transcript itself, their history (Versions),
// what the capture turn saved (its findings),
// the note for recall, the minutes card (Recommendation and Approval), and the chat thread the capture opened. What stays: the
// business, the AI teammates, and anything that was in the brain before the call.
import type { GraphHandle } from "../graph/client.js";
import { capturedIds } from "../agent/meeting.js";
import type { RecordedMeeting } from "./recorders.js";

export interface Forgotten { meetingId: string; nodes: number; turns: number }

export class NotSample extends Error {}

export async function forgetSampleMeeting(g: GraphHandle, recorder: RecordedMeeting["recorder"], externalId: string): Promise<Forgotten | null> {
  const { meetingId, docId, minutesId } = capturedIds({ recorder, externalId });
  const [m] = await g.roQuery<{ simulated: boolean | null }>("MATCH (m:Entity:Meeting {id:$id}) RETURN m.simulated AS simulated", { id: meetingId });
  if (!m) return null;
  if (m.simulated !== true) throw new NotSample(`${meetingId} is a real meeting, not a sample: it stays in the brain.`);

  const fromCall = await g.roQuery<{ id: string }>("MATCH (n:Entity) WHERE n.src = $doc RETURN n.id AS id", { doc: docId });
  const cards = await g.roQuery<{ rec: string; ap: string | null }>(
    `MATCH (m:Entity {id:$m}) WITH m MATCH (r:Recommendation)-[e:EVIDENCED_BY]->(m) WHERE e.until IS NULL
     OPTIONAL MATCH (r)-[p:PROPOSES]->(a:Approval) RETURN r.id AS rec, a.id AS ap`, { m: meetingId });
  const notes = await g.roQuery<{ id: string }>("MATCH (m:Entity {id:$m}) WITH m MATCH (n:Memory)-[e:ABOUT]->(m) WHERE e.until IS NULL RETURN n.id AS id", { m: meetingId });
  const turns = await g.roQuery<{ id: string; session: string | null }>(
    `MATCH (m:Entity {id:$m}) WITH m MATCH (t:Turn)-[e:TOUCHED]->(m) WHERE e.until IS NULL AND t.question STARTS WITH 'New meeting from'
     OPTIONAL MATCH (t)-[s:IN_SESSION]->(x:Session) RETURN t.id AS id, x.id AS session`, { m: meetingId });

  // what the capture turn itself saved: its findings, the card, the note (all sourced to the turn)
  const fromTurn = turns.length ? await g.roQuery<{ id: string }>("MATCH (n:Entity) WHERE n.src IN $turns RETURN n.id AS id", { turns: turns.map((t) => t.id) }) : [];
  const ids = [...new Set([
    meetingId, docId, minutesId, ...fromCall.map((r) => r.id), ...notes.map((r) => r.id), ...fromTurn.map((r) => r.id),
    ...cards.flatMap((c) => [c.rec, ...(c.ap ? [c.ap] : [])]), ...turns.map((t) => t.id),
  ])];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    await g.query("UNWIND $ids AS id MATCH (n:Entity {id:id}) WITH n MATCH (n)-[:HAD_VERSION]->(v:Version) DETACH DELETE v", { ids: part });
    await g.query("UNWIND $ids AS id MATCH (n:Entity {id:id}) DETACH DELETE n", { ids: part });
  }
  // a thread left with no turns goes too
  for (const s of new Set(turns.map((t) => t.session).filter((x): x is string => !!x))) {
    const [left] = await g.roQuery<{ n: number }>("MATCH (x:Entity:Session {id:$s}) OPTIONAL MATCH (t:Turn)-[e:IN_SESSION]->(x) WHERE e.until IS NULL WITH count(t) AS n RETURN n", { s });
    if (left && left.n === 0) await g.query("MATCH (x:Entity:Session {id:$s}) DETACH DELETE x", { s });
  }
  return { meetingId, nodes: ids.length, turns: turns.length };
}

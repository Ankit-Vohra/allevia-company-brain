// One Discord thread is one Allevia conversation (spec §7.3): the thread's id is stored on its Session as
// `discordThreadId`, so a reply continues the same session, also after the bot restarts. Cross-thread memory comes
// from the graph (recall), not from Discord.
import { newSessionId, startSession } from "../agent/memory.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";

// The session a thread belongs to, or null when the thread has none yet (the newest one wins if there were several).
export async function findThreadSession(g: GraphHandle, threadId: string): Promise<string | null> {
  const rows = await g.roQuery<{ id: string }>(
    "MATCH (s:Session) WHERE s.discordThreadId = $tid RETURN s.id AS id ORDER BY coalesce(s.startedAt, 0) DESC, s.id DESC LIMIT 1",
    { tid: threadId });
  return rows[0]?.id ?? null;
}

// Starts a session for a new thread and records the link, before the first turn runs, so a reply that arrives while
// the first answer is still being written finds it.
export async function openThreadSession(
  g: GraphHandle, o: { threadId: string; title: string; asker: string; now?: number },
): Promise<string> {
  const now = o.now ?? Date.now();
  const s = await startSession(g, { channel: "discord", asker: o.asker, title: o.title, id: newSessionId(now) }, now);
  await upsertNode(g, { type: "Session", id: s.id, name: s.title, props: { discordThreadId: o.threadId } }, now);
  return s.id;
}

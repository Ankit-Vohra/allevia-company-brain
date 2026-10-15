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

// The newest conversations that were started in the web app and have no Discord thread yet: what /continue offers.
export async function recentUnlinkedSessions(g: GraphHandle, limit = 5): Promise<Array<{ id: string; title: string }>> {
  const rows = await g.roQuery<{ id: string; name: string | null }>(
    `MATCH (s:Entity:Session) WHERE s.discordThreadId IS NULL AND coalesce(s.channel, 'web') = 'web'
     RETURN s.id AS id, s.name AS name ORDER BY coalesce(s.lastAt, s.startedAt, 0) DESC, s.id LIMIT $limit`, { limit: Math.max(1, Math.min(10, limit)) });
  return rows.map((r) => ({ id: r.id, title: r.name || "Conversation" }));
}

// Ties a conversation to a Discord thread, so replies there continue it. The conversation keeps being one Session: the
// web app and Discord are two doors into it. Returns the thread it is already tied to when there is one (nothing changes).
export async function linkSessionThread(g: GraphHandle, sessionId: string, threadId: string, now: number): Promise<{ linked: true } | { linked: false; threadId: string } | null> {
  const [s] = await g.roQuery<{ name: string | null; tid: string | null }>(
    "MATCH (s:Entity:Session {id:$id}) RETURN s.name AS name, s.discordThreadId AS tid LIMIT 1", { id: sessionId });
  if (!s) return null;
  if (s.tid) return { linked: false, threadId: s.tid };
  await upsertNode(g, { type: "Session", id: sessionId, name: s.name || "Conversation", props: { discordThreadId: threadId } }, now);
  return { linked: true };
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

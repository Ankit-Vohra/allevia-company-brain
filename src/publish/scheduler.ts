// The clock behind "post Tuesday 7 pm". Every half minute, for each business that has a posting connection, it looks for
//   - scheduled posts whose time has come, and posts them (the OK was given earlier, on that exact content);
//   - posts a platform was still preparing (an Instagram video), and asks again, for up to half an hour;
//   - posts a crash left half way: never repeated by itself, they are marked "may have gone out" and the owner is asked to look.
// The result of each is written back to the post, the card's Action and the card itself (record.ts, executor.ts), and handed to
// `onResult` so the owner is told where they read: the web card shows it at once, and the server sends a note to Discord.
// A dry run (ALLEVIA_ACTIONS_LIVE is not 1 when its time comes) posts nothing and says so.
import type { GraphHandle } from "../graph/client.js";
import { PENDING_GIVE_UP_MS, PENDING_RETRY_MS, STUCK_MS, recordOutcome, runJob, type PublishEnv, type PublishOutcome } from "./executor.js";
import { dueIds, pendingIds, readPost, stuckIds, writePost } from "./record.js";
import type { PostRow } from "./types.js";

export interface ScheduledResult { tenant: string; id: string; post: PostRow | null; outcome: PublishOutcome }

export interface ScheduleDeps {
  tenants: () => Promise<Array<{ slug: string }>>;
  openGraph: (slug: string) => Promise<GraphHandle>;
  /** What a post of this business needs; null: nothing can be posted for it (skipped). */
  env: (slug: string) => PublishEnv | null;
  /** A cheap look before the graph is opened: does this business have a posting connection at all? Absent: every business is looked at. */
  hasPostingConnection?: (slug: string) => Promise<boolean>;
  onResult?: (r: ScheduledResult) => Promise<void> | void;
  now?: () => number;
  log?: (line: string) => void;
  intervalMs?: number;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One business, one look. Returns what it did. */
export async function runDue(slug: string, g: GraphHandle, env: PublishEnv, now: number): Promise<ScheduledResult[]> {
  const out: ScheduledResult[] = [];
  const done = async (id: string, r: Awaited<ReturnType<typeof runJob>>) => {
    if (r.outcome.status === "skipped" || !r.post) return;
    await recordOutcome(g, r.post, r.outcome, now);
    out.push({ tenant: slug, id, post: r.post, outcome: r.outcome });
  };

  // half-finished by a crash: the owner is asked to look, nothing is repeated
  for (const id of await stuckIds(g, now - STUCK_MS)) {
    const row = await readPost(g, id);
    if (!row) continue;
    const words = "We couldn't confirm that this went out (the server stopped while it was being posted). Check your account. If it isn't there, tap Post again.";
    await writePost(g, id, row.title, { status: "failed", failure: words, retryable: true, maybePosted: true, counted: true, postedAt: row.postedAt ?? row.attemptedAt ?? now }, now);
    await done(id, { outcome: { status: "failed", result: words, produced: [id] }, post: await readPost(g, id) });
  }

  // a platform that was still preparing a video: ask again, and stop asking after half an hour
  for (const id of await pendingIds(g, now - PENDING_RETRY_MS)) {
    const row = await readPost(g, id);
    if (!row) continue;
    if (row.pendingSince !== undefined && now - row.pendingSince > PENDING_GIVE_UP_MS) {
      const words = `${row.platform === "instagram" ? "Instagram" : "The platform"} kept preparing it for more than half an hour, so it was not posted. Nothing was posted. Tap Try again.`;
      await writePost(g, id, row.title, { status: "failed", failure: words, retryable: true, maybePosted: false, pendingSince: null }, now);
      await done(id, { outcome: { status: "failed", result: words, produced: [id] }, post: await readPost(g, id) });
      continue;
    }
    const r = await runJob(g, id, env, { from: ["publishing"], now });
    // still preparing: no news yet, nothing to tell the owner
    if (r.post?.status === "publishing") continue;
    await done(id, r);
  }

  // their time has come
  for (const id of await dueIds(g, now)) await done(id, await runJob(g, id, env, { from: ["scheduled"], now }));
  return out;
}

/** Starts the clock. Returns a function that stops it. */
export function startPublishSchedule(d: ScheduleDeps): () => void {
  const now = d.now ?? (() => Date.now());
  const log = d.log ?? (() => undefined);
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // a slow look is never doubled up
    running = true;
    try {
      for (const t of await d.tenants()) {
        try {
          const env = d.env(t.slug);
          if (!env) continue;
          if (d.hasPostingConnection && !(await d.hasPostingConnection(t.slug))) continue;
          const results = await runDue(t.slug, await d.openGraph(t.slug), env, now());
          for (const r of results) {
            log(`[publish] ${t.slug}: ${r.post?.platform ?? "post"} ${r.id} ${r.outcome.status}`);
            try { await d.onResult?.(r); } catch (e) { log(`[publish] ${t.slug}: could not tell the owner about ${r.id}: ${message(e)}`); }
          }
        } catch (e) {
          log(`[publish] ${t.slug}: ${message(e)}`);
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), d.intervalMs ?? 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

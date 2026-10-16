// A new card reaches the business's #approvals within seconds, not at the next minute sync: when an Approval node is created
// in a business's graph (in this process), that business's cards are posted after a short pause (the card's links and text are
// written a moment after the node). Whatever was already posted is skipped, and two processes never post for one business at
// once (the store's sync lock), so this is only ever faster than the minute sync, never different.
import { onApprovalCreated, tenantOfGraph } from "../graph/approval-hook.js";
import type { TenantSource } from "./hub-provision.js";
import { syncArea, type ProvisionDeps } from "./hub-provision.js";


export interface NudgeOpts {
  deps: Pick<ProvisionDeps, "hub" | "store" | "now" | "log">;
  source: (slug: string) => Promise<TenantSource>;
  log?: (line: string) => void;
  delayMs?: number;
  /** Called after each sync (for tests). */
  done?: (slug: string, result: Awaited<ReturnType<typeof syncArea>> | Error) => void;
}

export function startApprovalNudge(o: NudgeOpts): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const log = o.log ?? (() => undefined);
  const stop = onApprovalCreated((graphName) => {
    const slug = tenantOfGraph(graphName);
    if (!slug || timers.has(slug)) return; // one pending sync per business covers every card made meanwhile
    const t = setTimeout(async () => {
      timers.delete(slug);
      try {
        const r = await syncArea(slug, o.deps, await o.source(slug));
        o.done?.(slug, r);
      } catch (e) {
        log(`[hub] ${slug}: could not post the new card right away (the minute sync will): ${e instanceof Error ? e.message : String(e)}`);
        o.done?.(slug, e instanceof Error ? e : new Error(String(e)));
      }
    }, o.delayMs ?? 2500);
    t.unref?.();
    timers.set(slug, t);
  });
  return () => { stop(); for (const t of timers.values()) clearTimeout(t); timers.clear(); };
}

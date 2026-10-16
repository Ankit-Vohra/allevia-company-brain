// "A new card is waiting for the owner's OK": one in-process signal, so the Discord hub can post it within seconds instead
// of at its next minute sync. The graph layer only says which graph got a new Approval node; it knows nothing of Discord.
// Listeners must never throw into a write (they are called inside it, and their errors are swallowed here).
type Listener = (graphName: string) => void;

const listeners = new Set<Listener>();

export function onApprovalCreated(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function approvalCreated(graphName: string): void {
  for (const fn of listeners) {
    try { fn(graphName); } catch { /* a listener's failure is never the write's */ }
  }
}

/** The business slug behind a tenant graph name ("allevia_aamdani" -> "aamdani"); null for any other graph. */
export function tenantOfGraph(graphName: string): string | null {
  const m = /^allevia_(.+)$/.exec(graphName);
  return m && m[1] !== "meta" ? m[1]! : null;
}

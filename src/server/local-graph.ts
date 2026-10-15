// Small in-memory graph algorithms for the overview map (at most a few hundred nodes): PageRank for size and label
// propagation for topic colours, used only when the graph has no stored `rank` / `community` yet (the librarian writes
// those). Pure and deterministic, so the same graph always draws the same way.

export interface LocalEdge { from: string; to: string }

// PageRank on the undirected view (a map reads better when a node's weight counts links both ways), scaled so the top
// node is 1.
export function localPageRank(ids: string[], edges: LocalEdge[], iterations = 30, damping = 0.85): Map<string, number> {
  const n = ids.length;
  const out = new Map<string, number>();
  if (!n) return out;
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (e.from === e.to || !adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  let rank = new Map<string, number>(ids.map((id) => [id, 1 / n]));
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>(ids.map((id) => [id, (1 - damping) / n]));
    let dangling = 0;
    for (const id of ids) {
      const r = rank.get(id)!;
      const nb = adj.get(id)!;
      if (!nb.length) { dangling += r; continue; }
      for (const m of nb) next.set(m, next.get(m)! + (damping * r) / nb.length);
    }
    for (const id of ids) next.set(id, next.get(id)! + (damping * dangling) / n);
    rank = next;
  }
  const max = Math.max(...rank.values()) || 1;
  for (const [id, r] of rank) out.set(id, Math.round((r / max) * 1000) / 1000);
  return out;
}

// Label propagation: every node starts in its own community and takes the most common label among itself and its
// neighbours, visiting nodes in id order; a tie keeps the current label when it is among the leaders, else goes to the
// smallest. A neighbour's vote weighs 1 + the neighbours the two share, so edges inside a cluster outvote a lone bridge
// between two clusters. Community ids are renumbered 0.. by size, largest first.
export function localCommunities(ids: string[], edges: LocalEdge[], rounds = 12): Map<string, number> {
  const sorted = [...new Set(ids)].sort();
  const adj = new Map<string, Set<string>>(sorted.map((id) => [id, new Set<string>()]));
  for (const e of edges) {
    if (e.from === e.to || !adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.add(e.to);
    adj.get(e.to)!.add(e.from);
  }
  const weight = new Map<string, number>();
  const w = (a: string, b: string): number => {
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    let v = weight.get(key);
    if (v === undefined) {
      const [small, big] = adj.get(a)!.size < adj.get(b)!.size ? [adj.get(a)!, adj.get(b)!] : [adj.get(b)!, adj.get(a)!];
      v = 1;
      for (const x of small) if (big.has(x)) v++;
      weight.set(key, v);
    }
    return v;
  };
  const label = new Map<string, number>(sorted.map((id, i) => [id, i]));
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (const id of sorted) {
      const nb = adj.get(id)!;
      if (!nb.size) continue;
      const own = label.get(id)!;
      const tally = new Map<number, number>();
      for (const m of nb) tally.set(label.get(m)!, (tally.get(label.get(m)!) ?? 0) + w(id, m));
      const top = Math.max(...tally.values());
      const leaders = [...tally].filter(([, c]) => c === top).map(([l]) => l);
      const best = leaders.includes(own) ? own : Math.min(...leaders);
      if (best !== own) { label.set(id, best); moved = true; }
    }
    if (!moved) break;
  }
  const size = new Map<number, number>();
  for (const l of label.values()) size.set(l, (size.get(l) ?? 0) + 1);
  const order = [...size.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([l]) => l);
  const renumber = new Map(order.map((l, i) => [l, i]));
  return new Map([...label].map(([id, l]) => [id, renumber.get(l)!]));
}

// A word-level diff for showing the owner's edit: what was cut, what was added. LCS over tokens (words and the spaces
// between them), capped so a long draft stays cheap; past the cap it shows the whole before and after.

export type DiffPart = { kind: "same" | "del" | "ins"; text: string };

const tokens = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

export function wordDiff(a: string, b: string, cap = 600): DiffPart[] {
  const x = tokens(a), y = tokens(b);
  if (x.length * y.length > cap * cap) return [{ kind: "del", text: a }, { kind: "ins", text: b }];
  const n = x.length, m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push("same", x[i]!); i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) push("del", x[i++]!);
    else push("ins", y[j++]!);
  }
  while (i < n) push("del", x[i++]!);
  while (j < m) push("ins", y[j++]!);
  // a change that is only whitespace reads as unchanged
  return out.map((p) => (p.kind !== "same" && !p.text.trim() ? { ...p, kind: "same" as const } : p));
}

/** Only the changed stretches, each with a few words of context either side: for a long draft with a small edit. */
export function diffExcerpt(parts: DiffPart[], context = 6): DiffPart[] {
  const out: DiffPart[] = [];
  parts.forEach((p, i) => {
    if (p.kind !== "same") { out.push(p); return; }
    const words = p.text.split(/(\s+)/);
    const first = i === 0, last = i === parts.length - 1;
    const keep = context * 2;
    if (words.length <= keep * 2 + 1) { out.push(p); return; }
    const head = first ? "" : words.slice(0, keep).join("");
    const tail = last ? "" : words.slice(-keep).join("");
    out.push({ kind: "same", text: `${head}${head || tail ? " … " : "…"}${tail}` });
  });
  return out;
}

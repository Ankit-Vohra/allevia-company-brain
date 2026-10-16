// Small, forgiving readers for what a Composio action hands back. Composio wraps each provider's own answer, and the wrapping
// differs from action to action (data.id, data.response_data.post_id, data.response_dict.author_id ...), so a value is looked
// for by name, a few levels down, instead of at one fixed path. Nothing here ever returns a whole response: only the one
// string asked for, so a token that happens to sit in an answer (the Facebook Pages list carries one per Page) is never kept.

const MAX_DEPTH = 6;

/** The first non-empty string (or number, as a string) under any of `keys`, searching breadth-first so the nearest wins. */
export function deepStr(v: unknown, keys: readonly string[]): string {
  let level: unknown[] = [v];
  for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
    const next: unknown[] = [];
    for (const x of level) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      for (const k of keys) {
        const val = o[k];
        if (typeof val === "string" && val.trim()) return val.trim();
        if (typeof val === "number" && Number.isFinite(val)) return String(val);
      }
      for (const child of Array.isArray(x) ? x : Object.values(o)) next.push(child);
    }
    level = next;
  }
  return "";
}

/** The first array found under `key`, searching breadth-first. */
export function deepArr(v: unknown, key: string): unknown[] {
  let level: unknown[] = [v];
  for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
    const next: unknown[] = [];
    for (const x of level) {
      if (Array.isArray(x)) { next.push(...x); continue; }
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      if (Array.isArray(o[key])) return o[key] as unknown[];
      next.push(...Object.values(o));
    }
    level = next;
  }
  return [];
}

export const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

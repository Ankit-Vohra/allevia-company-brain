// Folding repeats in a list, for the owner's eyes only: the same idea drafted on three mornings shows as one row with "×3",
// and anything older than a week sits under one "Older" row. Nothing is decided or removed: the newest of a group is the one
// acted on, and the rest stay one tap away. Used by Home, Needs your OK, Ideas and the chat's conversation list
// (tests/web/group.test.ts). No React and no DOM.

export interface Group<T> {
  /** The newest of the group: the one shown and acted on. */
  lead: T;
  /** Every member, newest first (lead included). */
  items: T[];
}

export interface GroupBy<T> {
  /** What the item is about, when it says (an idea's slug); items with matching subjects are one group. */
  subject?: (t: T) => string | undefined;
  title: (t: T) => string;
  /** ISO time; the newest becomes the lead. */
  at: (t: T) => string;
}

/**
 * The subject an idea or a draft is about, from its recommendation id: "recommendation:standup-finding-funnel-…-d2453f-20261016"
 * and "recommendation:insight-funnel-…-0b6da1" are the same finding found on two days. The source prefix, the short hash and
 * the date come off; the stand-up's copy of the slug is cut short, so two subjects match when one starts with the other.
 */
export function subjectOf(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const s = id
    .replace(/^(recommendation|approval):/, "")
    .replace(/^(insight|standup-finding|standup)-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-[0-9a-f]{6}$/, "");
  return s.length >= 12 ? s : undefined;
}

const sameSubject = (a: string, b: string) => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 20 ? long.startsWith(short) : a === b;
};

const STOP = new Set(["a", "an", "the", "for", "to", "of", "on", "in", "at", "and", "or", "with", "your", "our", "post", "draft", "message", "follow", "up", "follow-up"]);
/** The words that carry a title, lower-cased: "A follow-up message: Seekers signup funnel: 80% drop…" keeps seekers, signup, funnel, 80%, drop. */
export function titleWords(s: string): string[] {
  return s.toLowerCase().replace(/\((?:simulated|sample numbers)\)/g, " ").replace(/[^\p{L}\p{N}%.\s-]/gu, " ").split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, "")).filter((w) => w && !STOP.has(w));
}

/** Two titles say the same thing: the same words, or every word of the shorter (three or more) inside the longer. */
export function nearSameTitle(a: string, b: string): boolean {
  const x = titleWords(a), y = titleWords(b);
  if (!x.length || !y.length) return false;
  if (x.join(" ") === y.join(" ")) return true;
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.length >= 3 && short.every((w) => long.has(w));
}

/**
 * The list with repeats folded. A group sits where its first member stood in the list (so a list ranked "big ones first"
 * keeps its order), and leads with its newest member.
 */
export function groupSimilar<T>(list: readonly T[], by: GroupBy<T>): Group<T>[] {
  const n = list.length;
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (i: number, j: number) => { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  const subj = list.map((t) => by.subject?.(t));
  const titles = list.map((t) => by.title(t));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const si = subj[i], sj = subj[j];
      if ((si && sj && sameSubject(si, sj)) || nearSameTitle(titles[i]!, titles[j]!)) join(i, j);
    }
  }
  const groups = new Map<number, T[]>();
  list.forEach((t, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), t]); });
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, items]) => {
      const sorted = [...items].sort((p, q) => by.at(q).localeCompare(by.at(p)));
      return { lead: sorted[0]!, items: sorted };
    });
}

/** The groups from the last `days` days, and the older ones (by their newest member) for one folded "Older (N)" row. */
export function splitOlder<T>(groups: readonly Group<T>[], at: (t: T) => string, now = new Date(), days = 7): { recent: Group<T>[]; older: Group<T>[] } {
  const cut = now.getTime() - days * 86_400_000;
  const recent: Group<T>[] = [], older: Group<T>[] = [];
  for (const g of groups) {
    const t = Date.parse(at(g.lead));
    (Number.isFinite(t) && t < cut ? older : recent).push(g);
  }
  return { recent, older };
}

// ---------------------------------------------------------------- the shapes the app folds

interface DraftShape { id: string; title: string; createdAt: string; recommendationId?: string }

/** Drafts waiting for the owner, folded: the same finding drafted on several mornings is one row. */
export const groupDrafts = <A extends DraftShape>(list: readonly A[]): Group<A>[] =>
  groupSimilar(list, { subject: (a) => subjectOf(a.recommendationId), title: (a) => a.title, at: (a) => a.createdAt });

/** How many rows the owner sees for these drafts: the one count shown in the top bar, on Home and on Needs your OK. */
export const draftRows = <A extends DraftShape>(list: readonly A[]): number => groupDrafts(list).length;

interface IdeaShape { id: string; title: string; createdAt: string }

/** Ideas, folded the same way. */
export const groupIdeas = <R extends IdeaShape>(list: readonly R[]): Group<R>[] =>
  groupSimilar(list, { subject: (r) => subjectOf(r.id), title: (r) => r.title, at: (r) => r.createdAt });

interface ThreadShape { id: string; title: string; lastAt: string }

/** Conversations folded by the question asked: "What else breaks if the sign-up flow breaks?" four times is one row. Only the
 *  same question folds (not shared words), and the list keeps its own order (newest first from the server). */
export function groupThreads<S extends ThreadShape>(list: readonly S[]): Group<S>[] {
  const key = (s: S) => s.title.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/, "");
  const byQ = new Map<string, S[]>();
  for (const s of list) byQ.set(key(s), [...(byQ.get(key(s)) ?? []), s]);
  return [...byQ.values()].map((xs) => {
    const items = [...xs].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    return { lead: items[0]!, items };
  });
}

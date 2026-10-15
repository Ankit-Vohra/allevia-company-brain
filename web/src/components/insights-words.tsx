// Plain-words helpers shared by Insights and Approvals (docs/owner-words.md): time as words in the business's own
// time zone, and small text tidy-ups so an owner never reads "(simulated)", "[[node-id]]" or a ratio they have to decode.

const ymd = (d: Date, tz?: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const dayNumber = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y!, m! - 1, d!) / 86_400_000; };

/** "this morning", "yesterday", "last Tuesday", "on 3 Oct": read on the business's own clock, never the viewer's. */
export function whenWords(iso: string | undefined, tz?: string, locale = "en-GB", now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  let zone = tz;
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); } catch { zone = undefined; }
  const diff = dayNumber(ymd(now, zone)) - dayNumber(ymd(d, zone));
  if (diff <= 0) {
    const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(d));
    return h < 12 ? "this morning" : h < 17 ? "this afternoon" : "this evening";
  }
  if (diff === 1) return "yesterday";
  if (diff < 7) return `last ${new Intl.DateTimeFormat("en", { timeZone: zone, weekday: "long" }).format(d)}`;
  let loc = locale;
  try { Intl.getCanonicalLocales(loc); } catch { loc = "en-GB"; }
  return `on ${new Intl.DateTimeFormat(loc, { timeZone: zone, day: "numeric", month: "short" }).format(d)}`;
}

/** Drops [[node-id]] citations (they live behind "Why we think this") and the space before them. */
export const withoutCites = (md: string) => md.replace(/\s*\[\[[^\]\n]+\]\]/g, "").replace(/\s+([.,;:])/g, "$1");

/** Sample numbers are shown as a tag, so the words "(simulated)" come out of titles and impact lines. */
export const withoutSim = (s: string) => s.replace(/\s*\((?:simulated|sample numbers)\)/gi, "").replace(/\s+/g, " ").trim();

/** The first sentence only: the one-line "why" on a card. */
export function firstSentence(s: string) {
  const m = s.trim().match(/^[\s\S]*?[.!?](?=\s+[A-Z]|$)/);
  return (m ? m[0] : s).trim();
}

/** A quiet word instead of a percentage or a meter. */
export const likelihood = (c: number) => (c >= 0.8 ? "Very likely to help" : c >= 0.65 ? "Likely to help" : c >= 0.5 ? "Worth trying" : "An early guess");

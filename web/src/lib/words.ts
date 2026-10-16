// Plain words for owners: the team's own working lines (written for the graph's sake) read without its vocabulary.
// Anything technical belongs behind a "Show how" expander, never on a default view.
const MAP: [RegExp, string][] = [
  [/\bagainst the graph\b/gi, "against your records"],
  [/\bin the graph\b/gi, "in your records"],
  [/\bthe graph\b/gi, "your records"],
  [/\bgraph\b/gi, "records"],
  [/\bnodes?\b/gi, "facts"],
  [/\bcitations?\b/gi, "sources"],
  [/\bfindings?\b/gi, "notes"],
  [/\bapproval cards?\b/gi, "drafts waiting for your OK"],
  [/\bpending approvals?\b/gi, "drafts waiting for your OK"],
  [/\bbaseline\b/gi, "starting point"],
  [/\bsimulated\b/gi, "sample"],
];

export const plain = (s: string) => MAP.reduce((t, [re, to]) => t.replace(re, to), s);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-10-07" read as "7 Oct" (the year only when it is not this year), outside the [[source]] markers, whose ids hold
 * dates that must stay as they are. Owners read days as words (docs/owner-words.md), never as a machine date.
 */
export function humanDates(s: string, now: Date = new Date()): string {
  return s.split(/(\[\[[^\]]*\]\])/).map((part) => part.startsWith("[[") ? part : part.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => {
    const month = MONTHS[Number(mo) - 1];
    if (!month || Number(d) < 1 || Number(d) > 31) return m;
    return `${Number(d)} ${month}${Number(y) === now.getFullYear() ? "" : ` ${y}`}`;
  })).join("");
}

// The lines of a call: what lets the brain say "this action came from this line". The notes or transcript are split into their
// non-empty lines, numbered from 1; each becomes a Chunk of the transcript Document (src/agent/meeting.ts):
//   transcript -HAS_CHUNK-> line          line -MENTIONS-> the person who said it
//   Decision -BASED_ON-> line             line -MENTIONS-> Decision | Task
// Memory Keeper reads the notes with the numbers in front ("18| Aman Shetty: ...") and says which lines each decision and task
// came from; when it does not (or names a line that is not there), the line sharing the most words with the item is taken.

export interface CallLine { ord: number; text: string; speaker?: string }

const MAX_LINES = 400;
const SPEAKER = /^([A-Z][^:\n]{0,60}?):\s+(\S.*)$/u;

/** The non-empty lines, numbered from 1, with the speaker when the line starts "Name: ". */
export function callLines(notes: string): CallLine[] {
  const out: CallLine[] = [];
  for (const raw of notes.split("\n")) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const m = SPEAKER.exec(text);
    // "On the call: ..." and "Agreed: ..." are headings, not speakers
    const speaker = m && !/^(?:on the call|agreed|present|recorded by|the recorder's \w+|attendees|date|subject|title)$/i.test(m[1]!.trim()) ? m[1]!.trim() : undefined;
    out.push({ ord: out.length + 1, text: text.slice(0, 1200), ...(speaker ? { speaker } : {}) });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

/** The notes as Memory Keeper reads them: each non-empty line with its number in front. */
export function numberedNotes(notes: string): string {
  let n = 0;
  return notes.split("\n").map((l) => (l.trim() && n < MAX_LINES ? `${++n}| ${l}` : l)).join("\n");
}

const STOP = new Set("the a an and or of to for in on at by with from is are be will we our us you your it this that as about into than then them they their send get make".split(" "));
const words = (s: string): Set<string> =>
  new Set(s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)));

/** The line that shares the most words with the item (at least two); on a tie a spoken line, then the speaker's own; null when none does. */
export function bestLine(item: string, lines: CallLine[], speaker?: string): number | null {
  const want = words(item);
  let best: { ord: number; score: number } | null = null;
  for (const l of lines) {
    let score = 0;
    for (const w of words(l.text)) if (want.has(w)) score++;
    if (score && l.speaker) score += 0.25; // a line someone said beats a heading or the recorder's own summary
    if (speaker && l.speaker && l.speaker.toLowerCase().startsWith(speaker.toLowerCase().split(/\s+/)[0]!)) score += 0.5;
    if (score >= 2 && (!best || score > best.score)) best = { ord: l.ord, score };
  }
  return best?.ord ?? null;
}

/** The lines an item came from: the ones Memory Keeper named that exist (at most three), else the best match. */
export function linesFor(item: { text: string; lines?: number[] }, lines: CallLine[], speaker?: string): number[] {
  const have = new Set(lines.map((l) => l.ord));
  const named = [...new Set((item.lines ?? []).filter((n) => Number.isInteger(n) && have.has(n)))].slice(0, 3);
  if (named.length) return named;
  const b = bestLine(item.text, lines, speaker);
  return b === null ? [] : [b];
}

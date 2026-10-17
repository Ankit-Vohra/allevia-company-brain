// How Allevia writes to the owner: the i-have-adhd answer shape (vendor/skills/i-have-adhd, MIT) in the owner's plain
// words (docs/owner-words.md). Shared by the Chief's answer prompts, the desks' house rules and the morning brief
// ("Today's note"), so one change here reaches every text the owner reads.
//
// The owner is a working founder, not technical, reading on a phone for two minutes. So: the answer and the one next
// action come first, steps are numbered, lists stop at five and are ranked, and none of the machinery's words appear.

/** Words the owner must never read (docs/owner-words.md "Words" table), as a pattern; ownerJargon() lists the hits. */
const JARGON: Array<[label: string, re: RegExp]> = [
  ["baseline", /\bbaselines?\b/i],
  ["Day 0", /\bday[- ]?0\b/i],
  ["first-pass", /\bfirst[- ]pass\b/i],
  ["capability", /\bcapabilit(?:y|ies)\b/i],
  ["approval card", /\bapproval cards?\b/i],
  ["approval", /\bapprovals?\b/i],
  ["finding", /\bfindings?\b/i],
  ["detector", /\bdetectors?\b/i],
  ["agent", /\bagents?\b/i],
  ["desk", /\bdesks?\b/i],
  ["orchestrator", /\borchestrat(?:or|ors|ion)\b/i],
  ["synthesis", /\bsynthesis\b/i],
  ["citation", /\bcitations?\b/i],
  ["provenance", /\bprovenance\b/i],
  ["graph", /\b(?:knowledge )?graph\b/i],
  ["node", /\bnodes?\b/i],
  ["recommendation", /\brecommendations?\b/i],
  ["insight", /\binsights?\b/i],
  ["deliverable", /\bdeliverables?\b/i],
  ["simulated", /\bsimulated\b/i],
  ["learned rule", /\blearned rules?\b/i],
  ["access mode", /\baccess modes?\b/i],
  ["on track / at risk / off track", /\b(?:on|off) track\b|\bat risk\b/i],
  ["morning brief", /\bmorning brief\b/i],
];

/** The jargon in a text the owner will read (ids in [[double brackets]] are not text, so they are skipped). */
export function ownerJargon(text: string): string[] {
  const prose = text.replace(/\[\[[^\]]*\]\]/g, " ");
  return JARGON.filter(([, re]) => re.test(prose)).map(([label]) => label);
}

/** The plain-words rule, as the prompts state it. */
export const OWNER_WORDS_RULE = `Plain words. The owner runs a business, is not technical, and reads this on a phone between jobs:
- Never write these words: baseline, Day 0, first-pass, capability, approval card, finding, detector, agent, desk, orchestrator, synthesis, citation, provenance, graph, node, recommendation, insight, deliverable, on track / at risk / off track.
- Write instead: "where you started" (not baseline), "monthly check-in", "waiting for your OK", "what we noticed" or "an idea", "your team", people by name and job ("Miss Influencer, content"; "Firefighter, on call"), "how we know" (sources), "going well / needs a push / behind", "drafts you approved as they were", "things your team learned from your edits", "today's note" (not morning brief).
- Numbers that are samples are called "sample numbers", next to the number, every time.
- Short words, short sentences. Explain a term once in plain words, or leave it out.`;

/** The answer's shape: the i-have-adhd rules (lead with the action, numbered steps, five at most, one next action). */
export const ANSWER_SHAPE = `Shape the answer so a busy reader can act on it (the i-have-adhd rules):
- First line: the answer, or the one thing to do. No preamble ("Great question", "Let me", "Looking at"), no recap of the question.
- More than one step: a numbered list, one small action per step, the fewest steps that work.
- Lists: at most 5 items per group, most important first. Keep the rest back; they are the next items, not lost.
- Give real time estimates ("about 10 minutes", "an afternoon"), never "a bit of work".
- Say what is already done or going well, in concrete terms ("Enquiries are up this week: 41, from 33"), not buried at the end.
- Errors and gaps: say what happened and what to do, flat ("Instagram isn't connected, so reach is not recorded. Connect it in Settings."). No "uh oh", no "there seems to be a problem".
- Citations show as small numbers after a clause, so a [[id]] never stands in for a noun: name the thing in words, then put the citation after it. Wrong: "I made one option, [[asset:…]], waiting on approval [[approval:…]]." Right: "I made one poster option, waiting for your OK. [[asset:…]] [[approval:…]]"
- The last line is ONE next action the owner can take in under two minutes. No closer ("let me know", "hope this helps"), no second summary.`;

/** What a desk's own write-up looks like: concise, complete, ranked, and every item whole. */
export const DESK_SHAPE = `Write it so it can be used as is: the finding first, then at most 5 supporting points, most important first, each a whole sentence. If you run out of room, drop the lowest-ranked point; never stop in the middle of one. Plain words (no "baseline", "Day 0", "agent", "desk", "graph", "node"), and name sample numbers as "sample numbers".`;

/**
 * What the content desk writes (content trial 2026-10-15): the post itself, in finished words, not a plan for one. Posts and
 * reels are the one deliverable that is the text; a summary of it cannot be posted.
 */
export const CONTENT_SHAPE = `You write the copy itself, not a summary of it. The owner must be able to paste what you write.
- Each caption is finished text: the first line is the hook (use a hook formula the playbook lists for this channel), then two or three short, plain sentences from what the record says, then a closing line only if the brand's rules allow one. Never a label ("Project, place, year."): a caption a person would not say out loud is not done.
- Write each caption in the language the brand posts in (see its voice rules and audience), even when the owner asked in another language. Your notes to the owner stay in the owner's language.
- A reel script is whole: timed beats from the first second to the last, the words said or shown on screen in each, and what to film. Say what to film as a direction ("Film: the shelves by the window, if you have them"), never as a fact about the business.
- Every fact (names, places, years, numbers, materials, awards, results) must come from a tool result you cite. Where the record does not hold a detail the post needs, never leave an empty prompt: write a sensible suggestion in that spot, built from the business's own profile (what it does, who it serves, its place, its voice), clearly marked as "[suggested: the suggestion itself]". A suggestion is a proposal for the owner to accept, so keep it modest and plain, never a number, award, price, date, result or named person. Use "[you tell us: …]" only for a hard fact nobody can sensibly suggest (an exact price, a date, a name). Don't drop the whole caption or scene because one detail is missing.
- Open with two lines: "Made for: <the main goal> · CTA: <its call to action>" and "Built from: <the past posts, edit rules and decisions you used, each cited>" (or "Built from: no post numbers on record yet, so the main goal, the brand's voice and rivals' posts"). Every caption and script closes with that one call to action, by the route the business really has.
- Give the whole deliverable in the text, in order (day by day, scene by scene), as the owner would post it. The five-point limit does not apply: a week is seven posts, in date order.`;

/**
 * Cut a write-up to at most `max` characters without ending in the middle of an item: at the last whole line (a bullet
 * or a numbered step), else the last whole sentence, else the last whole word with an ellipsis. The ellipsis is only
 * ever added when a single item is itself longer than `max`.
 */
export function clipToItem(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const whole = (s: string): string => {
    const open = s.lastIndexOf("[[");
    return open > s.lastIndexOf("]]") ? s.slice(0, open).trimEnd() : s; // never end inside a [[source]] tag
  };
  const nl = head.lastIndexOf("\n");
  if (t[max] === "\n") return whole(head).trimEnd(); // the cut falls exactly between two lines
  if (nl > 0 && nl >= max * 0.3) return whole(head.slice(0, nl)).trimEnd();
  const ends = [...head.matchAll(/[.!?]["')\]]*(?=\s|$)/g)].at(-1);
  if (ends && ends.index! + ends[0].length >= max * 0.3) return whole(head.slice(0, ends.index! + ends[0].length)).trimEnd();
  const space = head.lastIndexOf(" ");
  const cut = whole(space > 0 ? head.slice(0, space) : head.slice(0, max - 1)).trimEnd().replace(/[,;:\-–—(]$/, "");
  return `${cut}…`;
}

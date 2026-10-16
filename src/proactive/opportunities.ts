// From what changed to what is worth doing: each signal that could become something the owner would use today is turned
// into an Opportunity, with a one-line reason built only from the graph's numbers, the person on the team who owns it,
// the kind of thing they will draft, and the skill they draft it with. Fixed rules, no model: Meera (choose.ts) picks from
// these, so a reason can never carry a number that is not in the graph.
//
// The kinds the team drafts (each waits for the owner's OK; nothing is posted without it):
//   post         a social post (Tara, content)
//   poster       a post with a poster made by the creating tools (Tara); a paid picture only within the day's budget
//   reply        a reply to a customer review (Vikram, operations)
//   website_fix  a fix for the website with the new words already written (Arjun, tech)
//   follow_up    a follow-up message to people who stopped part way, or who went quiet (Vikram)
//   offer        an offer idea with its wording, to test (Rohan, marketing)
import { CONTENT_METRIC, FUNNEL_METRIC, SEO_METRIC } from "./words.js";
import { whenWords } from "./calendar.js";
import type { Signals } from "./signals.js";
import { cap1, clip, fmt, humanise, oneLine, pct, plural } from "../insights/text.js";

export const OPPORTUNITY_KINDS = ["post", "poster", "reply", "website_fix", "follow_up", "offer"] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

export type OpportunitySource = "season" | "review" | "website" | "goal" | "numbers" | "finding" | "competitor";

export interface Opportunity {
  key: string;                 // stable across days: the same opportunity tomorrow has the same key (dedupe)
  kind: OpportunityKind;
  source: OpportunitySource;
  agent: string;               // roster id of who drafts it
  title: string;               // what will be drafted, in the owner's words: "A Dussehra post"
  reason: string;              // one line, every number from the graph: "Dussehra is in 4 days."
  brief: string;               // the default purpose-first brief (Meera may sharpen it)
  facts: string[];             // what the drafter may use, besides the business's own record
  skill: { agent: string; id: string };
  evidence: string[];          // graph ids behind it
  goals: string[];             // goal ids it moves
  score: number;               // 0..1
  occasion?: { name: string; date: string; approx?: boolean };
}

const AGENT: Record<OpportunityKind, string> = {
  post: "content-strategist", poster: "content-strategist", reply: "ops-manager", website_fix: "tech-lead", follow_up: "ops-manager", offer: "growth-marketer",
};
const SKILL: Record<OpportunityKind, { agent: string; id: string }> = {
  post: { agent: "content-strategist", id: "instagram-post" },
  poster: { agent: "content-strategist", id: "instagram-post" },
  reply: { agent: "ops-manager", id: "follow-up-drafts" },
  website_fix: { agent: "tech-lead", id: "fix-ticket" },
  follow_up: { agent: "ops-manager", id: "follow-up-drafts" },
  offer: { agent: "growth-marketer", id: "offer-test-plan" },
};

const clamp = (x: number) => Math.max(0, Math.min(1, Math.round(x * 100) / 100));
const mk = (o: Omit<Opportunity, "agent" | "skill" | "goals"> & { goals?: string[]; agent?: string }): Opportunity =>
  ({ ...o, agent: o.agent ?? AGENT[o.kind], skill: SKILL[o.kind], goals: o.goals ?? [], score: clamp(o.score), reason: oneLine(o.reason) });

// Checks whose fix is a piece of writing (the team can draft the words, not just say what is wrong).
const WORDY = /title|description|meta|h1|heading|alt|open-graph|og-|thin|content|cta/i;

export function opportunitiesFrom(s: Signals): Opportunity[] {
  const out: Opportunity[] = [];
  const biz = s.business;
  const where = biz.city ? ` in ${biz.city}` : "";
  const industry = (biz.industry ?? "").toLowerCase();

  // ---- seasons and festivals ----
  for (const d of s.dates) {
    if (!d.ongoing && (d.inDays < 2 || d.inDays > 28)) continue;
    const suits = !d.suits?.length || (!!industry && d.suits.some((x) => industry.includes(x)));
    const near = d.ongoing ? 0.6 : 1 - Math.abs(d.inDays - 10) / 18;
    const kind: OpportunityKind = d.kind === "shopping" ? "offer" : d.kind === "season" ? "post" : "poster";
    const title = kind === "offer" ? `An offer idea for ${d.name}` : kind === "poster" ? `A ${d.name} post with a poster` : `A post for ${d.name}`;
    out.push(mk({
      key: `season:${d.key}`, kind, source: "season", title,
      reason: d.ongoing ? `${cap1(d.name)} is on now.` : `${cap1(d.name)} is ${whenWords(d)}${d.approx ? ` (around ${d.date})` : ""}.`,
      brief: kind === "offer"
        ? `${cap1(d.name)} is ${whenWords(d)}. Purpose: give people a reason to choose ${biz.name} that week. Draft one simple offer to test, with its wording, who it is for and how we will know it worked.`
        : `${cap1(d.name)} is ${whenWords(d)}. Purpose: be in front of people${where} when they think about ${d.name}, in ${biz.name}'s own voice, without a hard sell. Draft the post${kind === "poster" ? " and a poster headline" : ""}.`,
      facts: [`${cap1(d.name)}: ${d.date}${d.approx ? " (expected; moon-calendar date)" : ""}`],
      evidence: [], score: (suits ? 0.5 : 0.3) + 0.3 * Math.max(0, near),
      occasion: { name: d.name, date: d.date, ...(d.approx ? { approx: true } : {}) },
    }));
  }

  // ---- reviews with no reply ----
  for (const r of s.reviews) {
    const stars = typeof r.stars === "number" ? r.stars : null;
    out.push(mk({
      key: `review:${r.id}`, kind: "reply", source: "review", title: `A reply to ${r.author ? `${r.author}'s` : "a"} ${stars !== null ? `${stars}-star ` : ""}Google review`,
      reason: `${r.author ?? "A customer"} left ${stars !== null ? plural(stars, "star") : "a review"} on Google${r.publishedAt ? ` on ${r.publishedAt.slice(0, 10)}` : ""} and has no reply yet.`,
      brief: `Purpose: show everyone who reads the reviews that ${biz.name} listens. Draft a short, warm reply to this review${stars !== null && stars <= 3 ? " that owns the problem and offers to put it right" : " that thanks them by name"}. Review: ${JSON.stringify(clip(r.text, 500))}`,
      facts: [`Review text: ${clip(r.text, 500)}`], evidence: [r.id], score: stars !== null && stars <= 3 ? 0.8 : 0.5,
    }));
  }

  // ---- the website check-up ----
  for (const f of s.website.fails.filter((x) => WORDY.test(`${x.issueType ?? ""} ${x.name}`)).slice(0, 3)) {
    const sev = f.severity === "critical" ? 0.65 : f.severity === "warning" ? 0.5 : 0.38;
    const name = f.name.replace(/^SEO check:\s*/i, "");
    out.push(mk({
      key: `website:${f.ruleId}`, kind: "website_fix", source: "website", title: `New words for the website: ${name.toLowerCase()}`,
      reason: `The website check-up found "${name}" on ${plural(f.pages, "page")}${f.newPages ? `, ${fmt(f.newPages)} of them new since the last look` : ""}.`,
      brief: `Purpose: make the page easier to find and to understand. Write the new text that fixes "${name}" on ${f.pageName ?? f.pageUrl ?? "the page"}, ready to paste in, and say where it goes.${f.fix ? ` How to fix: ${clip(f.fix, 300)}` : ""}`,
      facts: [...(f.pageName ? [`Page: ${f.pageName}`] : []), ...(f.pageUrl ? [`Address: ${f.pageUrl}`] : []), ...(f.evidence ? [`Found: ${clip(f.evidence, 200)}`] : [])],
      evidence: [f.ruleId, ...(f.page ? [f.page] : [])], score: sev + (f.newPages ? 0.1 : 0) + Math.min(0.1, f.pages / 100),
    }));
  }

  // ---- goals that need a push ----
  for (const gl of s.goals.filter((x) => x.status === "at_risk" || x.status === "off_track")) {
    const key = gl.metricKey ?? "";
    const kind: OpportunityKind = CONTENT_METRIC.test(key) ? "post" : FUNNEL_METRIC.test(key) ? "follow_up" : SEO_METRIC.test(key) ? "post" : "offer";
    const moved = gl.was && gl.was !== gl.status;
    const word = gl.status === "off_track" ? "behind" : "needs a push";
    const progress = gl.progress !== null && gl.elapsed !== null ? `: ${pct(Math.max(0, gl.progress), 0)} of the way there with ${pct(gl.elapsed, 0)} of the time used` : "";
    out.push(mk({
      key: `goal:${gl.id}`, kind, source: "goal", goals: [gl.id],
      title: kind === "post" ? `A post to help "${gl.name}"` : kind === "follow_up" ? `A follow-up message to help "${gl.name}"` : `An offer idea to help "${gl.name}"`,
      reason: `"${gl.name}" ${moved ? "slipped and now " : ""}${word}${progress}.`,
      brief: `Purpose: move "${gl.name}" (now ${gl.current ?? "unknown"}${gl.target !== null ? `, goal ${gl.target}` : ""}). Draft the one thing most likely to move it this week.`,
      facts: [`Goal "${gl.name}": now ${gl.current ?? "unknown"}${gl.baseline !== null ? `, started at ${gl.baseline}` : ""}${gl.target !== null ? `, goal ${gl.target}` : ""}`],
      evidence: [gl.id, ...(gl.obsId ? [gl.obsId] : [])], score: (gl.status === "off_track" ? 0.62 : 0.52) + (moved ? 0.1 : 0),
    }));
  }

  // ---- numbers that moved ----
  for (const c of s.numbers.changes) {
    const delta = (c.to - c.from) / c.from;
    if (Math.abs(delta) < 0.25) continue;
    const metric = humanise(c.metric).toLowerCase();
    if (delta > 0 && CONTENT_METRIC.test(c.metric)) {
      out.push(mk({
        key: `numbers:${c.subject}:${c.metric}`, kind: "post", source: "numbers", title: `A post that builds on ${c.name}`,
        reason: `${cap1(metric)} on ${c.name} went from ${fmt(c.from)} to ${fmt(c.to)} (up ${pct(delta, 0)}).`,
        brief: `Purpose: do more of what just worked. ${c.name} did well; draft the next post in the same spirit.`,
        facts: [`${cap1(metric)}, ${c.name}: ${fmt(c.from)} to ${fmt(c.to)}`], evidence: [c.obsId], score: 0.45 + Math.min(0.25, delta / 4),
      }));
    } else if (delta < 0 && FUNNEL_METRIC.test(c.metric)) {
      out.push(mk({
        key: `numbers:${c.subject}:${c.metric}`, kind: "follow_up", source: "numbers", title: `A follow-up message about ${metric}`,
        reason: `${cap1(metric)} fell from ${fmt(c.from)} to ${fmt(c.to)} (down ${pct(-delta, 0)}).`,
        brief: `Purpose: win back some of the people we lost this time. Draft a short follow-up message to the people who stopped part way.`,
        facts: [`${cap1(metric)}: ${fmt(c.from)} to ${fmt(c.to)}`], evidence: [c.obsId], score: 0.5 + Math.min(0.2, -delta / 3),
      }));
    }
  }

  // ---- competitors (public data) ----
  for (const c of s.competitors) {
    if (c.prev === null || c.prev === undefined || c.prev === c.value || !/ad|post|review|rating|follower/i.test(c.metric)) continue;
    const up = c.value > c.prev;
    if (!up) continue;
    out.push(mk({
      key: `competitor:${c.id}:${c.metric}`, kind: "offer", source: "competitor", title: `An answer to ${c.name}'s move`,
      reason: `${c.name}'s ${humanise(c.metric).toLowerCase()} went from ${fmt(c.prev)} to ${fmt(c.value)} (public numbers).`,
      brief: `Purpose: keep our customers choosing ${biz.name} while ${c.name} pushes. Draft one offer or message that plays to what we do better, without naming them.`,
      facts: [`${c.name}: ${humanise(c.metric).toLowerCase()} ${fmt(c.prev)} to ${fmt(c.value)} (public)`], evidence: [c.obsId], score: 0.45,
    }));
  }

  // ---- open ideas from the rule checks that nobody has drafted yet ----
  for (const f of s.findings) {
    if (f.area === "tech" || f.area === "knowledge") continue;      // on call and the library have their own place in the note
    if (f.simulated === true || /\(simulated\)/i.test(f.title)) continue; // sample numbers never lead the owner's day
    if (f.cardKind && f.cardKind !== "content_draft") continue;    // a fix or a pause is already waiting for the owner as it is
    const kind: OpportunityKind = f.area === "content" ? "post" : f.area === "funnel" ? "follow_up" : f.area === "ads" ? "offer" : "website_fix";
    out.push(mk({
      key: `finding:${f.key}`, kind, source: "finding", title: kind === "post" ? `A post: ${clip(f.title, 70)}` : kind === "follow_up" ? `A follow-up message: ${clip(f.title, 60)}` : kind === "offer" ? `An offer idea: ${clip(f.title, 60)}` : `New words for the website: ${clip(f.title, 60)}`,
      reason: clip(oneLine(f.why || f.title).split(/(?<=\.)\s/)[0] ?? f.title, 200),
      brief: `Purpose: act on what we noticed: ${clip(oneLine(f.why || f.title), 300)} Draft the actual ${kind === "post" ? "post" : kind === "follow_up" ? "message" : kind === "offer" ? "offer wording" : "text"}, ready to use.`,
      facts: [clip(oneLine(f.why), 400)].filter(Boolean), evidence: [f.id, ...f.evidence.slice(0, 5)], score: Math.min(0.75, f.score * 0.85),
    }));
  }

  // one per key, best first
  const best = new Map<string, Opportunity>();
  for (const o of out) if (!best.has(o.key) || best.get(o.key)!.score < o.score) best.set(o.key, o);
  return [...best.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

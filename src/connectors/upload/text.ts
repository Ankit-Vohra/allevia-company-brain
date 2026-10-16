// The upload as chat text, for a surface with no form (Discord): the same preview and the same result, in the owner's
// words. A Discord handler downloads the attachment, calls previewUpload (src/server/routes/numbers.ts) with its bytes,
// shows describePreview, and on "OK" calls importUpload with the preview's plan, or the plan with the owner's changes
// (applyReply turns "column C is orders" and "leave out D" into those changes). Nothing here talks to Discord.
import { guessHeader, metricByKey } from "./metrics.js";
import type { Preview, UploadPlan } from "./types.js";
import type { ImportResult } from "./import.js";

export function describePreview(p: Preview): string {
  const lines = [p.headline, ...p.sentences.map((s) => `- ${s}`)];
  if (p.feedsGoals?.length) lines.push(`This fills in: ${p.feedsGoals.map((g) => g.name).join(", ")}.`);
  if (p.columns.length) {
    lines.push("", "What I think each column is:");
    for (const c of p.columns) lines.push(`- Column ${c.letter} “${c.header}”: ${c.guess.label ?? "I'm not sure what this is"}${c.guess.label && !c.guess.sure ? " (not sure)" : ""}`);
  }
  lines.push("", p.questions.length
    ? "Tell me what is missing (for example: “column C is orders”, “leave out D”, “each row is a week”), then say OK."
    : "Say OK to add these, or tell me what to change (for example: “column C is orders”, “leave out D”).");
  return lines.join("\n");
}

// The columns again after the owner changed some ("column C is orders"): what each one will be kept as now.
export function describePlan(p: Preview, plan: UploadPlan): string {
  const lines = ["Got it. Here is what I'll keep:"];
  for (const c of p.columns) {
    const pc = plan.columns.find((x) => x.index === c.index);
    const what = !pc || pc.metric === null ? "I'm not sure what this is"
      : pc.metric === "skip" ? "left out"
      : pc.metric === "other" ? (pc.label ?? "your own name for it")
      : metricByKey(pc.metric)?.label ?? pc.metric;
    lines.push(`- Column ${c.letter} “${c.header}”: ${what}`);
  }
  if (plan.cadence && plan.cadence !== "ranges") lines.push(`Each row is a ${plan.cadence}.`);
  lines.push("", "Say OK to add these, or tell me what else to change.");
  return lines.join("\n");
}

export function describeResult(r: ImportResult): string {
  return [r.status === "imported" ? "Added." : "Nothing new to add.", ...r.sentences].join("\n");
}

// One reply from the owner applied to the plan: "column C is orders", "C = website visits", "leave out D", "skip column D",
// "each row is a week", "dates are month first". Returns the changed plan, or null when it said nothing we could use
// (the caller asks again rather than guessing).
export function applyReply(plan: UploadPlan, reply: string): UploadPlan | null {
  const t = reply.trim().toLowerCase();
  let out = plan;
  const col = (letter: string): number => [...letter.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const skip = /(?:leave out|skip|ignore|drop)\s+(?:column\s+)?([a-z]{1,2})\b/.exec(t);
  if (skip) out = { ...out, columns: out.columns.map((c) => (c.index === col(skip[1]!) ? { ...c, metric: "skip" } : c)) };
  const is = /(?:column\s+)?\b([a-z]{1,2})\b\s*(?:is|=|are|means)\s+(?:my\s+|our\s+|the\s+)?(.+)$/.exec(t);
  if (is && !skip && out.columns.some((c) => c.index === col(is[1]!))) {
    const what = is[2]!.trim();
    const metric = guessHeader(what).metric ?? "other"; // the owner's own words go through the same word list as a header
    out = { ...out, columns: out.columns.map((c) => (c.index === col(is[1]!) ? { index: c.index, metric, ...(metric === "other" ? { label: what.slice(0, 60) } : {}) } : c)) };
  }
  const row = /each row is (?:a |one )?(day|week|month)/.exec(t);
  if (row) out = { ...out, cadence: row[1] as "day" | "week" | "month" };
  if (/month (?:first|then day)|mm\/dd|american/.test(t)) out = { ...out, dateOrder: "mdy" };
  if (/day (?:first|then month)|dd\/mm|british/.test(t)) out = { ...out, dateOrder: "dmy" };
  return out === plan ? null : out;
}

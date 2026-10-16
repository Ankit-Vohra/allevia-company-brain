// The check-up in owner words: the verdict line, at most three numbers, what changed since last time, then the top five
// fixes (what to change, why, how long, which page). The full list and the technical detail are "Show how".
import type { CheckupVerdict, Fix, Scores } from "./fixes.js";

const where = (f: Fix): string => {
  if (!f.pageCount) return "the whole site";
  const shown = f.pages.slice(0, 3).map((p) => (p === "/" ? "home page" : p)).join(", ");
  return f.pageCount > 3 ? `${shown} and ${f.pageCount - 3} more` : shown;
};

export function scoreLine(s: Scores): string {
  const bits = [
    s.mobileSpeed !== undefined ? `speed on phones ${s.mobileSpeed}/100` : "",
    s.accessibility !== undefined ? `easy to use ${s.accessibility}/100` : "",
    s.googleBasics !== undefined ? `Google basics ${s.googleBasics}/100` : "",
  ].filter(Boolean);
  return bits.length ? `${bits.join(" · ")} (90+ is good).` : "";
}

export function verdictLine(v: CheckupVerdict): string {
  const losing = v.all.filter((f) => f.tier === "losing enquiries").length;
  if (!v.all.length) return "Your website is in good shape: nothing worth fixing right now.";
  if (losing) return `Your website is losing enquiries in ${losing === 1 ? "one place" : `${losing} places`}. Fix these first.`;
  return "Nothing on your website is turning customers away; these would help more people find and trust you.";
}

export function fixLines(f: Fix, i: number): string[] {
  return [
    `${i + 1}. ${f.title}`,
    `   What to change: ${f.what}`,
    `   Why: ${f.why}`,
    `   Effort: ${f.effort}, ${f.who === "you" ? "you can do it in your site editor" : "for your web person"} · Where: ${where(f)}`,
  ];
}

export function ownerReport(v: CheckupVerdict, o: { progress?: string[]; notes?: string[]; showHow?: boolean; host?: string; asOf?: string } = {}): string {
  const out: string[] = [verdictLine(v)];
  const sl = scoreLine(v.scores);
  if (sl) out.push(sl);
  if (o.progress?.length) out.push("", "Since the last check-up:", ...o.progress.map((l) => `- ${l}`));
  if (v.top.length) out.push("", "Top fixes, most enquiries first:", ...v.top.flatMap((f, i) => fixLines(f, i)));
  if (v.good.length) out.push("", `Already good: ${v.good.join(" ")}`);
  if (o.notes?.length) out.push("", ...o.notes);
  if (o.showHow) {
    out.push("", `Show how${o.host ? ` (${o.host}${o.asOf ? `, ${o.asOf}` : ""})` : ""}:`,
      "How we ranked: each problem has a base score for how directly it loses an enquiry, weighted by the page (home 1, key pages 0.8, others 0.5), plus a little for each extra page; ties go to the quicker fix.",
      "Speed numbers are Lighthouse lab tests on a simulated mid-range phone over slow 4G and on a desktop; real visitors' numbers vary.");
    for (const f of v.all) {
      out.push(`- [${f.impact}] ${f.title} (${f.tier}; ${f.effort}; ${f.pageCount ? `${f.pageCount} page${f.pageCount === 1 ? "" : "s"}` : "site-wide"}; from ${f.sources.join(", ")})`);
      for (const e of f.evidence.slice(0, 4)) out.push(`    ${e}`);
    }
  }
  return out.join("\n");
}

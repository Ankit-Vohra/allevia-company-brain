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

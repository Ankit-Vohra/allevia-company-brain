// What each tool does, in the owner's words, for the Team page ("what Tara can look at and do"). Tool names are the
// agents' own vocabulary; the owner never reads them (docs/owner-words.md).
export const PLAIN_TOOLS: Record<string, string> = {
  search: "Search your records",
  get_entity: "Open any record in full",
  neighbors: "See what is connected to something",
  find_paths: "Trace how two things are connected",
  trace_decision: "Find out why a decision was made",
  who_owns: "Find who owns something",
  who_knows: "Find who knows about a topic",
  impact_of: "See what depends on something",
  important: "Find what matters most",
  topics: "Find the main themes in your records",
  metric_trend: "Read a number over time",
  content_performance: "Compare how posts and reels did",
  seo_report: "Read how your website shows up on Google",
  ad_report: "Read how your ads are doing",
  playbook: "Look up your house rules and the team's know-how",
  history: "See how something changed over time",
  recall: "Remember earlier conversations and notes",
  cypher: "Look up one exact fact in your records",
  remember: "Keep a note you asked it to keep",
  propose_action: "Prepare something for your OK",
  show_path: "Show how it reached the answer",
  use_skill: "Open one of its skills",
};

/** The owner's words for a tool; an unknown tool reads as its name with spaces. */
export const plainTool = (name: string): string => PLAIN_TOOLS[name] ?? name.replace(/_/g, " ");

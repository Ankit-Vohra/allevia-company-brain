// Small things the Office, Home, Chat and Approvals all use. They live here so that opening Home does not load the office's
// canvas; pages/Office.tsx re-exports them, so the old imports keep working.

/** Two simple questions to start with; the owner can ask anything. */
export const SUGGESTIONS: Record<string, string[]> = {
  aamdani: ["How is the business doing this week?", "What should we post this week?"],
  "avs-atelier": ["Why don't we show up when people search 'architect in Raipur'?", "What should we fix first on the website?"],
};

/** For a business set up a moment ago: questions any owner can ask on day one. */
export const FIRST_DAY_QUESTIONS = [
  "What should we fix first on the website, and why?",
  "Who are our customers, and what do they need from us?",
];

/** Fired by Team settings and Approvals when desks or learned rules change, so the office redraws them. */
export const TEAM_CHANGED = "allevia:team-changed";

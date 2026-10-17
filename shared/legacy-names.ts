// The team's old person names, mapped to the role names they carry now (shared/roster.ts). The founder, 2026-10-17:
// "I don't like the Indian names. Let's call them techie, miss influencer and so on as per their work."
// Answers, work logs and findings saved before the rename still say "Kabir" or "Arjun". They are not rewritten in a
// business's graph; they are shown with the new names, through currentNames, wherever stored text is served.
// This file is the one place the old names may appear (tests/shared/legacy-names.test.ts holds the rest of the code to that).

import { agentById } from "./roster.js";

/** Old name -> roster id. */
export const LEGACY_NAMES: Readonly<Record<string, string>> = {
  Meera: "chief-of-staff", Isha: "coe-lead", Kabir: "data-analyst", Rohan: "growth-marketer", Tara: "content-strategist",
  Dev: "copy-editor", Nisha: "fact-checker", Arjun: "tech-lead", Zoya: "oncall-engineer", Imran: "qa-release",
  Vikram: "ops-manager", Neel: "sales-lead", Sara: "librarian",
};

// A whole word, capitalised as a name, not the first name of a full name ("Dev Rao", "Arjun Mehta" are people, not the
// team) and not a greeting in a drafted email ("Hi Arjun,"). "dev" (a branch) and "development" never match: the match
// is case-sensitive and on word boundaries.
const PATTERN = new RegExp(`(?<!\\b(?:Hi|Hello|Hey|Dear|Thanks|with) )\\b(${Object.keys(LEGACY_NAMES).join("|")})\\b(?!\\s+[A-Z][a-z])`, "g");

/** Text with every old team name replaced by the role name it carries now ("Kabir's finding" -> "Data Detective's finding"). */
export function currentNames(text: string): string;
export function currentNames(text: string | null | undefined): string | null | undefined;
export function currentNames(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  return text.replace(PATTERN, (old: string) => agentById(LEGACY_NAMES[old]!)?.name ?? old);
}

// Node types the team itself writes, whose names can hold a team name ("Kabir: Find which step of the sign-up…").
const TEAM_WRITTEN = new Set(["Finding", "Recommendation", "Turn", "Session", "Document"]);

/** A graph node's name as it is shown: our own staff by their roster name, and what the team wrote with the names of
 *  today. A business's own people, customers and places keep their names as stored. */
export function displayName(id: string, label: string, name: string): string {
  if (id.startsWith("agent:allevia-")) return agentById(id.slice("agent:allevia-".length))?.name ?? name;
  return TEAM_WRITTEN.has(label) ? currentNames(name) : name;
}

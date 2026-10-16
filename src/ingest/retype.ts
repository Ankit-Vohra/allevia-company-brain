// Typing at onboarding (issue #24): extraction calls every company a Business, so a website that names its roasters,
// its courier and the magazines that featured it gave the owner 20 "businesses" of its own (Prufrock, trials
// 2026-10-15), and its staff's first names became People. Pure rules here; src/ingest/tidy.ts writes them.
//
// Other businesses: the owner's own Business is the one business in its graph. Another one becomes
//   Supplier (SUPPLIES the business: a roaster, a courier, a host, a platform it buys from),
//   Partner (PARTNERS_WITH: a collaborator, a sister venue, press that featured it),
//   Client (CLIENT_OF: a customer company, a stockist that sells its goods, a project's commissioner),
//   Competitor (COMPETES_WITH),
// or is the owner itself under another name (its legal entity, its domain): merged into the owner's node.
// The summary extraction wrote ("what this page says it is") decides when it says so in one way only; otherwise the
// cheap model check classifies it; a business neither can place stays as it is and the quality report lists it.
//
// People: a single first name ("Sam", "Ruth") with no role and no bio is a mention, not a person anyone can act on,
// and it is personal data the graph does not need. Kept: two names or more, a role word or a bio in the summary, a
// role or title prop, or an edge that says what they do (MEMBER_OF, OWNS, DECIDED, AUTHORED).
import type { EntityType, RelType } from "../graph/schema.js";
import { FOUNDER_ID, normName } from "./resolve-names.js";
import { strongKey } from "./dedupe.js";

export const OTHER_KINDS = ["supplier", "partner", "client", "competitor"] as const;
export type OtherKind = (typeof OTHER_KINDS)[number];
export type BusinessVerdict = OtherKind | "self" | "unclear";

export const KIND_TYPE: Record<OtherKind, EntityType> = { supplier: "Supplier", partner: "Partner", client: "Client", competitor: "Competitor" };
export const KIND_REL: Record<OtherKind, RelType> = { supplier: "SUPPLIES", partner: "PARTNERS_WITH", client: "CLIENT_OF", competitor: "COMPETES_WITH" };

const CUES: Record<OtherKind, RegExp> = {
  supplier: /\b(?:suppl(?:y|ies|ied|ier|iers)|roast(?:er|ers|ery)|courier|delivery (?:service|company)|postal service|vendor|wholesaler|distributor|manufacturer|maker of the|producer|grower|farm|mill|brewery|dairy|bakery that|provider|hosting|registrar|domain (?:provider|registrar)|payment (?:provider|processor)|app store|platform (?:it|they|the business) (?:use|uses|sells|publish)|sourced? from|buys? from|beans? from|we use)\b/i,
  partner: /\b(?:partner(?:s|ship|ed)?|collaborat\w*|sister (?:venue|company|business|café|cafe|restaurant)|featured (?:in|on|by)|magazine|newspaper|journal|publication|press|podcast|interview(?:ed)?|award(?:ed)? by|sponsor\w*|affiliate)\b/i,
  client: /\b(?:client|customer company|commission(?:ed)?|project for|designed for|built for|work(?:ed)? for|stockist|stocks? (?:its|their|the business'?s?) |sells? (?:its|their) (?:products|coffee|goods)|retailer (?:of|that sells))\b/i,
  competitor: /\b(?:competitor|competes?|competing|rival)\b/i,
};

// A verdict from the summary alone, when exactly one kind of cue is there.
export function cueKind(text: string | undefined): OtherKind | undefined {
  if (!text?.trim()) return undefined;
  const hits = OTHER_KINDS.filter((k) => CUES[k].test(text));
  return hits.length === 1 ? hits[0] : undefined;
}

// The owner itself under another name: the same words as its name, its name plus a legal suffix, or its domain.
const LEGAL = /\b(?:ltd|limited|llc|inc|incorporated|gmbh|ag|sl|sa|bv|pvt|private|plc|llp|co|company|corp|corporation|group|holdings)\b/g;
export function isSelf(name: string, owner: { name: string; domain?: string }): boolean {
  const key = (s: string) => normName(s).replace(LEGAL, " ").replace(/\s+/g, " ").trim();
  const n = key(name);
  if (!n) return false;
  if (n === key(owner.name) || strongKey(n) === strongKey(key(owner.name))) return true;
  const host = owner.domain?.toLowerCase().replace(/^www\./, "");
  if (host && [host, host.split(".")[0]].some((h) => h && normName(h) === n)) return true;
  return false;
}

// ---------- people ----------

const HONORIFIC = /^(?:dr|ar|mr|mrs|ms|miss|mx|prof|chef|sir|dame|sr|sra|herr|frau)\b\.?\s*/i;
const ROLE = /\b(?:founder|co founder|cofounder|owner|proprietor|ceo|cto|coo|cfo|director|manager|head|lead|chief|chef|cook|baker|barista|roaster|dentist|doctor|surgeon|hygienist|nurse|therapist|stylist|designer|architect|engineer|developer|gardener|horticulturist|florist|principal|partner|editor|photographer|consultant|advisor|adviser|teacher|trainer|instructor|coach|curator|sommelier|maître|maitre|host|owner operator|president|secretary|treasurer|accountant|receptionist|assistant|associate|specialist|technician|practitioner|physiotherapist|optometrist|pharmacist|veterinarian|vet|lawyer|solicitor|agent|staff member|employee|team member|apprentice|intern)\b/i;
const MENTION_ONLY = /\b(?:mentioned|named|thanked|signed|quoted|greeted|says hello|a name)\b/i;
export const BIO_WORDS = 15;
export const ROLE_RELS: readonly RelType[] = ["MEMBER_OF", "OWNS", "DECIDED", "AUTHORED", "STATED"];

export interface PersonFacts { id: string; name: string; summary?: string; role?: string; title?: string; relTypes: string[] }

// Why a Person node is only a first name (and should not stay a Person), or undefined to keep it.
export function firstNameOnly(p: PersonFacts): string | undefined {
  if (p.id === FOUNDER_ID) return undefined;
  const bare = p.name.trim().replace(HONORIFIC, "").trim();
  const words = normName(bare).split(" ").filter(Boolean);
  if (words.length !== 1) return undefined;
  if (p.role?.trim() || p.title?.trim()) return undefined;
  if (p.relTypes.some((t) => (ROLE_RELS as readonly string[]).includes(t))) return undefined;
  const s = p.summary?.trim() ?? "";
  if (ROLE.test(s)) return undefined;
  if (s.split(/\s+/).filter(Boolean).length >= BIO_WORDS && !MENTION_ONLY.test(s)) return undefined;
  return "a first name alone, with no role or bio";
}

// The numbers an owner can give us in a spreadsheet, in their words, and the metric key each one is stored under. The keys
// are the contract the goals read (src/onboard/templates.ts `sources`) and the capability ladder watches
// (src/capabilities/modes.ts `observes`): a "visits" column becomes `ga4_sessions`, so the Website analytics capability
// moves to "from your uploads" and the Website visits goal can be measured.
//
// A header is matched on its words only, never silently trusted: guessHeader says how sure it is, and the preview asks
// the owner to confirm every column, with an edit.
import { NON_ADDITIVE_METRICS } from "../../program/measure.js";

export interface MetricDef {
  key: string;
  label: string;                 // what we call it to the owner
  noun: string;                  // for a sentence: "weekly enquiries", "daily visits"
  unit: string | "currency";     // "currency" takes the business's currency code
  subject: "business" | { id: string; name: string };
  additive: boolean;             // false: a level or a distinct count; days do not add up to weeks
  sure: RegExp[];                // the header is this, nothing else
  maybe: RegExp[];               // the header could be this
}

export const GOOGLE_SEARCH = { id: "channel:google-search", name: "Google Search" } as const;
export const INSTAGRAM = { id: "channel:instagram", name: "Instagram" } as const;
export const PAID_ADS = { id: "channel:paid-ads", name: "Paid ads" } as const;

const rx = (...words: string[]): RegExp[] => words.map((w) => new RegExp(`^(?:${w})$`));

export const METRICS: readonly MetricDef[] = [
  {
    key: "ga4_sessions", label: "Website visits", noun: "website visits", unit: "visits", subject: "business", additive: true,
    sure: rx("(?:website |site |web )?(?:visits?|sessions?|visitors?)", "(?:website |web |site )?traffic", "number of (?:visits|sessions)"),
    maybe: rx("(?:unique )?(?:users|views)", "page ?views?", "hits"),
  },
  {
    key: "gsc_clicks", label: "Clicks from Google searches", noun: "Google search clicks", unit: "clicks", subject: GOOGLE_SEARCH, additive: true,
    sure: rx("(?:search|google|organic|gsc|search console) clicks?", "clicks from (?:google|search)"),
    maybe: rx("clicks?"),
  },
  {
    key: "gsc_impressions", label: "Times you showed up in Google searches", noun: "Google search impressions", unit: "impressions", subject: GOOGLE_SEARCH, additive: true,
    sure: rx("(?:search |google |gsc )?impressions?"), maybe: [],
  },
  {
    key: "gbp_actions", label: "Calls and directions from Google", noun: "calls and directions from Google", unit: "calls and directions", subject: "business", additive: true,
    sure: rx("calls? and directions?", "(?:google |business profile |profile )?actions?", "(?:google|gbp) (?:calls|actions)"),
    maybe: rx("(?:phone )?calls?", "directions?", "direction requests?", "calls? (?:from|via) google"),
  },
  {
    key: "new_accounts", label: "Signups", noun: "signups", unit: "signups", subject: "business", additive: true,
    sure: rx("(?:new )?sign ?-?ups?", "registrations?", "new (?:accounts?|users|registrations)", "accounts created"),
    maybe: rx("new customers?", "new members?", "joiners"),
  },
  {
    key: "enquiries", label: "Enquiries", noun: "enquiries", unit: "enquiries", subject: "business", additive: true,
    sure: rx("(?:new |qualified |web |website )?(?:enquir(?:y|ies)|inquir(?:y|ies)|leads?)", "(?:contact )?form (?:submissions?|fills?|enquiries)", "contact forms?"),
    maybe: rx("contacts?", "messages?", "requests?", "quotes?(?: requests?)?"),
  },
  {
    key: "orders", label: "Orders", noun: "orders", unit: "orders", subject: "business", additive: true,
    sure: rx("orders?", "(?:number of |no of |total )orders?", "order count", "transactions?"), maybe: rx("purchases?", "checkouts?"),
  },
  {
    key: "bookings", label: "Bookings", noun: "bookings", unit: "bookings", subject: "business", additive: true,
    sure: rx("(?:new |online )?bookings?", "appointments?", "reservations?"), maybe: rx("covers", "visits booked", "slots? (?:filled|booked)"),
  },
  {
    key: "revenue", label: "Sales (money in)", noun: "sales", unit: "currency", subject: "business", additive: true,
    sure: rx("(?:total |gross |net |online )?(?:revenue|sales|turnover|takings|income)", "money in", "sales value"),
    maybe: rx("(?:total )?amount", "total", "value", "gmv"),
  },
  {
    key: "ad_spend", label: "Ad spend", noun: "ad spend", unit: "currency", subject: PAID_ADS, additive: true,
    sure: rx("(?:ad|ads|advertising|marketing|paid|campaign) (?:spend|cost|costs|budget)", "ad ?spend", "spend", "cost"), maybe: rx("budget"),
  },
  {
    key: "account_reach", label: "Instagram reach (people who saw your posts)", noun: "Instagram reach", unit: "accounts", subject: INSTAGRAM, additive: false,
    sure: rx("(?:instagram |ig )?(?:account )?reach", "accounts reached"), maybe: rx("(?:people|accounts) reached"),
  },
  {
    key: "followers", label: "Instagram followers", noun: "Instagram followers", unit: "followers", subject: INSTAGRAM, additive: false,
    sure: rx("(?:instagram |ig |total )?followers?"), maybe: rx("audience", "fans", "likes"),
  },
  {
    key: "new_followers", label: "New Instagram followers", noun: "new Instagram followers", unit: "followers", subject: INSTAGRAM, additive: true,
    sure: rx("new (?:instagram |ig )?followers?", "follower growth", "followers gained"), maybe: [],
  },
];

// measure.ts knows the non-additive keys (it must read goals of tenants onboarded before this file existed); a test pins
// the two lists together.
export const isAdditive = (key: string): boolean => !NON_ADDITIVE_METRICS.has(key);

export const metricByKey = (key: string): MetricDef | undefined => METRICS.find((m) => m.key === key);

const normalise = (h: string): string => h.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();

export interface HeaderGuess { metric: string | null; sure: boolean }

export function guessHeader(header: string): HeaderGuess {
  const h = normalise(header);
  if (!h) return { metric: null, sure: false };
  for (const m of METRICS) if (m.sure.some((r) => r.test(h))) return { metric: m.key, sure: true };
  for (const m of METRICS) if (m.maybe.some((r) => r.test(h))) return { metric: m.key, sure: false };
  return { metric: null, sure: false };
}

// An owner's own name for a column we have no metric for ("Pints sold") becomes `custom_pints_sold`.
export function customKey(label: string): string {
  const slug = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return `custom_${slug || "numbers"}`;
}

// Columns whose header says they number the rows, not the business.
export const LABEL_HEADER = /^(?:#|no\.?|nr|num|number|id|index|row|week(?: ?(?:no\.?|number|num|#))?|month(?: ?(?:no\.?|number))?|year|day|quarter|period|s\.? ?no\.?|sr\.? ?no\.?)$/i;

// Columns that identify a person, or hold contact details: a file with one is refused (privacy.ts), never read around.
// Anchored on the whole header, so "Email orders" and "Phone calls" (numbers about the business) pass and "Customer email"
// and "Phone" do not.
export const PERSONAL_HEADER = new RegExp(`^(?:${[
  "e-?mail(?: address)?", "(?:customer|client|contact|guest|patient|user|buyer|member)(?: |_)(?:e-?mail|name|phone|mobile|id|address)",
  "phone(?: (?:number|no\\.?))?", "mobile(?: (?:number|no\\.?))?", "telephone(?: number)?", "tel", "whatsapp(?: number)?", "contact(?: (?:number|details|info))?",
  "(?:home |billing |shipping |postal |street |delivery |full )?address", "post ?code", "zip ?code", "first name", "last name", "full name", "surname", "name",
  "customer", "client", "guest", "patient", "passenger", "buyer", "dob", "date of birth", "birthday", "passport(?: number)?", "ssn", "national id",
  "aadhaar(?: number)?", "pan(?: number)?", "ip(?: address)?", "card number", "iban", "account number",
].join("|")})$`, "i");

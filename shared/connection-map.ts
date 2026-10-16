// The catalogue of connections, as pure data (the web app reads it too): what each toolkit is called, the one line on what the
// team does with it, which departments may use it, which kinds of business it fits first, and the everyday jobs (starter tasks)
// that appear as chips once it is connected. Composio is the main path for all of them (src/connections/composio.ts); Google
// products can also run on Allevia's own Google app (docs/connections-setup.md). Owner words only (docs/owner-words.md).
//
// Composio toolkit slugs below are from Composio's public catalogue as known when this was written. `npm run cli -- connect toolkits`
// asks Composio which of them exist and says which don't, so a wrong slug is found in a minute, not by a customer.

export type ConnectionGroupId = "google" | "meta" | "commerce" | "customers" | "team";
export type BusinessFit = "local" | "shop" | "app" | "services";

export interface ToolkitEntry {
  /** Allevia's connection id (also the name of its sealed record). */
  id: string;
  /** Composio's toolkit slug. */
  toolkit: string;
  name: string;
  group: ConnectionGroupId;
  /** One line, owner's words: what the team will do with it. */
  blurb: string;
  reads: string[];
  acts: string[];
  /** Position in the recommended set shown first (1 to 15); null: only reachable from "More". */
  recommended: number | null;
  /** Which kinds of business it fits first. */
  fits: BusinessFit[];
  /** Roster departments (plus "sales", which the Sales team adds) whose people may use it. */
  departments: string[];
  /** The capability-ladder keys it feeds. */
  capabilities: string[];
  system: { id: string; name: string };
}

const g = (e: Omit<ToolkitEntry, "system" | "capabilities"> & { capabilities?: string[]; systemId?: string }): ToolkitEntry => ({
  ...e, capabilities: e.capabilities ?? [], system: { id: e.systemId ?? `system:${e.id}`, name: e.name },
});

export const TOOLKIT_CATALOG: ToolkitEntry[] = [
  g({ id: "gmail", toolkit: "gmail", name: "Gmail", group: "google", recommended: 1, fits: ["services", "shop", "app", "local"], departments: ["sales", "ops", "leadership"], capabilities: ["email"], systemId: "system:gmail",
    blurb: "Your team reads the emails that need a reply, drafts the answers and sends them from your address, after your OK.",
    reads: ["The emails you allow it to read."], acts: ["Sends an email from your address, only after you say OK."] }),
  g({ id: "google-calendar", toolkit: "googlecalendar", name: "Google Calendar", group: "google", recommended: 2, fits: ["services", "local", "app", "shop"], departments: ["sales", "ops", "leadership"], capabilities: ["calendar"], systemId: "system:google-calendar",
    blurb: "Your team sees when you're free and books calls with your clients on your calendar, after your OK.",
    reads: ["When you are busy or free, and today's meetings."], acts: ["Adds a meeting to your calendar, only after you say OK."] }),
  g({ id: "google-analytics", toolkit: "google_analytics", name: "Google Analytics", group: "google", recommended: 3, fits: ["app", "shop", "services"], departments: ["analytics", "coe", "marketing", "leadership"], capabilities: ["ga4"], systemId: "system:ga4",
    blurb: "Your team reads your website visits, where they come from and what they do, every morning.",
    reads: ["Visits, where they come from, sign-ups and enquiries counted on your site."], acts: [] }),
  g({ id: "search-console", toolkit: "google_search_console", name: "Google Search Console", group: "google", recommended: 4, fits: ["app", "shop", "services", "local"], departments: ["analytics", "coe", "tech", "marketing", "leadership"], capabilities: ["search_console"], systemId: "system:search-console",
    blurb: "Your team sees the searches that bring people to your site, and which pages Google can't find.",
    reads: ["Searches, clicks and pages on your site. Read only."], acts: [] }),
  g({ id: "google-ads", toolkit: "googleads", name: "Google Ads", group: "google", recommended: 5, fits: ["app", "shop", "services"], departments: ["marketing", "analytics", "coe", "leadership"], capabilities: ["ads"], systemId: "system:google-ads",
    blurb: "Your team reads your ad spend, clicks and enquiries so it can say where your money works and where it leaks.",
    reads: ["Campaigns, what you spent, clicks and enquiries."], acts: ["Pauses or changes an ad, only after you say OK."] }),
  g({ id: "instagram", toolkit: "instagram", name: "Instagram", group: "meta", recommended: 6, fits: ["local", "shop", "services"], departments: ["marketing", "content", "leadership"], capabilities: ["instagram_insights"], systemId: "system:instagram",
    blurb: "Your team sees which posts bring you enquiries and drafts the next ones.",
    reads: ["Reach, followers, comments and how each post did."], acts: ["Posts only after you say OK."] }),
  g({ id: "facebook-pages", toolkit: "facebook", name: "Facebook Page", group: "meta", recommended: 7, fits: ["local", "shop", "services"], departments: ["marketing", "content", "leadership"],
    blurb: "Your team reads how your Page is doing and drafts posts for your OK.",
    reads: ["Page visits, reach, posts and messages."], acts: ["Posts only after you say OK."] }),
  g({ id: "meta-ads", toolkit: "metaads", name: "Meta Ads", group: "meta", recommended: 8, fits: ["app", "shop", "local"], departments: ["marketing", "analytics", "coe", "leadership"], capabilities: ["ads"], systemId: "system:meta-ads",
    blurb: "Your team reads your Facebook and Instagram ad spend and results, and says where to cut.",
    reads: ["Campaigns, spend and results."], acts: ["Pauses an ad, only after you say OK."] }),
  g({ id: "whatsapp", toolkit: "whatsapp", name: "WhatsApp Business", group: "meta", recommended: 9, fits: ["local", "shop", "services"], departments: ["sales", "marketing", "leadership"],
    blurb: "Your team drafts replies to customer messages for your OK.",
    reads: ["Messages customers send your business number."], acts: ["Sends a message only after you say OK."] }),
  g({ id: "shopify", toolkit: "shopify", name: "Shopify", group: "commerce", recommended: 10, fits: ["shop", "local"], departments: ["ops", "coe", "analytics", "marketing", "leadership"],
    blurb: "Your team counts your orders and best sellers so it can tell what to push.",
    reads: ["Orders, products and how many orders each customer placed."], acts: [] }),
  g({ id: "stripe", toolkit: "stripe", name: "Stripe", group: "commerce", recommended: 10, fits: ["shop", "app", "services"], departments: ["ops", "coe", "analytics", "leadership"],
    blurb: "Your team reads your payments so the morning note has real revenue.",
    reads: ["Payments, refunds and balance."], acts: [] }),
  g({ id: "hubspot", toolkit: "hubspot", name: "HubSpot", group: "customers", recommended: 11, fits: ["services", "app"], departments: ["sales", "marketing", "leadership"],
    blurb: "Your team sees your leads and deals so Sales can follow up on every one.",
    reads: ["Contacts, deals and their stages."], acts: ["Adds leads, notes and follow-ups only after you say OK."] }),
  g({ id: "calendly", toolkit: "calendly", name: "Calendly", group: "customers", recommended: 12, fits: ["services", "app"], departments: ["sales", "leadership"],
    blurb: "Your team sees who booked a call with you and sends your booking link to new leads.",
    reads: ["Booked calls and your booking links."], acts: [] }),
  g({ id: "mailchimp", toolkit: "mailchimp", name: "Mailchimp", group: "customers", recommended: 13, fits: ["shop", "local", "services"], departments: ["marketing", "content", "leadership"],
    blurb: "Your team reads how your emails did and drafts the next newsletter for your OK.",
    reads: ["Audiences and how past emails did."], acts: ["Sends a campaign only after you say OK."] }),
  g({ id: "linkedin", toolkit: "linkedin", name: "LinkedIn", group: "customers", recommended: 14, fits: ["services", "app"], departments: ["marketing", "content", "sales", "leadership"],
    blurb: "Your team drafts posts for your LinkedIn and reads how they did.",
    reads: ["Your posts and how they did."], acts: ["Posts only after you say OK."] }),
  g({ id: "slack", toolkit: "slack", name: "Slack", group: "team", recommended: 15, fits: ["app", "services"], departments: ["ops", "leadership"],
    blurb: "Your team posts its morning note and questions in the Slack channel you choose.",
    reads: ["The channels you pick."], acts: ["Posts a message only after you say OK."] }),
  // not in the first fifteen, but one tap away
  g({ id: "zoho", toolkit: "zoho", name: "Zoho CRM", group: "customers", recommended: null, fits: ["services"], departments: ["sales", "leadership"],
    blurb: "Your team sees your leads and deals so Sales can follow up on every one.", reads: ["Contacts, deals and their stages."], acts: ["Adds leads and notes only after you say OK."] }),
  g({ id: "tiktok", toolkit: "tiktok", name: "TikTok", group: "meta", recommended: null, fits: ["local", "shop"], departments: ["marketing", "content", "leadership"],
    blurb: "Your team reads how your videos did and drafts the next ones.", reads: ["Your videos and how they did."], acts: ["Posts only after you say OK."] }),
  g({ id: "quickbooks", toolkit: "quickbooks", name: "QuickBooks", group: "commerce", recommended: null, fits: ["services", "shop", "local"], departments: ["ops", "coe", "leadership"],
    blurb: "Your team sees your invoices and who still owes you.", reads: ["Invoices, bills and balances."], acts: [] }),
  g({ id: "xero", toolkit: "xero", name: "Xero", group: "commerce", recommended: null, fits: ["services", "shop", "local"], departments: ["ops", "coe", "leadership"],
    blurb: "Your team sees your invoices and who still owes you.", reads: ["Invoices, bills and balances."], acts: [] }),
  g({ id: "google-sheets", toolkit: "googlesheets", name: "Google Sheets", group: "team", recommended: null, fits: ["services", "shop", "app", "local"], departments: ["ops", "coe", "leadership"],
    blurb: "Your team keeps meeting notes, decisions and action items in a sheet.", reads: ["The sheets you pick."], acts: ["Adds rows only after you say OK."] }),
];

export const entryById = (id: string): ToolkitEntry | undefined => TOOLKIT_CATALOG.find((e) => e.id === id);
export const entryByToolkit = (slug: string): ToolkitEntry | undefined => TOOLKIT_CATALOG.find((e) => e.toolkit === slug);

/** The ids of the connections a department may use (the Chief of Staff and "leadership" may use all). */
export function connectionsForDepartment(dept: string): string[] {
  return TOOLKIT_CATALOG.filter((e) => e.departments.includes(dept) || dept === "leadership").map((e) => e.id);
}

// ---------- which kind of business it is, from the words the business gave ----------

const FIT_WORDS: Array<[BusinessFit, RegExp]> = [
  ["app", /\b(app|software|saas|platform|startup|tech|digital|marketplace|portal)\b/i],
  ["shop", /\b(shop|store|retail|ecommerce|e-commerce|boutique|fashion|apparel|jewel|furniture|d2c|brand)\b/i],
  ["local", /\b(caf[eé]|coffee|restaurant|bakery|salon|spa|clinic|dental|gym|studio|hotel|bar|food|kitchen|local|repair|architect|interior)\b/i],
  ["services", /\b(agency|consult|services?|law|account|finance|recruit|staffing|b2b|coach|training|real estate)\b/i],
];

export function fitOf(...words: Array<string | undefined>): BusinessFit | null {
  const text = words.filter(Boolean).join(" ");
  return FIT_WORDS.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** The recommended connections, the ones that fit this business first (stable otherwise). */
export function recommendedFor(fit: BusinessFit | null): ToolkitEntry[] {
  const rec = TOOLKIT_CATALOG.filter((e) => e.recommended !== null);
  return rec.map((e, i) => ({ e, i })).sort((a, b) => Number(!!fit && b.e.fits.includes(fit)) - Number(!!fit && a.e.fits.includes(fit)) || a.e.recommended! - b.e.recommended! || a.i - b.i).map((x) => x.e);
}

// ---------- starter tasks: everyday jobs, as chips once the tools are connected ----------

export interface StarterTask {
  id: string;
  /** The chip's words: what the owner is asking for. */
  label: string;
  /** The question sent to the team when the chip is tapped. */
  ask: string;
  /** The connections it needs (any one of the lists is enough; each id in a list is needed). */
  needs: string[][];
  /** The roster ids whose chat shows it (empty: the Connections page and the Chief's chat). */
  agents: string[];
  department: "sales" | "marketing" | "ads" | "ops";
  /** True when the job ends in something that is sent, posted, booked, spent or paused, which waits for the owner's OK. */
  needsOk: boolean;
}

export const STARTER_TASKS: StarterTask[] = [
  { id: "sales-today", department: "sales", label: "Today's meetings and the emails that need a reply", ask: "What meetings do I have today, and which emails need a reply?", needs: [["google-calendar"], ["gmail"]], agents: ["sales-lead", "ops-manager", "chief-of-staff"], needsOk: false },
  { id: "sales-draft-replies", department: "sales", label: "Draft replies to my emails", ask: "Draft replies to the emails that need an answer, for my OK.", needs: [["gmail"]], agents: ["sales-lead", "ops-manager", "chief-of-staff"], needsOk: true },
  { id: "sales-invite", department: "sales", label: "Find a free hour and send an invite", ask: "Find a free hour this week and send an invite to my lead, for my OK.", needs: [["google-calendar"]], agents: ["sales-lead", "ops-manager", "chief-of-staff"], needsOk: true },
  { id: "sales-stalled", department: "sales", label: "Deals that haven't moved in two weeks", ask: "Which deals haven't moved in two weeks?", needs: [["hubspot"], ["zoho"]], agents: ["sales-lead", "ops-manager", "chief-of-staff"], needsOk: false },
  { id: "sales-followups", department: "sales", label: "Follow-ups for stalled deals", ask: "Draft a follow-up for each stalled deal, for my OK.", needs: [["hubspot", "gmail"], ["zoho", "gmail"]], agents: ["sales-lead", "ops-manager", "chief-of-staff"], needsOk: true },
  { id: "sales-new-leads", department: "sales", label: "Add new leads from my inbox to the CRM", ask: "Find new leads in my inbox and add them to my CRM, for my OK.", needs: [["gmail", "hubspot"], ["gmail", "zoho"]], agents: ["sales-lead", "ops-manager", "chief-of-staff"], needsOk: true },
  { id: "mkt-top-posts", department: "marketing", label: "Top posts this week", ask: "Which of my Instagram posts did best this week, and why?", needs: [["instagram"], ["facebook-pages"]], agents: ["content-strategist", "growth-marketer", "chief-of-staff"], needsOk: false },
  { id: "mkt-unanswered", department: "marketing", label: "Unanswered questions in comments and messages", ask: "Which questions in my comments and messages are still unanswered?", needs: [["instagram"], ["facebook-pages"], ["whatsapp"]], agents: ["content-strategist", "growth-marketer", "chief-of-staff"], needsOk: false },
  { id: "mkt-announce", department: "marketing", label: "Post an announcement to Instagram, Facebook and LinkedIn", ask: "Draft an announcement for Instagram, Facebook and LinkedIn, for my OK.", needs: [["instagram"], ["facebook-pages"], ["linkedin"]], agents: ["content-strategist", "chief-of-staff"], needsOk: true },
  { id: "ads-search-terms", department: "ads", label: "Top search terms and landing pages this month", ask: "What are my top search terms and landing pages this month?", needs: [["search-console"], ["google-ads"]], agents: ["data-analyst", "growth-marketer", "chief-of-staff"], needsOk: false },
  { id: "ads-cost-per-lead", department: "ads", label: "Cost per lead across Google and Meta", ask: "What does a lead cost me on Google and on Meta?", needs: [["google-ads", "meta-ads"], ["google-ads"], ["meta-ads"]], agents: ["growth-marketer", "data-analyst", "chief-of-staff"], needsOk: false },
  { id: "ads-pause-waste", department: "ads", label: "Pause keywords that spent a lot and got no leads", ask: "Find keywords that spent over my limit with no leads and propose pausing them, for my OK.", needs: [["google-ads"], ["meta-ads"]], agents: ["growth-marketer", "chief-of-staff"], needsOk: true },
  { id: "ops-notes-to-sheet", department: "ops", label: "Meeting notes and decisions into a sheet", ask: "Put the notes, decisions and action items from my Drive or Docs into a Google Sheet, for my OK.", needs: [["google-sheets"]], agents: ["ops-manager", "chief-of-staff"], needsOk: true },
];

/** The chips to show for the connections a business has, optionally for one agent. */
export function startersFor(connected: readonly string[], agent?: string): StarterTask[] {
  const have = new Set(connected);
  return STARTER_TASKS.filter((t) => t.needs.some((list) => list.every((id) => have.has(id))) && (!agent || t.agents.includes(agent)));
}

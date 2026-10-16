// What the home page's scroll story says, as data, so tests can hold it to the code and the records it describes.
// Every line traces to something real: a default in the code (file named beside it), a recorded run in
// docs/creative-live/v2, a trial report in docs/, or the app's own demo data (web/src/mock), which is always labelled
// "sample numbers" where it shows. Words follow docs/owner-words.md.

/** The stops on the courier route (the fixed strip at the bottom of the home page). `id` is the section's id. */
export const ROUTE = [
  { id: "team", name: "Your team" },
  { id: "setup", name: "Paste" },
  { id: "ask", name: "Ask" },
  { id: "ok", name: "OK" },
  { id: "made", name: "Made" },
  { id: "plan", name: "Plan" },
] as const;

/** One owner request, all the way to the OK tap (the Ask screen, demo mode, sample business). */
export const ONE_REQUEST: { who: string; says: string }[] = [
  { who: "You, in your own words", says: "Why did we pause daily stories, and what should we post instead? In the app, or in #your-team on Discord." },
  { who: "Meera, Chief of Staff", says: "Splits the work: the history to Sara, the numbers to Kabir, the briefs to Tara." },
  { who: "Sara and Kabir", says: "Sara finds the decision and why it was made. Kabir ranks 90 days of reels by reach." },
  { who: "Tara, then Dev, Nisha and Isha", says: "Tara drafts three reel briefs. Dev checks the voice, Nisha the facts, Isha every figure." },
  { who: "The answer", says: "Arrives with a source on every claim. \"See the path\" lights the seven steps behind it." },
  { who: "Waiting for your OK", says: "\"Draft 3 reels.\" One card, with what saying OK will do." },
];

/**
 * Numbers that prove control. Each is a default in the code or a rule the code enforces; tests/site/story.test.ts reads
 * the source files and fails if one drifts.
 */
export const CONTROL_NUMBERS: { figure: string; label: string; source: string }[] = [
  { figure: "0", label: "posts published by Allevia. An approved post is saved as a draft for you to publish.", source: "src/server/app.ts approvals; FAQ" },
  { figure: "3★", label: "or lower: replies to those reviews never go out on their own, and neither do price claims or spending.", source: "site security page" },
  { figure: "$2", label: "a month per business: the default cap on paid public-data lookups.", source: "src/publicdata/ledger.ts DEFAULT_MONTHLY_USD" },
  { figure: "5", label: "Studio credits at most for one AI edit, and its price is shown before it is made.", source: "src/studio/credits.ts DEFAULT_RUN_CAP" },
  { figure: "7 days", label: "and one use: every invite to your private Discord area.", source: "docs/discord-hub-setup.md" },
];

/** Below the waterline: what keeps it safe. Each with the failure it prevents ("Without it:"). */
export const WATERLINE: { name: string; does: string; without: string }[] = [
  {
    name: "Your own memory",
    does: "Each business is its own database. A question is tied to one business before the team starts, and no tool can name another business's memory.",
    without: "one business's facts could turn up in another business's answer.",
  },
  {
    name: "Sources and checks",
    does: "Every claim in an answer cites what the team looked up, and the numbers are checked against it before you see them. A claim that fails is marked \"unverified\", not hidden.",
    without: "a confident answer with a number nobody can trace.",
  },
  {
    name: "The privacy filter",
    does: "Passwords, account numbers, email addresses and phone numbers are removed before text is stored or sent to the AI model. Photos lose their location on arrival.",
    without: "a customer's phone number ends up inside an AI prompt.",
  },
  {
    name: "Waiting for your OK",
    does: "Anything that costs money, speaks in public or moves a goal is a card. Saying OK saves the draft; it does not post.",
    without: "a post goes out that nobody read.",
  },
  {
    name: "Budgets on paid tools",
    does: "Public-data lookups and AI picture edits have caps per business, per edit and per day, and a price is shown before anything is spent.",
    without: "a busy week runs up a bill nobody agreed to.",
  },
  {
    name: "Read-only connections",
    does: "When we read your numbers, only a short list of read-only actions is allowed. Anything else is refused before it is sent.",
    without: "a tool that was meant to read your numbers could change them.",
  },
];

/** The things the team made (docs/creative-live/v2), labelled like exhibits: what, who, how long, where it stands. */
export interface Work {
  img?: string; video?: string; poster?: string; w: number; h: number;
  what: string; who: string; time: string; status: string; alt: string; note?: string;
}
export const WORK: Work[] = [
  {
    img: "/media/work-avs-ad.webp", w: 600, h: 750,
    what: "An ad for an architecture studio's interior design, in Raipur",
    who: "Tara, from the studio's own project photos", time: "75 seconds", status: "Waiting for the owner's OK",
    alt: "A portrait Instagram ad: a bright bedroom from the studio's own project, the headline 'Rooms planned around how your family lives' and 'Book a site visit at avsatelier.in'.",
  },
  {
    video: "/media/work-avs-reel.mp4", poster: "/media/work-avs-reel-poster.webp", w: 360, h: 640,
    what: "A 14-second reel: plan the room before buying furniture",
    who: "Tara, with captions timed to the cuts", time: "planned in 20 seconds", status: "Draft, waiting for the owner's OK",
    note: "Two of its shots are short moving clips made from the studio's real photos.",
    alt: "A vertical reel of the studio's real interiors with short captions.",
  },
  {
    img: "/media/work-aamdani-poster.webp", w: 600, h: 750,
    what: "A Hindi launch poster for a jobs app in Raipur",
    who: "Tara, for job seekers", time: "37 seconds", status: "Waiting for the owner's OK",
    note: "The street scene is AI-made, and the app's record says so.",
    alt: "A poster in Hindi: a young man at a roadside stall looks at his phone; a card shows 'Pharmacy Assistant, 14,000 to 18,000 rupees a month'.",
  },
  {
    img: "/media/fix-card.webp", w: 640, h: 356,
    what: "A fix for the website: unique titles for 38 job pages",
    who: "Arjun, tech lead", time: "from the weekly check", status: "Goes to your web person as a to-do when you say OK",
    alt: "An approval card: 'A fix for your website. Unique titles and meta descriptions for 38 job pages', by Arjun, with Approve, Edit and Reject.",
  },
];

/** The website check-up, quoted from its real report on avsatelier.in (docs/website-checkup-trials.md). */
export const CHECKUP_TOP: string[] = [
  "Put a call or WhatsApp button on the first screen on phones.",
  "Make the site faster on phones.",
  "Show reviews or proof from customers.",
  "Make buttons and links bigger on phones.",
  "Show your opening hours.",
];

/** Use cases with a place and an outcome. The first two happened; the rest are examples of a first week, said so. */
export const USE_CASES: { head: string; body: string; real: boolean }[] = [
  { head: "An architecture studio in Raipur gets an ad for its interiors.", body: "From its own project photos, in 75 seconds, waiting for the owner's OK.", real: true },
  { head: "A jobs app gets its launch poster in Hindi.", body: "Written for job seekers in Raipur, in 37 seconds, with the AI-made scene labelled.", real: true },
  { head: "A physio clinic in Leeds learns its five best website fixes.", body: "Ranked by the enquiries they are likely to bring, each with who does it and how long it takes.", real: false },
  { head: "A café in Melbourne gets a week of posts from its own photos.", body: "Straightened, brightened and captioned in its voice, every one waiting for a tap.", real: false },
  { head: "A salon in Dubai finds out why March was slow.", body: "From a spreadsheet of its bookings, with the sources behind every number.", real: false },
];

/** Connections, split the way an owner thinks about them. `live` is what works today. */
export const YOUR_ACCOUNTS: { name: string; status: string; live: boolean }[] = [
  { name: "Your website", status: "Read at setup and checked every week", live: true },
  { name: "A spreadsheet of your numbers", status: "Drop a CSV or Excel file in the app or in Discord", live: true },
  { name: "Google Search Console", status: "Being built", live: false },
  { name: "Instagram", status: "Being built, after Meta's review", live: false },
  { name: "Google Business Profile", status: "Being built, after Google's review", live: false },
];
export const BUILT_IN: { name: string; does: string }[] = [
  { name: "Website check-up", does: "Speed and first-screen checks on your pages, and the five fixes most likely to bring enquiries." },
  { name: "Does AI know you?", does: "Asks an AI model the questions your customers would ask, and tells you whether it names you." },
  { name: "Public lookups", does: "Your Google listing, public Instagram and competitors, inside a monthly budget, when it is switched on for you." },
  { name: "Studio", does: "Straightens and brightens your photos for free; AI edits are priced in credits before they are made." },
  { name: "Posters and reels", does: "Designed with real type and your own photos, then reviewed and revised before you see them." },
];

/** What we do not do. */
export const WE_DO_NOT: string[] = [
  "Post anything by ourselves. You publish the drafts you approve.",
  "Guarantee revenue. We guarantee what we control: the setup, the work delivered, the effort goals.",
  "Give legal, tax, medical or money-moving advice. Meera says no politely and says who to ask.",
  "Train on your business for anyone else, or mix it with another business's memory.",
  "Need you to learn a tool. If something needs explaining, it sits behind \"Show how\".",
];

/** The growth plan's sample numbers (web/src/mock/program.ts, Aamdani): where it started, where it is, the goal. */
export const PLAN_SAMPLE: { name: string; unit: string; from: number; now: number; goal: number; status: string; who: string }[] = [
  { name: "Weekly signups", unit: "a week", from: 264, now: 312, goal: 360, status: "Going well", who: "Rohan" },
  { name: "Instagram reach", unit: "accounts a month", from: 52_400, now: 61_900, goal: 78_600, status: "Going well", who: "Tara" },
  { name: "Search clicks", unit: "clicks a month", from: 9_800, now: 10_100, goal: 12_700, status: "Needs a push", who: "Kabir" },
];

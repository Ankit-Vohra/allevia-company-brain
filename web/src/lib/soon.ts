// Screens from the product design that are planned but not built yet. The navigation lists them so the shape of the
// product is visible, and each opens a short page that says what it will do.
import type { IconName } from "../components/Icon";

export type SoonId = "studio" | "plan" | "program";

export interface SoonScreen {
  id: SoonId;
  path: string;
  nav: string;
  title: string;
  icon: IconName;
  blurb: string;            // one line for menus
  lede: string;
  points: string[];
  agents: string[];
  meanwhile: { label: string; to: string };
}

export const SOON: SoonScreen[] = [
  {
    id: "studio", path: "/studio", nav: "Studio", title: "Studio", icon: "sparkle",
    blurb: "Turn a phone photo into an on-brand post",
    lede: "Drop a photo and a line about it. Tara plans the post, the studio straightens, relights and crops it, and Nisha checks that nothing real was changed: the building, the dish or the haircut stays as it is.",
    points: [
      "Three versions side by side, each with a fidelity check",
      "Captions in your voice, edited by Dev before you see them",
      "Approve once and it joins the week’s content pack",
    ],
    agents: ["content-strategist", "copy-editor", "fact-checker"],
    meanwhile: { label: "Ask Tara for post ideas", to: "/ask?q=" + encodeURIComponent("What should we post this week, and why?") },
  },
  {
    id: "plan", path: "/plan", nav: "Plan and usage", title: "Plan and usage", icon: "layers",
    blurb: "Your plan, Studio credits and invoices",
    lede: "Your plan, what it includes and what this month has used, in your own currency. Unused Studio credits roll over, exporting your data is always free, and cancelling takes one screen.",
    points: [
      "Price and allowances in your currency, before tax",
      "Studio credits used and left, with a top-up when you need it",
      "Invoices, data export and erasure in one place",
    ],
    agents: ["ops-manager", "coe-lead"],
    meanwhile: { label: "See what the team did this week", to: "/approvals" },
  },
  {
    id: "program", path: "/program", nav: "Program scorecard", title: "Your 90 days", icon: "insights",
    blurb: "Goals against day 0, and the team improving",
    lede: "Ninety days from set-up to graduation. Your goals against the day-0 baseline, the share of drafts you approve without edits, rules learned and hours saved, reviewed with a person from our team at day 30 and day 90.",
    points: [
      "Goals measured against the baseline locked on day 0",
      "First-pass approvals, week by week",
      "Reviews at day 30 and day 90 with a Growth Partner",
    ],
    agents: ["coe-lead", "chief-of-staff"],
    meanwhile: { label: "See this week’s recommendations", to: "/insights" },
  },
];

export const soonById = (id: SoonId) => SOON.find((s) => s.id === id)!;

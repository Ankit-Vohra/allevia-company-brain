// The page registry: one entry per page of the site. The head of every page (title, description, canonical, social cards,
// structured data), the sitemap, the footer and the link check all read this list, so a page cannot be in one and
// missing from another. A page's file is derived from its path: "/" is site/index.html, "/how-it-works/" is
// site/how-it-works/index.html.
import { AGENTS, numberWord } from "../../shared/roster.ts";

export type Schema = "organization" | "website" | "software" | "faq" | "breadcrumb";

export interface PageDef {
  /** URL path with leading and trailing slash. */
  path: string;
  /** The <title>. Keep it under about 60 characters. */
  title: string;
  /** The meta description and the social card text: 110 to 160 characters. */
  description: string;
  /** The label in the top navigation (omit for pages not in it). */
  nav?: string;
  /** Footer column the page is listed in. */
  footer?: "Product" | "Company" | "Legal";
  /** The footer label, when it differs from the nav label or the page needs one. */
  label?: string;
  priority: number;
  changefreq: "weekly" | "monthly" | "yearly";
  schema: Schema[];
  /** Social card image, relative to the site root. Defaults to /img/og.jpg. */
  image?: string;
  imageAlt?: string;
}

const STAFF = numberWord(AGENTS.length);

export const PAGES: readonly PageDef[] = [
  {
    path: "/",
    title: "Allevia · We set it up, you steer",
    description: `A team of ${STAFF} AI staff for your business, set up for you from your website. They do the marketing groundwork and ask for your OK before anything goes out.`,
    footer: "Product", label: "Home",
    priority: 1, changefreq: "weekly", schema: ["organization", "website", "software"],
  },
  {
    path: "/how-it-works/",
    title: "How it works · Allevia",
    description: "Three steps: paste your website, meet your team and approve your growth plan, then your team works and asks you only when it matters.",
    nav: "How it works", footer: "Product",
    priority: 0.9, changefreq: "monthly", schema: ["breadcrumb"],
  },
  {
    path: "/product/",
    title: "Product tour · Allevia",
    description: "See Allevia at work: the office, your growth plan, asking your team, approvals and the photo Studio. Real screens, with sample numbers clearly labelled.",
    nav: "Product tour", footer: "Product",
    priority: 0.9, changefreq: "monthly", schema: ["software", "breadcrumb"],
  },
  {
    path: "/demo/",
    title: "Live demo · Allevia",
    description: "Look around a read-only copy of the real Allevia app: the office, the growth plan, insights and approvals. Nothing you do there is saved or sent.",
    footer: "Product", label: "Live demo",
    priority: 0.7, changefreq: "monthly", schema: ["breadcrumb"],
  },
  {
    path: "/pricing/",
    title: "Pricing · Allevia",
    description: "Start with a three-month growth plan with a 14-day refund and a day-30 delivery guarantee, then Essentials, Growth, Pro or Pause. Prices in USD, GBP, AED and AUD.",
    nav: "Pricing", footer: "Product",
    priority: 0.9, changefreq: "monthly", schema: ["software", "breadcrumb"],
  },
  {
    path: "/security/",
    title: "Security and privacy · Allevia",
    description: "Each business is its own separate database, nothing is shared across businesses, and nothing is posted without the owner's OK. What we do, and what we do not claim.",
    nav: "Security", footer: "Company",
    priority: 0.8, changefreq: "monthly", schema: ["breadcrumb"],
  },
  {
    path: "/faq/",
    title: "Questions owners ask · Allevia",
    description: "Straight answers: what you do, what we do, what gets posted, where your data lives, how to leave and what Allevia does not do.",
    nav: "FAQ", footer: "Company",
    priority: 0.8, changefreq: "monthly", schema: ["faq", "breadcrumb"],
  },
  {
    path: "/about/",
    title: "About · Allevia",
    description: "Allevia is built in India for owner-run businesses in the US, UK, UAE and Australia. Who we are, what works today and what is still being built.",
    footer: "Company", label: "About",
    priority: 0.6, changefreq: "monthly", schema: ["breadcrumb"],
  },
  {
    path: "/contact/",
    title: "Contact and support · Allevia",
    description: "Ask for a free Brain Snapshot, get support in our Discord channel or by email, and send privacy requests. What to send and when we reply.",
    footer: "Company", label: "Contact and support",
    priority: 0.7, changefreq: "monthly", schema: ["breadcrumb"],
  },
];

export const pageByPath = (path: string): PageDef | undefined => PAGES.find((p) => p.path === path);

/** The source file of a page, relative to site/. */
export const pageFile = (path: string): string => (path === "/" ? "index.html" : `${path.slice(1)}index.html`);

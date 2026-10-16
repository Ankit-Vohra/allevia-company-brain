// The page registry: one entry per page of the site. The head of every page (title, description, canonical, social cards,
// structured data), the sitemap, the footer and the link check all read this list, so a page cannot be in one and
// missing from another. A page's file is derived from its path: "/" is site/index.html, "/pricing/" is
// site/pricing/index.html.
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
    title: "Allevia · An AI team that grows your business",
    description: "Paste your website and Allevia sets up a team of AI staff for your business. They make the posts and fixes, and you tap OK before anything goes out.",
    footer: "Product", label: "Home",
    priority: 1, changefreq: "weekly", schema: ["organization", "website", "software"],
  },
  {
    path: "/product/",
    title: "Product tour · Allevia",
    description: "Five real screens from the app: your office, your questions, your OK, your growth plan and your instructions. Numbers are samples and labelled as such.",
    nav: "Product tour", footer: "Product",
    priority: 0.9, changefreq: "monthly", schema: ["software", "breadcrumb"],
  },
  {
    path: "/demo/",
    title: "Live demo · Allevia",
    description: "Look around a read-only copy of the real Allevia app: the office, the growth plan and the cards waiting for your OK. Nothing you do there is saved or sent.",
    footer: "Product", label: "Live demo",
    priority: 0.7, changefreq: "monthly", schema: ["breadcrumb"],
  },
  {
    path: "/pricing/",
    title: "Pricing · Allevia",
    description: "Start with a three-month growth plan, then pick Essentials, Growth, Pro or Pause. Prices in US dollars, with a 14-day full refund.",
    nav: "Pricing", footer: "Product",
    priority: 0.9, changefreq: "monthly", schema: ["software", "breadcrumb"],
  },
  {
    path: "/security/",
    title: "Security · Allevia",
    description: "Your business has its own private database, nothing goes out without your OK, and private details are removed before the AI sees them.",
    nav: "Security", footer: "Company",
    priority: 0.8, changefreq: "monthly", schema: ["breadcrumb"],
  },
  {
    path: "/faq/",
    title: "Questions · Allevia",
    description: "Six plain answers: do you need to be technical, what gets posted, whose data is whose, what if it fails, and what it cannot do yet.",
    nav: "FAQ", footer: "Company",
    priority: 0.8, changefreq: "monthly", schema: ["faq", "breadcrumb"],
  },
  {
    path: "/about/",
    title: "About · Allevia",
    description: "Allevia is built in India for owner-run businesses in the US, UK, UAE and Australia. What works today and what is still being built.",
    footer: "Company", label: "About",
    priority: 0.6, changefreq: "monthly", schema: ["breadcrumb"],
  },
  {
    path: "/contact/",
    title: "Contact · Allevia",
    description: "Ask for a free Brain Snapshot, get help from a person, or send a privacy request. We reply within a working day or two.",
    footer: "Company", label: "Contact and support",
    priority: 0.7, changefreq: "monthly", schema: ["breadcrumb"],
  },
  {
    path: "/privacy/",
    title: "Privacy Policy · Allevia",
    description: "What Allevia collects from your website, accounts, photos and chats, why, where it is kept, how long, who processes it, and how to export or delete it.",
    footer: "Legal", label: "Privacy Policy",
    priority: 0.5, changefreq: "yearly", schema: ["breadcrumb"],
  },
  {
    path: "/terms/",
    title: "Terms of Service · Allevia",
    description: "The terms for using Allevia: what the service is, what you agree to, who owns what, fees and refunds, and what happens if you stop.",
    footer: "Legal", label: "Terms of Service",
    priority: 0.5, changefreq: "yearly", schema: ["breadcrumb"],
  },
  {
    path: "/data-deletion/",
    title: "Delete your data · Allevia",
    description: "How to ask Allevia to delete everything it holds about your business, how to disconnect Instagram or Google, what we delete and how long it takes.",
    footer: "Legal", label: "Delete your data",
    priority: 0.5, changefreq: "yearly", schema: ["breadcrumb"],
  },
  {
    path: "/cookies/",
    title: "Cookies and analytics · Allevia",
    description: "This site sets no cookies, runs no analytics or ads, and stores nothing in your browser. The app and demo keep two small preferences.",
    footer: "Legal", label: "Cookies and analytics",
    priority: 0.3, changefreq: "yearly", schema: ["breadcrumb"],
  },
];

export const pageByPath = (path: string): PageDef | undefined => PAGES.find((p) => p.path === path);

/** The source file of a page, relative to site/. */
export const pageFile = (path: string): string => (path === "/" ? "index.html" : `${path.slice(1)}index.html`);

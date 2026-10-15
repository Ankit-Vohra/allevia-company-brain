// The <head> of every page, built from the page registry (src/pages.ts): title, description, canonical link, icons,
// Open Graph and Twitter cards, and the structured data (JSON-LD) for the organisation, the website, the software product
// and the FAQ. vite.config.ts swaps the `<!-- @head -->` comment in each page for this.
import { PLANS } from "../../../shared/plans.ts";
import { AGENTS } from "../../../shared/roster.ts";
import { COMPANY } from "../company.ts";
import { SITE_NAME, SITE_URL } from "../config.ts";
import { FAQ } from "../content.ts";
import { PAGES, type PageDef } from "../pages.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const abs = (path: string) => `${SITE_URL}${path}`;
/** JSON for a <script>: "<" is escaped so nothing in the text can close the tag. */
const json = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c");

const DEFAULT_IMAGE = "/img/og.jpg";
const DEFAULT_ALT = "A drawing of a studio owner with a cup of tea while a tiny pixel-art team works at small desks on a sheet of ledger paper.";

function organization() {
  const email = COMPANY.email.general || COMPANY.email.support;
  return {
    "@type": "Organization",
    "@id": `${SITE_URL}/#organization`,
    name: SITE_NAME,
    ...(COMPANY.legalName ? { legalName: COMPANY.legalName } : {}),
    url: `${SITE_URL}/`,
    logo: abs("/img/logo-512.png"),
    description: "Allevia is a team of AI staff for owner-run businesses, set up from the business's website. Nothing goes out without the owner's OK.",
    ...(COMPANY.country ? { foundingLocation: { "@type": "Place", name: COMPANY.country } } : {}),
    areaServed: ["US", "GB", "AE", "AU"],
    ...(email || COMPANY.discordSupportUrl
      ? { contactPoint: [{ "@type": "ContactPoint", contactType: "customer support", ...(email ? { email } : {}), availableLanguage: "English" }] }
      : {}),
    ...(COMPANY.discordSupportUrl ? { sameAs: [COMPANY.discordSupportUrl] } : {}),
  };
}

function website() {
  return { "@type": "WebSite", "@id": `${SITE_URL}/#website`, url: `${SITE_URL}/`, name: SITE_NAME, publisher: { "@id": `${SITE_URL}/#organization` }, inLanguage: "en" };
}

function software() {
  const usd = (p: (typeof PLANS)[number]) => p.price.monthly.USD;
  return {
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: SITE_NAME,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: `${SITE_URL}/`,
    image: abs(DEFAULT_IMAGE),
    description: `A team of ${AGENTS.length} AI staff for owner-run businesses: it reads your website, proposes a plan in plain words, does the marketing groundwork and waits for your OK before anything goes out.`,
    publisher: { "@id": `${SITE_URL}/#organization` },
    // One offer per plan, from shared/plans.ts (the same data the pricing page is built from). No ratings: there are none.
    offers: PLANS.map((p) => ({
      "@type": "Offer",
      name: p.name,
      price: usd(p),
      priceCurrency: "USD",
      priceSpecification: { "@type": "UnitPriceSpecification", price: usd(p), priceCurrency: "USD", billingDuration: 1, unitCode: "MON" },
      url: abs("/pricing/"),
      availability: "https://schema.org/InStock",
    })),
  };
}

function faq() {
  return {
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
}

function breadcrumb(page: PageDef) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: abs("/") },
      { "@type": "ListItem", position: 2, name: page.title.replace(/ · Allevia$/, ""), item: abs(page.path) },
    ],
  };
}

export function jsonLd(page: PageDef): object[] {
  const out: object[] = [];
  for (const s of page.schema) {
    if (s === "organization") out.push(organization());
    else if (s === "website") out.push(website());
    else if (s === "software") out.push(software());
    else if (s === "faq") out.push(faq());
    else if (s === "breadcrumb") out.push(breadcrumb(page));
  }
  return out;
}

export function head(page: PageDef): string {
  const url = abs(page.path);
  const image = abs(page.image ?? DEFAULT_IMAGE);
  const alt = page.imageAlt ?? DEFAULT_ALT;
  const ld = jsonLd(page).map((o) => `    <script type="application/ld+json">${json({ "@context": "https://schema.org", ...o })}</script>`).join("\n");
  const home = page.path === "/";
  return [
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`,
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta name="color-scheme" content="light" />`,
    `<meta name="theme-color" content="#162151" />`,
    `<meta name="robots" content="index, follow, max-image-preview:large" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta property="og:title" content="${esc(page.title)}" />`,
    `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(alt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(page.title)}" />`,
    `<meta name="twitter:description" content="${esc(page.description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="${esc(alt)}" />`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
    `<link rel="icon" href="/favicon-48.png" sizes="48x48" type="image/png" />`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
    `<link rel="manifest" href="/site.webmanifest" />`,
    home
      ? `<link rel="preload" as="image" href="/img/art-hero-1600.webp" imagesrcset="/img/art-hero-900.webp 900w, /img/art-hero-1600.webp 1600w" imagesizes="(min-width: 64rem) 56vw, 100vw" fetchpriority="high" />`
      : "",
    ld,
    `<script type="module" src="/src/main.ts"></script>`,
  ].filter(Boolean).join("\n    ");
}

/** The page whose source file Vite is transforming: ctx.path is "/how-it-works/index.html" (or "/index.html"). */
export function pageForRequest(requestPath: string): PageDef | undefined {
  const clean = requestPath.replace(/index\.html$/, "").split("?")[0]!;
  return PAGES.find((p) => p.path === clean);
}

/** The head of 404.html: the same icons and script, no canonical link, and a note to search engines to leave it out. */
export function notFoundHead(): string {
  return [
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`,
    `<title>Page not found · ${SITE_NAME}</title>`,
    `<meta name="description" content="That page does not exist. Go back to the Allevia home page." />`,
    `<meta name="robots" content="noindex" />`,
    `<meta name="color-scheme" content="light" />`,
    `<meta name="theme-color" content="#162151" />`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
    `<link rel="icon" href="/favicon-48.png" sizes="48x48" type="image/png" />`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
    `<script type="module" src="/src/main.ts"></script>`,
  ].join("\n    ");
}

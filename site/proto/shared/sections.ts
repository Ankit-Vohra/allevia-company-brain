// Shared pieces of the prototype pages, as HTML built at compile time (vite.config.ts swaps `<!-- @section name -->` for them).
// `page` says which page the section is built for (the id of its folder).
import { logoMarkup, hasLogo, usingLogoDev } from "./logos.ts";
import { AGENTS } from "./assets.generated.ts";
import { CHIP_ROWS } from "./data.ts";
import { TEAM_SECTIONS } from "./team-sections.ts";

import { esc } from "./util.ts";
import { COMPANY } from "../../src/company.ts";
import { heroA, productDiagram } from "./hero-sections.ts";
import { HOME_SECTIONS } from "./home-sections.ts";
import { PAGE_SECTIONS } from "./page-sections.ts";
import { LEGAL_SECTIONS } from "./legal-sections.ts";
import { pricingVisible } from "./flags.ts";
export { esc };

const NAV_ALL: { label: string; href: string; id: string }[] = [
  { label: "Product", href: "/product/", id: "product" },
  { label: "Integrations", href: "/integrations/", id: "integrations" },
  { label: "Team", href: "/team/", id: "team" },
  { label: "Pricing", href: "/pricing/", id: "pricing" },
  { label: "Security", href: "/security/", id: "security" },
];

/** The pages of the site, in the order of the top bar. Pricing is left out while the pricing page is hidden (flags.ts). */
export const navItems = (): { label: string; href: string; id: string }[] => NAV_ALL.filter((n) => n.id !== "pricing" || pricingVisible());

/** The top bar. `current` is the page id that gets aria-current; `home` is where the wordmark goes (the prototype's own home). */
export function nav(current: string, home: string): string {
  const links = navItems().map((n) => `<a href="${n.href}"${n.id === current ? ' aria-current="page"' : ""}>${esc(n.label)}</a>`).join("");
  return `<a class="skip" href="#main">Skip to content</a>
<header class="nav" data-nav>
  <div class="wrap nav__in">
    <a class="brand" href="${home}" aria-label="Allevia, home">allevia</a>
    <nav class="nav__links" id="site-nav" aria-label="Main">${links}</nav>
    <a class="btn btn-gold btn-sm nav__cta" href="/contact/#snapshot">Get a free Brain Snapshot</a>
    <button class="nav__menu" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="Menu" data-nav-menu><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 5.5h12M3 9h12M3 12.5h12"/></svg></button>
  </div>
</header>`;
}

/** The footer: the logo and one line about Allevia, three columns of links (About and the legal pages are built here too, legal-sections.ts),
 *  the contact email and the year. */
export function footer(): string {
  const col = (title: string, links: [string, string][]) => `<nav class="foot__col" aria-label="${esc(title)}"><h2 class="foot__h">${esc(title)}</h2><ul>${links.map(([l, h]) => `<li><a href="${h}">${esc(l)}</a></li>`).join("")}</ul></nav>`;
  return `<footer class="foot band band--ink on-ink">
  <div class="wrap foot__grid">
    <div class="foot__about">
      <a class="brand" href="/" aria-label="Allevia, home">allevia</a>
      <p class="foot__line">Your company’s brain, and the team that runs on it.</p>
      <p class="foot__mail"><a href="mailto:${COMPANY.email.general}">${esc(COMPANY.email.general)}</a></p>
      <p><a class="btn btn-gold btn-sm" href="/contact/#demo">Book a demo</a></p>
    </div>
    ${col("Product", [["How it works", "/product/"], ["Integrations", "/integrations/"], ["Team", "/team/"], ...(pricingVisible() ? [["Pricing", "/pricing/"] as [string, string]] : [])])}
    ${col("Company", [["About", "/about/"], ["Contact", "/contact/"], ["Security", "/security/"], ["Questions", "/faq/"]])}
    ${col("Legal", [["Privacy", "/privacy/"], ["Terms", "/terms/"], ["Cookies", "/cookies/"], ["Data deletion", "/data-deletion/"]])}
  </div>
  <div class="wrap foot__base"><p>© 2026 Allevia AI</p>${usingLogoDev() ? '<p><a href="https://logo.dev" rel="noopener">Logos provided by Logo.dev</a></p>' : ""}</div>
</footer>`;
}

/** Avatar chip for a roster agent. */
export const avatar = (id: string, cls = "av"): string => `<span class="${cls}" role="img" aria-label="${esc(AGENTS[id]?.name ?? id)}">${AGENTS[id]?.svg ?? ""}</span>`;

/** One tool chip: the logo and the name, in a pill. */
export function chip(id: string, name: string): string {
  return `<li class="chip">${logoMarkup(id, 26)}<span>${esc(name)}</span></li>`;
}

export { hasLogo, CHIP_ROWS };

export const SECTIONS: Record<string, (page: string) => string> = {
  ...TEAM_SECTIONS,
  ...HOME_SECTIONS,
  ...PAGE_SECTIONS,
  ...LEGAL_SECTIONS,
  "hero-a": () => heroA(),
  "product-diagram": () => productDiagram(),
  nav: (page) => nav(navItems().some((n) => n.id === page) ? page : "", "/"),
  footer: () => footer(),
};

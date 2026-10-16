// Shared pieces of the prototype pages, as HTML built at compile time (vite.config.ts swaps `<!-- @section name -->` for them).
// `page` says which prototype the page belongs to: "a" (the 3D brain), "b" (the calm diagram) or "team"/"shared" (pages both link to).
import { logoMarkup, hasLogo, usingLogoDev } from "./logos.ts";
import { AGENTS } from "./assets.generated.ts";
import { CHIP_ROWS } from "./data.ts";
import { TEAM_SECTIONS } from "./team-sections.ts";

import { esc } from "./util.ts";
import { heroA } from "./hero-sections.ts";
export { esc };

/** The pages of the site, in the order of the top bar. */
export const NAV: { label: string; href: string; id: string }[] = [
  { label: "Product", href: "/product/", id: "product" },
  { label: "Integrations", href: "/integrations/", id: "integrations" },
  { label: "Team", href: "/team/", id: "team" },
  { label: "Pricing", href: "/pricing/", id: "pricing" },
  { label: "Security", href: "/security/", id: "security" },
];

/** The top bar. `current` is the page id that gets aria-current; `home` is where the wordmark goes (the prototype's own home). */
export function nav(current: string, home: string): string {
  const links = NAV.map((n) => `<a href="${n.href}"${n.id === current ? ' aria-current="page"' : ""}>${esc(n.label)}</a>`).join("");
  return `<header class="nav" data-nav>
  <div class="wrap nav__in">
    <a class="brand" href="${home}" aria-label="Allevia, home">allevia</a>
    <nav class="nav__links" id="site-nav" aria-label="Main">${links}</nav>
    <a class="btn btn-gold btn-sm nav__cta" href="/contact/">Get a free Brain Snapshot</a>
    <button class="nav__menu" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="Menu" data-nav-menu><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 5.5h12M3 9h12M3 12.5h12"/></svg></button>
  </div>
</header>`;
}

/** The footer: the pages, the legal pages (which live on the real site and stay complete), and the one honest note. */
export function footer(): string {
  const pages = NAV.map((n) => `<a href="${n.href}">${esc(n.label)}</a>`).join("");
  return `<footer class="foot">
  <div class="wrap foot__in">
    <a class="brand" href="/" aria-label="Allevia">allevia</a>
    <div>
      <nav class="foot__links" aria-label="Footer">${pages}<a href="/faq/">Questions</a><a href="/contact/">Contact</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="/cookies/">Cookies</a></nav>
      <p class="foot__fine">The business shown on this site is Shiftly, a shift-jobs app. It is a sample: its data is made up.${usingLogoDev() ? ' <a href="https://logo.dev" rel="noopener">Logos provided by Logo.dev</a>.' : ""}</p>
    </div>
  </div>
</footer>`;
}

/** The pill that lets the founder move between the two prototypes (prototype chrome, not part of the site). */
export function switcher(page: string): string {
  const item = (id: string, label: string, href: string) => `<a href="${href}"${page === id ? ' aria-current="true"' : ""}>${label}</a>`;
  return `<aside class="proto-switch" aria-label="Prototype"><span>Prototype</span>${item("a", "A: 3D brain", "/a/")}${item("b", "B: calm diagram", "/b/")}</aside>`;
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
  "hero-a": () => heroA(),
  nav: (page) => nav(NAV.some((n) => n.id === page) ? page : "", page === "b" ? "/b/" : "/a/"),
  footer: () => footer(),
  switcher: (page) => switcher(page),
};

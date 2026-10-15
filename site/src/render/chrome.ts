// The masthead and the footer, shared by both pages. The site is served from the domain root, so links are absolute.
import { CONTACT_URL } from "../content.ts";

type Page = "home" | "pricing";

export function masthead(page: Page): string {
  const link = (href: string, label: string, current = false) =>
    `<li><a href="${href}"${current ? ` aria-current="page"` : ""}>${label}</a></li>`;
  return `<header class="mast">
  <div class="mast__in wrap">
    <a class="wordmark" href="/"${page === "home" ? ` aria-current="page"` : ""}><span class="visually-hidden">Allevia, home</span><span aria-hidden="true">allevia</span></a>
    <p class="mast__line">A done-for-you AI growth team for small businesses</p>
    <nav class="mast__nav" aria-label="Main">
      <ul>
        ${link("/#how", "How it works")}
        ${link("/#team", "The team")}
        ${link("/pricing/", "Pricing", page === "pricing")}
        ${link("/#questions", "Questions")}
      </ul>
    </nav>
    <a class="btn btn-gold mast__cta" href="${CONTACT_URL}">Get a Brain Snapshot</a>
  </div>
</header>`;
}

export function footer(): string {
  return `<footer class="foot">
  <div class="wrap foot__in">
    <p class="foot__letter">Allevia is built and supported by a small team in India, with Aamdani and AVS Atelier as its first businesses. The company brain behind every answer is a knowledge graph that runs on <a href="https://www.falkordb.com/" rel="noopener">FalkorDB</a>.</p>
    <p class="foot__sign" aria-hidden="true">allevia</p>
    <nav class="foot__nav" aria-label="Footer">
      <a href="/">Home</a>
      <a href="/pricing/">Pricing</a>
      <a href="/pricing/#basis">How we work out "1/20th"</a>
      <a href="${CONTACT_URL}">Get a Brain Snapshot</a>
    </nav>
    <p class="foot__fine">Prices exclude VAT and GST. Product screenshots are from the working product in October 2026; illustrations are drawn, not photographs.</p>
  </div>
</footer>`;
}


// The masthead and the footer, shared by every page. The site is served from the domain root, so links are absolute.
// Both are built from the page registry (src/pages.ts): a page in the registry with a `nav` label is in the masthead,
// one with a `footer` column is in the footer.
import { CONTACT_URL } from "../config.ts";
import { PAGES } from "../pages.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function masthead(current: string): string {
  const items = PAGES.filter((p) => p.nav)
    .map((p) => `<li><a href="${p.path}"${p.path === current ? ` aria-current="page"` : ""}>${esc(p.nav!)}</a></li>`)
    .join("\n        ");
  return `<header class="mast">
  <div class="mast__in wrap">
    <a class="wordmark" href="/"${current === "/" ? ` aria-current="page"` : ""}><span class="visually-hidden">Allevia, home</span><span aria-hidden="true">allevia</span></a>
    <p class="mast__line">We set it up. You steer.</p>
    <nav class="mast__nav" aria-label="Main">
      <ul>
        ${items}
      </ul>
    </nav>
    <a class="btn btn-gold mast__cta" href="${CONTACT_URL}">Get a free Brain Snapshot</a>
  </div>
</header>`;
}

export function footer(current: string): string {
  const col = (name: "Product" | "Company" | "Legal") => {
    const links = PAGES.filter((p) => p.footer === name)
      .map((p) => `<li><a href="${p.path}"${p.path === current ? ` aria-current="page"` : ""}>${esc(p.label ?? p.nav ?? p.title)}</a></li>`)
      .join("");
    return `<div class="foot__col"><h2 class="foot__h">${name}</h2><ul>${links}</ul></div>`;
  };
  return `<footer class="foot">
  <div class="wrap foot__in">
    <div class="foot__intro">
      <p class="foot__sign" aria-hidden="true">allevia</p>
      <p class="foot__letter">Allevia is built and supported by a small team in India, with Aamdani and AVS Atelier as its first two businesses. We set your team up; you steer it.</p>
    </div>
    <nav class="foot__cols" aria-label="Footer">
      ${col("Product")}
      ${col("Company")}
      ${col("Legal")}
    </nav>
    <p class="foot__fine">Prices exclude VAT and GST. Product screens are from the working product in October 2026, with sample numbers where they say so. Illustrations are drawn, not photographs.</p>
  </div>
</footer>`;
}

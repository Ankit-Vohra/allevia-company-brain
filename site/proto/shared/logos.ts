// Tool logos: the official mark of each tool, from the best source we have.
//   1. logo.dev, when LOGO_DEV_KEY is set (proto/env.ts reads it from the founder's env file; a publishable "pk_" key, never committed,
//      never the secret key). The tile points at logo.dev's picture for the tool's domain, hot-linked from its CDN: logo.dev's docs say
//      to "never host a logo file yourself" (storing logos is a paid Pro/Enterprise licence), and the free plan needs a visible
//      "Logos provided by Logo.dev" link on a public page (the footer has it). Exception: the tools in `siFirst` (every Google product,
//      Stripe, QuickBooks), where logo.dev returns the wrong or a generic mark; they keep step 2.
//   2. Simple Icons (CC0): the brand's own SVG path, drawn in its brand colour. Baked in by scripts/gen-assets.mts.
//   3. For the brands Simple Icons has removed (Slack, LinkedIn): the picture the app's own Your tools screen shows, where we have
//      one (Slack). LinkedIn has no logo until the logo.dev key arrives, so it is left out of the pictures that need one.
// Nothing here draws a logo by hand.
import { LOGOS, type Logo } from "./assets.generated.ts";

declare const __LOGO_DEV_KEY__: string | undefined;
const KEY: string = typeof process !== "undefined" && process.env ? (process.env.LOGO_DEV_KEY ?? "") : typeof __LOGO_DEV_KEY__ === "string" ? __LOGO_DEV_KEY__ : "";

export const usingLogoDev = (): boolean => KEY !== "";
export const logo = (id: string): Logo | undefined => LOGOS[id];
export const hasLogo = (id: string): boolean => {
  const l = LOGOS[id];
  return !!l && (usingLogoDev() || !!l.path || !!l.img);
};

/** The tool's logo as markup at `size` px (square). Empty string when there is none. */
export function logoMarkup(id: string, size = 28, eager = false): string {
  const l = LOGOS[id];
  if (!l) return "";
  const loading = eager ? "eager" : "lazy";
  if (KEY && !(l.siFirst && l.path)) return `<img class="logo" src="https://img.logo.dev/${l.domain}?token=${KEY}&amp;size=${size * 2}&amp;format=png&amp;retina=true" width="${size}" height="${size}" alt="" loading="${loading}" decoding="async" referrerpolicy="no-referrer">`;
  if (l.path) return `<svg class="logo" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path fill="${l.hex}" d="${l.path}"/></svg>`;
  if (l.img) return `<img class="logo" src="${l.img}" width="${size}" height="${size}" alt="" loading="${loading}" decoding="async">`;
  return "";
}

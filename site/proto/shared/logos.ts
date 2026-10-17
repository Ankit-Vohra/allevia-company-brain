// Tool logos: the official mark of each tool, from sources we may use and can host ourselves.
//   1. Simple Icons (CC0): the brand's own SVG path in its brand colour, baked into the page as inline SVG (no request, no credit needed, sharp at
//      any size). Baked in by scripts/gen-assets.mts.
//   2. For the brands Simple Icons has removed: Slack uses the picture the app's own Your tools screen shows (a local file, public/img/tool-slack.webp).
//      LinkedIn has no mark we may host yet, so it is left out of every list that draws logos (hasLogo is false for it).
//   3. logo.dev is off. It is used only when the build is run with ALLEVIA_SITE_LOGO_DEV=1 and a LOGO_DEV_KEY (proto/env.ts). That path hot-links
//      logo.dev's CDN and needs the visible "Logos provided by Logo.dev" credit (footer() adds it when the flag is on), so it is for tests, not for the site.
// Nothing here draws a logo by hand.
import { LOGOS, type Logo } from "./assets.generated.ts";

declare const __LOGO_DEV_KEY__: string | undefined;
const FLAG = typeof process !== "undefined" && process.env ? process.env.ALLEVIA_SITE_LOGO_DEV === "1" : true;
const KEY: string = !FLAG ? "" : typeof process !== "undefined" && process.env ? (process.env.LOGO_DEV_KEY ?? "") : typeof __LOGO_DEV_KEY__ === "string" ? __LOGO_DEV_KEY__ : "";

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

// Loads one value from the founder's env file for the prototypes' build, and only when asked: ALLEVIA_SITE_LOGO_DEV=1 (off by default).
// The value is LOGO_DEV_KEY, the publishable logo.dev key (meant for image URLs in a page). It reads that name only, never
// LOGO_DEV_SECRET_KEY or anything else, and refuses a value that is not a "pk_" key. The site does not use logo.dev unless this flag is set:
// logo.dev's free plan needs a visible credit on the page and bars hosting its files, so the shipped site draws every tool from Simple Icons (CC0).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

if (process.env.ALLEVIA_SITE_LOGO_DEV === "1" && !process.env.LOGO_DEV_KEY) {
  try {
    const text = readFileSync(`${homedir()}/.config/allevia/allevia.env`, "utf8");
    const m = text.match(/^[ \t]*(?:export[ \t]+)?LOGO_DEV_KEY[ \t]*=[ \t]*(.+?)[ \t]*$/m);
    const value = m?.[1]?.replace(/^["']|["']$/g, "") ?? "";
    if (/^pk_/.test(value)) process.env.LOGO_DEV_KEY = value;
  } catch { /* no env file: Simple Icons stay */ }
}

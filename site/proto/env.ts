// Loads exactly one value from the founder's env file for the prototypes' build: LOGO_DEV_KEY, the publishable logo.dev key (meant for
// image URLs in a page). It reads that name only, never LOGO_DEV_SECRET_KEY or anything else, and refuses a value that is not a "pk_" key.
// The key is never written to a file in the repo; it appears only in the HTML the build or dev server produces.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

if (!process.env.LOGO_DEV_KEY) {
  try {
    const text = readFileSync(`${homedir()}/.config/allevia/allevia.env`, "utf8");
    const m = text.match(/^[ \t]*(?:export[ \t]+)?LOGO_DEV_KEY[ \t]*=[ \t]*(.+?)[ \t]*$/m);
    const value = m?.[1]?.replace(/^["']|["']$/g, "") ?? "";
    if (/^pk_/.test(value)) process.env.LOGO_DEV_KEY = value;
  } catch { /* no env file: Simple Icons stay */ }
}

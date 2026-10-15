// Site-wide settings. Company facts (legal name, address, mailboxes) are in company.ts.

/** The public address of the site, no trailing slash. Canonical links, the sitemap and the social cards use it.
 *  TODO(founder): confirm the domain before publishing (no domain has been bought or registered by this repo). */
export const SITE_URL = "https://allevia-ai.in";

/** The address of the public, read-only demo of the real app (for example "https://demo.allevia-ai.in").
 *  Leave "" until the demo is hosted: every "Try the live demo" button is then hidden and the pages show the
 *  screenshots and the loop instead. The demo app sends X-Frame-Options, so it is linked, not embedded. */
export const DEMO_URL = "";

/** Where every "Get a free Brain Snapshot" button goes. */
export const CONTACT_URL = "/contact/";

/** The product's name and its one-line promise, used in the head, the structured data and the footer. */
export const SITE_NAME = "Allevia";
export const TAGLINE = "We set it up. You steer.";

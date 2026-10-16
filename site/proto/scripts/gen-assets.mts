// Bakes the data the prototypes need into site/proto/shared/assets.generated.ts (committed, small):
//   - LOGOS: each supported tool's official mark from Simple Icons (CC0): the SVG path and the brand colour. Slack and LinkedIn
//     were removed from Simple Icons; Slack falls back to the logo the app's own Your tools screen shows (a local picture),
//     LinkedIn has none until logo.dev (see shared/logos.ts).
//   - AVATARS: the team's head-and-shoulders portraits as inline SVG, drawn by the same code and palettes as the office sprites.
//   - BRAIN: the real graph of the sample business (demo_growth, "Shiftly"), reduced to five readable clusters, with the label of
//     every node the answers refer to.
//
//   node --experimental-strip-types site/proto/scripts/gen-assets.mts      (from the repo root; Node 24 needs no flag)
import { createServer } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as si from "simple-icons";

const SITE = fileURLToPath(new URL("../../", import.meta.url));
const OUT = fileURLToPath(new URL("../shared/assets.generated.ts", import.meta.url));

const server = await createServer({ root: SITE, configFile: false, appType: "custom", logLevel: "error", server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
const sprites = await server.ssrLoadModule("/src/render/sprites.ts");
const catalog = await server.ssrLoadModule(fileURLToPath(new URL("../../../shared/connection-map.ts", import.meta.url)));
const roster = await server.ssrLoadModule(fileURLToPath(new URL("../../../shared/roster.ts", import.meta.url)));

// ---------- logos ----------
// tool id (shared/connection-map.ts) -> Simple Icons export, and the domain logo.dev will be asked for
const SI: Record<string, { icon: string; domain: string }> = {
  gmail: { icon: "siGmail", domain: "gmail.com" },
  "google-calendar": { icon: "siGooglecalendar", domain: "calendar.google.com" },
  "google-analytics": { icon: "siGoogleanalytics", domain: "analytics.google.com" },
  "search-console": { icon: "siGooglesearchconsole", domain: "search.google.com" },
  "google-ads": { icon: "siGoogleads", domain: "ads.google.com" },
  instagram: { icon: "siInstagram", domain: "instagram.com" },
  "facebook-pages": { icon: "siFacebook", domain: "facebook.com" },
  "meta-ads": { icon: "siMeta", domain: "meta.com" },
  whatsapp: { icon: "siWhatsapp", domain: "whatsapp.com" },
  shopify: { icon: "siShopify", domain: "shopify.com" },
  stripe: { icon: "siStripe", domain: "stripe.com" },
  hubspot: { icon: "siHubspot", domain: "hubspot.com" },
  calendly: { icon: "siCalendly", domain: "calendly.com" },
  mailchimp: { icon: "siMailchimp", domain: "mailchimp.com" },
  linkedin: { icon: "", domain: "linkedin.com" },
  slack: { icon: "", domain: "slack.com" },
  zoho: { icon: "siZoho", domain: "zoho.com" },
  tiktok: { icon: "siTiktok", domain: "tiktok.com" },
  quickbooks: { icon: "siQuickbooks", domain: "quickbooks.intuit.com" },
  xero: { icon: "siXero", domain: "xero.com" },
  "google-sheets": { icon: "siGooglesheets", domain: "sheets.google.com" },
  github: { icon: "siGithub", domain: "github.com" },
  discord: { icon: "siDiscord", domain: "discord.com" },
};
// local pictures for brands Simple Icons no longer carries (the app's own rendering of the official mark)
const LOCAL: Record<string, string> = { slack: "/img/tool-slack.webp" };

const names = Object.fromEntries((catalog.TOOLKIT_CATALOG as { id: string; name: string }[]).map((e) => [e.id, e.name]));
names.github = "GitHub";
names.discord = "Discord";
const logos: Record<string, { name: string; domain: string; hex?: string; path?: string; img?: string }> = {};
for (const [id, m] of Object.entries(SI)) {
  const icon = m.icon ? (si as Record<string, { hex: string; path: string }>)[m.icon] : undefined;
  logos[id] = { name: names[id] ?? id, domain: m.domain, ...(icon ? { hex: `#${icon.hex}`, path: icon.path } : {}), ...(LOCAL[id] ? { img: LOCAL[id] } : {}) };
}

// ---------- avatars ----------
const TEAM = ["chief-of-staff", "data-analyst", "growth-marketer", "content-strategist", "sales-lead", "tech-lead", "oncall-engineer", "coe-lead", "qa-release", "librarian"];
const agents = Object.fromEntries(
  (roster.AGENTS as { id: string; name: string; title: string }[])
    .filter((a) => TEAM.includes(a.id))
    .map((a) => [a.id, { name: a.name, title: a.title, svg: sprites.spriteSvg(a.id, { size: 64, portrait: true }).replace(' class="sprite"', "").replace(/ width="\d+" height="\d+"/, "") }]),
);

// ---------- the brain: five clusters of the real graph ----------
const data = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/brain/brain-data.json", import.meta.url)), "utf8")) as {
  nodes: { id: string; type: string; label: string; labelled: boolean }[]; edges: { a: string; b: string }[]; counts: { nodes: number; edges: number };
};
const CLUSTER_OF = (n: { id: string; type: string }): string => {
  if (["Business", "Person", "Team", "Audience"].includes(n.type)) return "people";
  if (n.type === "Feature") return "signups";
  if (n.type === "Lead" || n.type === "Deal" || n.type === "Meeting") return "customers";
  if (n.type === "Campaign" || n.id === "channel:meta-ads" || n.id === "channel:google-search" || n.id === "channel:website" || n.id.startsWith("event:google-update")) return "reach";
  return "app";
};
const CLUSTER_LABEL: Record<string, string> = { people: "Your people", signups: "Sign-ups", app: "The app and releases", reach: "Ads and search", customers: "Customers" };
const clusters = Object.keys(CLUSTER_LABEL).map((id) => {
  const nodes = data.nodes.filter((n) => CLUSTER_OF(n) === id);
  const named = nodes.filter((n) => n.labelled).map((n) => n.label);
  return { id, label: CLUSTER_LABEL[id]!, count: nodes.length, sample: named.slice(0, 4) };
});
const labels = Object.fromEntries(data.nodes.map((n) => [n.id, n.label]));

const body = `// GENERATED by site/proto/scripts/gen-assets.mts. Do not edit by hand; run the script again.
// Logos: Simple Icons (CC0). Avatars: the office sprites' own code and palettes. Brain: the real graph of the sample business
// (demo_growth, Shiftly, made-up data) reduced to five clusters.
export interface Logo { name: string; domain: string; hex?: string; path?: string; img?: string }
export const LOGOS: Record<string, Logo> = ${JSON.stringify(logos, null, 1)};
export const AGENTS: Record<string, { name: string; title: string; svg: string }> = ${JSON.stringify(agents, null, 1)};
export const BRAIN = ${JSON.stringify({ counts: data.counts, clusters, labels }, null, 1)} as const;
`;
writeFileSync(OUT, body);
console.log("wrote", OUT, body.length, "bytes;", Object.keys(logos).length, "logos,", Object.keys(agents).length, "avatars,", clusters.map((c) => `${c.id}:${c.count}`).join(" "));
await server.close();

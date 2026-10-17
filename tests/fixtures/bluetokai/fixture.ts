// The coffee demo's offline fixtures: a small hand-made site in the shape of a specialty coffee roaster's online store (served
// locally, read by the real crawler without a browser), the model's canned answers for its pages, and Apify responses in the
// shapes the real actors return (google-places.json, instagram-profiles.json, ads.json). Nothing here is a recording of the live
// website or of Apify: the tests never call either (the live run happens on the server, docs/demo-bluetokai.md).
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Extraction } from "../../../src/ingest/extract.js";
import { FakePublicData } from "../../publicdata/fakes.js";

export const SITE_DIR = fileURLToPath(new URL("./site/", import.meta.url));
const APIFY_DIR = fileURLToPath(new URL("./apify/", import.meta.url));

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".txt": "text/plain", ".xml": "application/xml" };

export interface FixtureSite { origin: string; port: number; requests: string[]; close: () => Promise<void> }

export async function startCoffeeSite(): Promise<FixtureSite> {
  const requests: string[] = [];
  let origin = "";
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    requests.push(path);
    let file = normalize(join(SITE_DIR, decodeURIComponent(path)));
    if (!file.startsWith(SITE_DIR)) { res.writeHead(403); res.end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    else if (!extname(file) && existsSync(`${file.replace(/\/$/, "")}.html`)) file = `${file.replace(/\/$/, "")}.html`;
    if (!existsSync(file)) { res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>Not found</h1>"); return; }
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(req.method === "HEAD" ? undefined : readFileSync(file, "utf8").replaceAll("{{ORIGIN}}", origin));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  return { origin, port, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const json = (name: string, origin = "") => JSON.parse(readFileSync(join(APIFY_DIR, name), "utf8").replaceAll("{{ORIGIN}}", origin)) as Record<string, unknown>;

/** A public-data door answering from the Apify fixtures (no network, no spend), keyed the way the real lookups ask. */
export function coffeeApify(origin: string): FakePublicData {
  const places = json("google-places.json", origin).items as unknown[];
  const profiles = json("instagram-profiles.json").items as Array<{ username: string }>;
  const ads = json("ads.json") as { meta: Record<string, unknown[]>; google: Record<string, unknown[]> };
  return new FakePublicData({
    "compass/crawler-google-places": () => places,
    "apify/instagram-profile-scraper": (req) => profiles.filter((p) => ((req.input.usernames as string[]) ?? []).includes(p.username)),
    "apify/instagram-post-scraper": () => [],
    "apify/facebook-ads-scraper": (req) => {
      const url = String(((req.input.startUrls as Array<{ url: string }>) ?? [])[0]?.url ?? "");
      const q = new URL(url).searchParams.get("q") ?? "";
      return ads.meta[q] ?? [];
    },
    "s-r/google-ads-transparency": (req) => ads.google[String(((req.input.domains as string[]) ?? [])[0] ?? "")] ?? [],
  }, "2026-10-16T09:00:00.000Z");
}

/** What the model "reads" on each fixture page (the extraction step), by path. */
export const COFFEE_EXTRACTIONS: Record<string, Extraction> = {
  "/": {
    entities: [
      { type: "Business", name: "Fixture Roasters", summary: "A specialty coffee roaster that sells online, by subscription, in its cafés and wholesale." },
      { type: "Audience", name: "Home coffee drinkers", summary: "People who brew specialty coffee at home." },
      { type: "Product", name: "Coffee subscriptions", summary: "A fresh bag every two or four weeks." },
    ],
    relations: [],
    observations: [],
  },
  "/collections/coffee": {
    entities: [
      { type: "Product", name: "Estate Blend Medium Roast", summary: "A balanced medium roast, 250 g." },
      { type: "Product", name: "Dark Roast Espresso", summary: "A bold dark roast for espresso, 250 g." },
      { type: "Product", name: "Single Origin Light Roast", summary: "A bright light roast for pour-over, 250 g." },
      { type: "Product", name: "Cold Brew Bags", summary: "Ten bags for cold brew at home." },
    ],
    relations: [],
    observations: [],
  },
  "/pages/about": {
    entities: [
      { type: "Person", name: "Asha Verma", summary: "Co-founder (a fictional person in the test fixture)." },
      { type: "Person", name: "Kabir Nair", summary: "Co-founder (a fictional person in the test fixture)." },
    ],
    relations: [],
    observations: [],
  },
  "/pages/wholesale": {
    entities: [{ type: "Audience", name: "Cafés and offices", summary: "Businesses that buy coffee by the kilo." }],
    relations: [],
    observations: [],
  },
};

export const COFFEE_PROFILE = {
  summary: "Fixture Roasters roasts specialty coffee from Indian estates and sells it online, by subscription, in cafés and wholesale.",
  city: "New Delhi", country: "India", industry: "specialty coffee roaster", kind: "online_shop",
};

export const COFFEE_FACTS = { hours: [], priceRange: { text: "", evidence: "" }, items: [], address: { text: "", evidence: "" } };

export const COFFEE_BRAND = {
  tone: "Warm, knowledgeable and plain about coffee.", visualStyle: "Deep blue and cream, clean sans-serif headings.",
  voiceRules: ["Do talk about freshness and the estates.", "Don't use jargon a new coffee drinker would not know."], visualRules: ["Do keep the blue for buttons."],
};

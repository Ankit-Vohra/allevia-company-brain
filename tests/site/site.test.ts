// The public website: its page registry, head tags and structured data, the legal pages the platforms check, the pricing
// copy against shared/plans.ts, and a few things the site must never say (docs/owner-words.md and the founder's rules).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLANS } from "../../shared/plans.js";
import { COMPANY, COMMITMENTS, fact, mail, unresolved } from "../../site/src/company.js";
import { SITE_URL } from "../../site/src/config.js";
import { FAQ } from "../../site/src/content.js";
import { PAGES, pageFile } from "../../site/src/pages.js";
import { head, jsonLd } from "../../site/src/render/head.js";
import { dataDeletion, privacy, terms, cookies } from "../../site/src/render/legal.js";
import { plans, priceLine, startLine, securityPromises } from "../../site/src/render/blocks.js";

const SITE = new URL("../../site/", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(SITE, p), "utf8");

function htmlFiles(dir: string, base = ""): string[] {
  return readdirSync(join(dir, base)).flatMap((n) => {
    if (["node_modules", "dist", "public", "scripts", "src"].includes(n) && base === "") return [];
    const rel = join(base, n);
    return statSync(join(dir, rel)).isDirectory() ? htmlFiles(dir, rel) : rel.endsWith(".html") ? [rel] : [];
  });
}

describe("the page registry", () => {
  it("lists every page file, and every entry has a file", () => {
    const onDisk = htmlFiles(SITE).filter((f) => f !== "404.html").sort();
    const registered = PAGES.map((p) => pageFile(p.path)).sort();
    expect(registered).toEqual(onDisk);
  });

  it("has unique paths and titles, and titles and descriptions of a sensible length", () => {
    expect(new Set(PAGES.map((p) => p.path)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((p) => p.title)).size).toBe(PAGES.length);
    for (const p of PAGES) {
      expect(p.path, p.path).toMatch(/^\/(?:[a-z-]+\/)?$/);
      expect(p.title.length, `${p.path} title`).toBeLessThanOrEqual(62);
      expect(p.description.length, `${p.path} description`).toBeGreaterThanOrEqual(100);
      expect(p.description.length, `${p.path} description`).toBeLessThanOrEqual(175);
    }
  });

  it("has the stable public URLs Meta and Google ask for", () => {
    for (const path of ["/privacy/", "/terms/", "/data-deletion/", "/cookies/", "/contact/", "/security/", "/faq/", "/demo/", "/pricing/"]) {
      expect(PAGES.some((p) => p.path === path), path).toBe(true);
    }
  });

  it("gives each page one h1, a language, the head marker and the shared masthead and footer", () => {
    for (const p of PAGES) {
      const html = read(pageFile(p.path));
      expect(html, p.path).toContain('lang="en"');
      expect(html, p.path).toContain("<!-- @head -->");
      expect(html, p.path).toContain("<!-- @render masthead -->");
      expect(html, p.path).toContain("<!-- @render footer -->");
      if (!/privacy|terms|deletion|cookies/.test(p.path)) expect((html.match(/<h1[\s>]/g) ?? []).length, p.path).toBe(1);
    }
  });

  it("gives every image in the page sources an alt, a width and a height", () => {
    for (const p of PAGES) {
      for (const tag of read(pageFile(p.path)).match(/<img\b[^>]*>/g) ?? []) {
        expect(tag, `${p.path}: ${tag.slice(0, 80)}`).toMatch(/\salt="/);
        expect(tag, `${p.path}: ${tag.slice(0, 80)}`).toMatch(/\swidth="\d+"/);
        expect(tag, `${p.path}: ${tag.slice(0, 80)}`).toMatch(/\sheight="\d+"/);
      }
    }
  });
});

describe("the head of a page", () => {
  it("has a canonical link, Open Graph and Twitter tags with absolute image addresses", () => {
    for (const p of PAGES) {
      const h = head(p);
      expect(h).toContain(`<link rel="canonical" href="${SITE_URL}${p.path}" />`);
      expect(h).toContain(`<meta property="og:image" content="${SITE_URL}/img/og.jpg" />`);
      expect(h).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(h).toContain(`<meta property="og:url" content="${SITE_URL}${p.path}" />`);
      expect(h).toContain("<title>");
      expect(h).not.toMatch(/TODO/);
    }
  });

  it("has structured data that parses, with the organisation and the software on the home page", () => {
    const home = PAGES.find((p) => p.path === "/")!;
    const types = jsonLd(home).map((o) => (o as { "@type": string })["@type"]);
    expect(types).toEqual(expect.arrayContaining(["Organization", "WebSite", "SoftwareApplication"]));
    for (const p of PAGES) for (const m of head(p).matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)) expect(() => JSON.parse(m[1]!)).not.toThrow();
  });

  it("builds the software offers from shared/plans.ts, one per plan, in US dollars", () => {
    const sw = jsonLd(PAGES.find((p) => p.path === "/")!).find((o) => (o as { "@type": string })["@type"] === "SoftwareApplication") as { offers: { name: string; price: number; priceCurrency: string }[] };
    expect(sw.offers.map((o) => [o.name, o.price, o.priceCurrency])).toEqual(PLANS.map((p) => [p.name, p.price.monthly.USD, "USD"]));
  });

  it("leaves empty company facts out of the organisation record instead of printing TODOs", () => {
    const org = jsonLd(PAGES.find((p) => p.path === "/")!)[0] as Record<string, unknown>;
    if (!COMPANY.legalName) expect(org).not.toHaveProperty("legalName");
    if (!COMPANY.email.general && !COMPANY.email.support) expect(org).not.toHaveProperty("contactPoint");
    expect(JSON.stringify(org)).not.toMatch(/TODO/);
  });

  it("builds the FAQ structured data from the same questions as the page", () => {
    const faq = jsonLd(PAGES.find((p) => p.path === "/faq/")!).find((o) => (o as { "@type": string })["@type"] === "FAQPage") as { mainEntity: { name: string }[] };
    expect(faq.mainEntity.map((q) => q.name)).toEqual(FAQ.map((f) => f.q));
  });
});

describe("company facts that only the founder can supply", () => {
  it("show as a visible TODO(founder) mark while empty, and as text once filled", () => {
    expect(fact("", "the legal name")).toContain('<mark class="todo">TODO(founder): the legal name</mark>');
    expect(fact("Example Ltd", "x")).toBe("Example Ltd");
    expect(mail("", "the email")).toContain("TODO(founder)");
    expect(mail("hello@example.test", "x")).toContain('href="mailto:hello@example.test"');
    expect(fact("<b>", "x")).toBe("&lt;b&gt;");
  });

  it("are listed for the placeholder check", () => {
    expect(unresolved().length).toBeGreaterThan(0);
    for (const line of unresolved()) expect(line).toMatch(/^company\.ts /);
  });

  it("holds no real secret or personal identifier (a shipped value is empty or a public company fact)", () => {
    const json = JSON.stringify(COMPANY);
    // the only addresses allowed are public contact mailboxes at the product's own domain (printed on the legal pages)
    expect(json.replace(/[a-z0-9._-]+@allevia-ai\.in\b/gi, "")).not.toMatch(/@[a-z0-9-]+\.(com|in|io)\b/i);
    expect(json).not.toMatch(/\d{6,}/);
  });
});

describe("the legal pages say what the platforms check, and what the code does", () => {
  const priv = privacy();
  const tos = terms();
  const del = dataDeletion();

  it("carries the Google API limited-use statement, in Google's words", () => {
    expect(priv).toContain("Allevia's use and transfer to any other app of information received from Google APIs will adhere to the");
    expect(priv).toContain("Google API Services User Data Policy");
    expect(priv).toContain("Limited Use requirements");
    for (const scope of ["webmasters.readonly", "analytics.readonly", "business.manage"]) expect(priv).toContain(scope);
  });

  it("carries the Instagram data-use statement and points at the deletion instructions", () => {
    expect(priv).toContain("instagram_business_basic");
    expect(priv).toContain("instagram_business_manage_insights");
    expect(priv).toMatch(/do not sell Instagram data/);
    expect(priv).toContain('href="/data-deletion/"');
    expect(del).toContain("data deletion instructions for Meta");
    expect(del).toContain(`${SITE_URL}/data-deletion/`);
  });

  it("names the processors the code uses: the AI model, image generation, chat, hosting and payments", () => {
    for (const name of ["Anthropic", "Higgsfield", "Discord", "Apify"]) expect(priv).toContain(name);
    // public lookups: only public, business-level data, reviewers kept to a first name
    expect(priv).toMatch(/first name at most/);
    expect(priv).toMatch(/Never private accounts or private insights/);
    expect(priv).toContain(COMPANY.hosting.provider);
    expect(priv).toMatch(/payment provider/);
  });

  it("says how photos are handled: location removed, a per-business blur-faces setting, no AI edits for children, permission of people shown", () => {
    expect(priv).toMatch(/hidden details/);
    expect(priv).toContain("blur faces");
    expect(priv).toMatch(/AI edits to photos that appear to include children/);
    expect(tos).toContain("permission of anyone shown in what you upload and publish");
    expect(tos).toContain("consent to being shown");
    expect(tos).toMatch(/appear to include children/);
    expect(tos).toContain("simple clean-up only");
  });

  it("states the retention and deletion times from the commitments, and the way to export", () => {
    expect(priv).toContain(`${COMMITMENTS.deleteWithinDays} days`);
    expect(priv).toContain(`${COMMITMENTS.backupsAgeOutDays} days`);
    expect(del).toContain(`${COMMITMENTS.deleteWithinDays} days`);
    expect(priv).toMatch(/copy of the information we hold/);
  });

  it("does not promise anything the product does not do yet", () => {
    for (const html of [priv, tos, del, cookies()]) {
      expect(html).not.toMatch(/automatically delete|deleted automatically|auto-delete/i);
      expect(html).not.toMatch(/we (will )?(post|publish) (it |them )?for you/i);
    }
    expect(priv).toMatch(/being built/);
    expect(priv).toMatch(/do not delete photos automatically/);
  });

  it("the cookie note matches the code: no cookies, nothing stored in the browser", () => {
    const siteMain = read("src/main.ts");
    expect(siteMain).not.toMatch(/document\.cookie|localStorage|sessionStorage/);
    expect(cookies()).toContain("stores nothing in your browser".replace("stores nothing in your browser", "does not store any setting"));
    expect(read("index.html") + read("pricing/index.html")).not.toMatch(/googletagmanager|gtag\(|plausible|analytics\.js|facebook\.net|<script[^>]+src="https?:/i);
  });
});

describe("pricing copy follows shared/plans.ts, in US dollars only", () => {
  it("shows every plan's name and monthly price, and no other currency", () => {
    const html = plans();
    for (const p of PLANS) {
      expect(html).toContain(p.name);
      expect(html).toContain(`$${p.price.monthly.USD.toLocaleString("en-US")}`);
    }
    expect(html).not.toMatch(/data-(gbp|aed|aud)|£|AED|A\$|GBP|INR|₹/);
    expect(read("pricing/index.html")).not.toMatch(/currency/i);
  });

  it("the one-line price on the home page and the start line quote the growth plan and the three-month plan", () => {
    expect(priceLine()).toContain(`$${PLANS.find((p) => p.id === "growth")!.price.monthly.USD}`);
    expect(startLine()).toContain("$1,490");
  });

  it("the security page has four promises, each with an icon", () => {
    expect((securityPromises().match(/<li class="promise">/g) ?? []).length).toBe(4);
    expect((securityPromises().match(/<svg/g) ?? []).length).toBe(4);
  });
});

describe("the pages stay short", () => {
  const words = (html: string) => html.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").split(/\s+/).filter((w) => /\w/.test(w)).length;
  it("keeps the FAQ to six questions of at most two sentences", () => {
    expect(FAQ.length).toBeLessThanOrEqual(6);
    for (const f of FAQ) expect((f.a.match(/[.!?](\s|$)/g) ?? []).length, f.q).toBeLessThanOrEqual(2);
  });
  it("has no em dash in the copy an owner reads", () => {
    for (const p of PAGES) if (!/privacy|terms|deletion|cookies/.test(p.path)) expect(read(pageFile(p.path)), p.path).not.toContain("—");
    expect(JSON.stringify(FAQ)).not.toContain("—");
  });
});

describe("words and claims the site must not use", () => {
  const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const sources = PAGES.map((p) => read(pageFile(p.path))).join("\n") + code("src/content.ts") + code("src/render/pages-copy.ts");
  const text = sources.replace(/<[^>]+>/g, " ");

  it("keeps the owner's words: no Day 0, baseline or Allevia 90 in what an owner reads", () => {
    for (const bad of [/\bDay 0\b/, /\bbaseline\b/i, /Allevia 90/, /\bagents?\b/]) expect(text, String(bad)).not.toMatch(bad);
  });

  it("claims no certification it does not hold", () => {
    for (const m of text.matchAll(/.{0,14}SOC 2.{0,30}/g)) expect(m[0], m[0]).toMatch(/not SOC 2|not audited|until we are/);
    for (const m of text.matchAll(/.{0,12}guarantee (revenue|growth|results).{0,6}/gi)) expect(m[0], m[0]).toMatch(/not guarantee|never guarantee|guarantee growth\?/i);
  });

  it("never says Allevia posts, or that connections beyond the website are live", () => {
    expect(text).not.toMatch(/Allevia (posts|publishes) (to|for)/i);
    expect(text).not.toMatch(/auto-?post/i);
    expect(read("src/content.ts")).toMatch(/one business at a time|being built/);
  });

  it("shows no prices in other currencies anywhere on the site", () => {
    for (const p of PAGES) if (!/privacy|terms|deletion|cookies/.test(p.path)) expect(read(pageFile(p.path)), p.path).not.toMatch(/£|AED|A\$|₹/);
  });
});

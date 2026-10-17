// `onboard <url>`: the operator sets a business up from its website, exactly as the web app's Add a business does (the same
// onboard() and the same production dependencies, src/onboard/wiring.ts), with the progress printed as it happens. With
// APIFY_TOKEN set (pass it for this run only), onboarding reads the Google Maps listing (and a site that turns our reader away),
// and then the public Instagram numbers and the public ad libraries for the business and the --rival businesses are read once,
// quoted first and capped by --max-usd (src/onboard/operator.ts). Writes into ALLEVIA_FALKORDB_URL; nothing is posted or sent.
import { parseArgs } from "node:util";
import { openGraph } from "../graph/client.js";
import { getTenant } from "../graph/tenants.js";
import { isTenantSlug } from "../graph/slug.js";
import { onboard } from "../onboard/onboard.js";
import { nameFromUrl, parseRival, runOperatorOnboard, type OperatorArgs } from "../onboard/operator.js";
import type { Command } from "./_command.js";

const USAGE = 'onboard <url> [--slug <id>] [--name "<business>"] [--country <name>] [--industry <text>] [--vertical <text>] [--instagram <handle>] [--rival "Name|instagram|website"]... [--max-usd 1] [--no-extras] [--max-pages 40] [--model haiku] [--verbose] [--json]';

/** The command's arguments, checked; an Error says what is wrong. */
export function parseOnboardArgs(args: string[]): OperatorArgs {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      slug: { type: "string" }, name: { type: "string" }, country: { type: "string" }, currency: { type: "string" }, "time-zone": { type: "string" },
      industry: { type: "string" }, vertical: { type: "string" }, instagram: { type: "string" }, rival: { type: "string", multiple: true },
      "max-usd": { type: "string" }, "no-extras": { type: "boolean" }, "max-pages": { type: "string" }, model: { type: "string" },
      verbose: { type: "boolean" }, json: { type: "boolean" },
    },
  });
  const url = positionals[0];
  if (!url || positionals.length > 1) throw new Error(`Usage: npm run cli -- ${USAGE}`);
  if (values.slug !== undefined && !isTenantSlug(values.slug)) throw new Error(`--slug must be lowercase words joined by "_" (e.g. bluetokai), got "${values.slug}"`);
  const maxUsd = values["max-usd"] === undefined ? 1 : Number(values["max-usd"]);
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error(`--max-usd must be a number of dollars, got "${values["max-usd"]}"`);
  const maxPages = values["max-pages"] === undefined ? undefined : Number.parseInt(values["max-pages"], 10);
  if (maxPages !== undefined && !(maxPages > 0 && maxPages <= 200)) throw new Error(`--max-pages must be 1 to 200, got "${values["max-pages"]}"`);
  return {
    url, rivals: (values.rival ?? []).map(parseRival), extras: values["no-extras"] !== true, maxUsd, verbose: values.verbose === true, json: values.json === true,
    ...(values.slug ? { slug: values.slug } : {}), ...(values.name ? { name: values.name } : {}), ...(values.country ? { country: values.country } : {}),
    ...(values.currency ? { currency: values.currency } : {}), ...(values["time-zone"] ? { timeZone: values["time-zone"] } : {}),
    ...(values.industry ? { industry: values.industry } : {}), ...(values.vertical ? { vertical: values.vertical } : {}),
    ...(values.instagram ? { instagram: values.instagram } : {}), ...(maxPages ? { maxPages } : {}), ...(values.model ? { model: values.model } : {}),
  };
}

export const commands: Command[] = [
  {
    name: "onboard",
    usage: USAGE,
    summary: "Set a business up from its website, exactly as the web app does (crawl, brand, checks, goals; public data with APIFY_TOKEN), with progress printed",
    async run(args) {
      let a: OperatorArgs;
      try { a = parseOnboardArgs(args); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 2; }
      const name = a.name ?? nameFromUrl(a.url);
      let slug = a.slug;
      if (!slug) slug = (await import("../server/app.js")).slugFor(name, a.url);
      const had = await getTenant(slug);
      if (had && !a.slug) { console.error(`"${slug}" is already a business (${had.name}). Name it with --slug ${slug} to run its onboarding again.`); return 2; }
      const { productionOnboardDeps } = await import("../onboard/wiring.js");
      const deps = await productionOnboardDeps({ log: (line) => { if (a.verbose || !line.startsWith("[crawl]")) console.error(line); } });
      const { instagramPublic, adLibrary, competitorWatch } = await import("../agent/tools/publicdata.js");
      const run = await runOperatorOnboard(a, slug, {
        onboardFn: onboard,
        deps: { ...deps, ...(a.model ? { model: a.model } : {}), ...(a.maxPages ? { crawlOptions: { maxPages: a.maxPages } } : {}) },
        openGraph: (t) => openGraph(t), tools: { instagramPublic, adLibrary, competitorWatch },
        out: (l) => console.log(l),
      });
      const r = run.result;
      const summary = { ok: r.ok, tenant: slug, pages: r.pages, seoScore: r.seoScore, template: r.templateKey, counts: r.counts, errors: r.errors, report: r.reportPath, extras: run.extras };
      if (a.json) console.log(JSON.stringify(summary, null, 1));
      else {
        console.log(`\n${r.ok ? "Done" : "Stopped"}: ${slug}, ${r.pages} pages read${r.seoScore !== undefined ? `, website check ${r.seoScore}/100` : ""}${r.templateKey ? `, plan template ${r.templateKey}` : ""}.`);
        if (r.errors.length) console.log(`Notes: ${r.errors.join(" | ")}`);
        if (r.reportPath) console.log(`Run report: ${r.reportPath}`);
      }
      return r.ok ? 0 : 1;
    },
  },
];

// Adds a file to a business's brand library through the product's own upload path (the same code the web app's upload and a
// Discord drop use: checked by its bytes, metadata stripped, looked at by Claude on the subscription, filed per business).
//   npx tsx scripts/creative/upload-brand-file.ts --tenant aamdani --file path/to/logo.png [--note "our logo"] [--crop '{"y0":0.2}'] [--focus '{"x":0,"y":0.3,"w":1,"h":0.2}']
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { ingestBrandUpload } from "../../src/brand/upload.js";
import { loadConfig } from "../../src/config.js";
import { closeAll, openGraph } from "../../src/graph/client.js";
import { businessId } from "../../src/graph/tenants.js";
import { loadStudioContext } from "../../src/studio/context.js";
import { productionStudioDeps } from "../../src/studio/wiring.js";

const { values: a } = parseArgs({ options: { tenant: { type: "string" }, file: { type: "string", multiple: true }, note: { type: "string" }, crop: { type: "string" }, focus: { type: "string" } } });
if (!a.tenant || !a.file?.length) throw new Error("usage: --tenant slug --file path [--file path] [--note text]");
const g = await openGraph(a.tenant);
const deps = productionStudioDeps(loadConfig().dataDir);
const biz = businessId(a.tenant);
const owner = (await loadStudioContext(g, biz).catch(() => null))?.owner?.id;
for (const f of a.file) {
  const r = await ingestBrandUpload(g, { tenant: a.tenant, businessId: biz, bytes: readFileSync(f), filename: basename(f), source: "web", ...(a.note ? { note: a.note } : {}), ...(owner ? { ownerId: owner } : {}) },
    { store: deps.store, vision: deps.vision, now: Date.now() });
  console.log(basename(f), "->", r.route, r.kind, r.asset?.id ?? "", "|", r.message);
  // an app screen's crop (what part to show) and focus (what the words are about), as fractions: {"y0":0.2} / {"x":..,"y":..,"w":..,"h":..}
  if (r.asset && (a.crop || a.focus)) {
    await g.query("MATCH (b:Entity:BrandAsset {id:$id}) SET b.crop = $crop, b.focus = $focus", { id: r.asset.id, crop: a.crop ? JSON.stringify(JSON.parse(a.crop)) : null, focus: a.focus ? JSON.stringify(JSON.parse(a.focus)) : null });
    console.log("   crop/focus set");
  }
}
await closeAll();

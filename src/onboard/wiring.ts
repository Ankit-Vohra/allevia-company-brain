// The production dependencies of onboarding, in one place, so the web app's Add a business (src/server/app.ts) and the
// operator's `onboard <url>` command (src/cli/onboard.ts) run exactly the same onboarding: Claude on the subscription for
// reading the site, the brand library (logo and Google fonts, with vision), and public data through Apify when APIFY_TOKEN
// is set (a blocked site read another way, and the business's Google Maps listing), inside the public-data budget.
import { loadConfig } from "../config.js";
import type { OnboardDeps } from "./onboard.js";

export async function productionOnboardDeps(o: { signal?: AbortSignal; log: (line: string) => void }): Promise<OnboardDeps> {
  const { AgentSdkRunner } = await import("../ingest/llm.js");
  const { productionStudioDeps } = await import("../studio/wiring.js");
  const { productionPublicData } = await import("../publicdata/service.js");
  const cfg = loadConfig();
  const studio = productionStudioDeps(cfg.dataDir);
  return {
    runner: new AgentSdkRunner({ concurrency: 3 }), ...(o.signal ? { signal: o.signal } : {}), log: o.log,
    brand: { store: studio.store, vision: studio.vision, googleFonts: true },
    // public data (Apify): off without APIFY_TOKEN; with it, a blocked site and the Google listing, inside the budget
    publicData: productionPublicData(cfg),
  };
}

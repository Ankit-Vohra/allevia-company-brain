// The trial a new business starts on when an account sets it up (design section 1: 100 credits for 14 days, shared/plans.ts
// TRIAL). The one place that starts it, so the login work and the credits work can merge in either order:
//   - the credits: `grant(slug, TRIAL.credits, "trial", ref)` from src/credits/index.ts (the credits work). It is imported
//     when it is there; when it is not, the grant is skipped and said in the log, and nothing else fails;
//   - when the trial ends: `trialEndsAt` on the business's (:Tenant) in the registry, written here and nowhere else. The
//     subscription record (the subscription work, (:Subscription {status: "trial", trialEndsAt})) can take it from there.
// Starting a trial never fails the set-up: the business is ready either way, and the log says what is missing.
import { existsSync } from "node:fs";
import { openGraphByName } from "../graph/client.js";
import { metaName, type TenantOpts } from "../graph/tenants.js";
import { DAY_MS } from "./accounts.js";
import { TRIAL } from "../../shared/plans.js";

export type GrantFn = (slug: string, credits: number, reason: string, ref?: string) => Promise<unknown>;

export interface TrialOpts extends TenantOpts {
  now?: number;
  log?: (line: string) => void;
  /** The credits module's grant (tests pass a fake); default: src/credits/index.ts when it exists. */
  grant?: GrantFn | null;
}

export interface TrialStarted { credits: number; trialEndsAt: number; granted: boolean }

// src/credits/index.ts (or the built .js), when the credits work is on this branch; null when it is not.
export async function loadGrant(): Promise<GrantFn | null> {
  const base = new URL("../credits/", import.meta.url);
  const url = ["index.ts", "index.js"].map((n) => new URL(n, base)).find((u) => existsSync(u));
  if (!url) return null;
  const mod = (await import(url.href)) as { grant?: unknown };
  return typeof mod.grant === "function" ? (mod.grant as GrantFn) : null;
}

export async function startTrial(slug: string, by: string, o: TrialOpts = {}): Promise<TrialStarted> {
  const log = o.log ?? ((line: string) => console.error(line));
  const now = o.now ?? Date.now();
  const meta = await openGraphByName(metaName(o));
  // a business that already has a trial end keeps it: running this twice does not move the end
  const rows = await meta.query<{ trialEndsAt: number }>(
    "MATCH (t:Tenant {slug:$slug}) SET t.trialEndsAt = coalesce(t.trialEndsAt, $trialEndsAt), t.trialStartedBy = coalesce(t.trialStartedBy, $by) RETURN t.trialEndsAt AS trialEndsAt",
    { slug, trialEndsAt: now + TRIAL.days * DAY_MS, by });
  const trialEndsAt = rows[0]?.trialEndsAt ?? now + TRIAL.days * DAY_MS;
  let granted = false;
  try {
    const grant = o.grant === undefined ? await loadGrant() : o.grant;
    if (grant) {
      await grant(slug, TRIAL.credits, "trial", `trial:${slug}`);
      granted = true;
    } else log(`[trial] ${slug}: the credits module (src/credits) is not installed, so the ${TRIAL.credits} trial credits were not granted`);
  } catch (e) {
    log(`[trial] ${slug}: granting the ${TRIAL.credits} trial credits failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { credits: TRIAL.credits, trialEndsAt, granted };
}

// The trial a new business starts on when an account sets it up (design section 1: 100 credits for 14 days, shared/plans.ts
// TRIAL). The one place the login work starts it:
//   - the credits and the trial's end: `grant(slug, TRIAL.credits, "trial", userId)` from the credits work (src/credits), which
//     writes the trial subscription with its trialEndsAt and the 100 credits, once per business. The server passes its own
//     ledger (app.ts); otherwise src/credits/index.ts is imported when it is there;
//   - without it (the module missing, or the grant failing), the trial's end is still recorded, as `trialEndsAt` on the
//     business's (:Tenant) in the registry, and the log says the credits were not granted.
// Starting a trial never fails the set-up: the business is ready either way.
import { existsSync } from "node:fs";
import { openGraphByName } from "../graph/client.js";
import { metaName, type TenantOpts } from "../graph/tenants.js";
import { DAY_MS } from "./accounts.js";
import { TRIAL } from "../../shared/plans.js";

export type GrantFn = (slug: string, credits: number, reason: string, ref: string) => Promise<unknown>;

export interface TrialOpts extends TenantOpts {
  now?: number;
  log?: (line: string) => void;
  /** The credits ledger's grant (the server's own, or a test's); null: none. Default: src/credits/index.ts when it exists. */
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

export async function startTrial(slug: string, userId: string, o: TrialOpts = {}): Promise<TrialStarted> {
  const log = o.log ?? ((line: string) => console.error(line));
  const now = o.now ?? Date.now();
  const trialEndsAt = now + TRIAL.days * DAY_MS;
  let why = "";
  try {
    const grant = o.grant === undefined ? await loadGrant() : o.grant;
    if (grant) {
      await grant(slug, TRIAL.credits, "trial", userId);
      return { credits: TRIAL.credits, trialEndsAt, granted: true };
    }
    why = `the credits module (src/credits) is not installed, so the ${TRIAL.credits} trial credits were not granted`;
  } catch (e) {
    why = `granting the ${TRIAL.credits} trial credits failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  log(`[trial] ${slug}: ${why}; the trial's end is kept on the business`);
  // a business that already has a trial end keeps it: running this twice does not move the end
  const meta = await openGraphByName(metaName(o));
  const rows = await meta.query<{ trialEndsAt: number }>(
    "MATCH (t:Tenant {slug:$slug}) SET t.trialEndsAt = coalesce(t.trialEndsAt, $trialEndsAt), t.trialStartedBy = coalesce(t.trialStartedBy, $by) RETURN t.trialEndsAt AS trialEndsAt",
    { slug, trialEndsAt, by: userId });
  return { credits: TRIAL.credits, trialEndsAt: rows[0]?.trialEndsAt ?? trialEndsAt, granted: false };
}

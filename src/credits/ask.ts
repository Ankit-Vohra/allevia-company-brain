// A question's credits, the same on every surface (the web's POST /api/:t/ask, Discord, both through here):
//   - before any work starts, one credit is checked and held (OutOfCredits, a 402 on the web, when there is none);
//   - when the answer arrives it is charged: 1 when one person answered (the runtime's fast path), 5 when the team worked
//     on it (CREDIT_PRICES question_quick / question_deep), linked -[:FOR]-> the Turn;
//   - a lookup of public data (Apify) that really ran during the answer adds "Rivals and public data" (5) once; a lookup
//     that would not fit in what is left is not run, and the answer says so;
//   - a failed or stopped answer costs nothing.
// Work the team does on its own (the stand-up, Today's note, a schedule) does not come through here, so it is free.
import { CREDIT_PRICES } from "../../shared/plans.js";
import { ask, type AskDeps, type AskInput, type AskResult } from "../agent/ask.js";
import type { Emit } from "../agent/runtime.js";
import type { GraphHandle } from "../graph/client.js";
import type { PublicDataPort } from "../publicdata/service.js";
import type { Credits, Hold } from "./index.js";

export const PUBLIC_DATA_OUT = "Looking up public data uses 5 credits, and there aren't enough left this month, so nothing was looked up.";

export interface QuestionCharge {
  /** The ask deps with the public-data door metered. */
  deps(d: AskDeps): AskDeps;
  /** Charges the answer (or lets the held credit go when it failed). Never throws: a charge that fails is logged. */
  settle(r: AskResult | undefined): Promise<void>;
}

/** Checks and holds the credit a question needs; throws OutOfCredits before any work when there is none. */
export async function beginQuestion(o: { credits: Credits; tenant: string; by: string; g?: GraphHandle; log?: (line: string) => void }): Promise<QuestionCharge> {
  const at = o.g ? { g: o.g } : {};
  const hold: Hold = await o.credits.hold(o.tenant, "question_quick", at);
  let lookups = 0;
  const meter = (pd: PublicDataPort): PublicDataPort => ({
    get enabled() { return pd.enabled; },
    quote: (actor, units) => pd.quote(actor, units),
    budget: (tenant) => pd.budget(tenant),
    run: async (req) => {
      // the first fresh lookup of the answer needs its 5 credits on top of the one the question holds
      if (lookups === 0) {
        const c = await o.credits.check(o.tenant, "public_data", at).catch(() => null);
        // (what check() says is left already counts the credit this question holds)
        if (c && c.left < CREDIT_PRICES.public_data.credits) return { ok: false, reason: "credits", why: PUBLIC_DATA_OUT };
      }
      const r = await pd.run(req);
      if (r.ok) lookups++;
      return r;
    },
  });
  const log = o.log ?? ((l: string) => console.error(l));
  return {
    deps: (d) => (d.publicData ? { ...d, publicData: meter(d.publicData) } : d),
    settle: async (r) => {
      if (!r?.ok) { hold.release(); return; }
      const deep = r.outcome ? !r.outcome.fastPath : r.agents.length > 1;
      try {
        await hold.commit({ service: deep ? "question_deep" : "question_quick", ref: r.turnId, by: o.by, for: [r.turnId] });
        if (lookups > 0) await o.credits.spend(o.tenant, "public_data", { ...at, ref: r.turnId, by: o.by, for: [r.turnId], allowNegative: true });
      } catch (e) {
        log(`[credits] ${o.tenant}: the answer ${r.turnId} was not charged: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/** ask() with its credits: Discord's bots call this where the web route uses beginQuestion around its live turn. */
export async function chargedAsk(input: AskInput, deps: AskDeps, emit: Emit, o: { credits: Credits; g?: GraphHandle; by?: string; log?: (line: string) => void }): Promise<AskResult> {
  const q = await beginQuestion({ credits: o.credits, tenant: input.tenant, by: o.by ?? input.asker ?? "person:founder", ...(o.g ? { g: o.g } : {}), ...(o.log ? { log: o.log } : {}) });
  let r: AskResult | undefined;
  try {
    r = await ask(input, q.deps(deps), emit);
    return r;
  } finally {
    await q.settle(r);
  }
}

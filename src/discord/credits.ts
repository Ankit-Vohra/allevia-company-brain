// Out of credits on Discord: the same sentence the web app shows, with its two buttons as links to the plan page ("Buy 100
// credits", "Move to Growth"), where the owner says yes. Discord's questions, OKs and /checkup go through the same credit
// code as the web app (src/credits), so they are charged the same way.
import { PLAN_BY_ID } from "../../shared/plans.js";
import { OutOfCredits } from "../credits/index.js";
import type { LinkSpec } from "./bot.js";

export function outOfCreditsMessage(e: OutOfCredits, webBase: string): { content: string; links: LinkSpec[] } {
  const base = webBase.replace(/\/+$/, "");
  const next = e.info.nextPlan;
  return {
    content: e.message,
    links: [
      { label: "Buy 100 credits", url: `${base}/plan?buy=${encodeURIComponent(e.info.packId)}` },
      ...(next ? [{ label: `Move to ${PLAN_BY_ID[next].name}`, url: `${base}/plan?plan=${next}` }] : []),
    ],
  };
}

export const isOutOfCredits = (e: unknown): e is OutOfCredits => e instanceof OutOfCredits;

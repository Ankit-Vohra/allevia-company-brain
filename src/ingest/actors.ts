// Actors every vault source refers to. The founder is one Person node shared by all mappers (same id, same props, so
// writing it from several sources is a no-op). Allevia's own AI staff use the reserved ids `agent:allevia-<id>` and
// `team:allevia-<id>` (shared/roster.ts); a vault must never be able to create or overwrite one of them.
import type { NodeInput } from "../graph/upsert.js";
import { entityId } from "../util/ids.js";

export const FOUNDER_ID = entityId("Person", "founder");

export function founderNode(): NodeInput {
  return { type: "Person", id: FOUNDER_ID, name: "Founder", props: { role: "founder" } };
}

const RESERVED = /^(?:agent|team):allevia-/;
export const isReservedId = (id: string): boolean => RESERVED.test(id);

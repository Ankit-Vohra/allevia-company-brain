// Privacy for the ops mappers. The tools already read PII-free views; on top of that, personal-looking fields are
// dropped before mapping, free text (captions, search queries) is redacted with redact() from src/ingest/privacy.ts (the
// one redaction engine, spec 6.3), and PENDING items under sensitive headings are not even counted.

import { SENSITIVE } from "../../privacy.js";

// Spec §6.3's section policy: a heading like this marks content that never enters the graph. The same pattern as the
// vault's section and path policy (one definition, in src/ingest/privacy.ts).
export const SENSITIVE_SECTION = SENSITIVE;

// Keys that name a person or a way to reach one. Contact keys are dropped when they hold text (a count such as
// `phoneVerified` stays); id and name keys are dropped whatever they hold.
const CONTACT_KEY = /phone|e-?mail|whatsapp|msisdn/i;
const PERSON_ID_KEY = /^(user|person|candidate|employer|seeker|customer|reviewer|member|owner|author)_?id$/i;
const PERSON_NAME_KEY = /^(first|last|full|display|person|user|contact|candidate|reviewer|customer|seeker|author)_?name$|^(reviewer|author)$/i;

export function stripPersonalFields(v: unknown): { value: unknown; dropped: number } {
  let dropped = 0;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== "object") return x;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
      const texty = typeof val === "string" || (Array.isArray(val) && val.some((y) => typeof y === "string"));
      if ((CONTACT_KEY.test(k) && texty) || PERSON_ID_KEY.test(k) || PERSON_NAME_KEY.test(k)) {
        dropped++;
        continue;
      }
      out[k] = walk(val);
    }
    return out;
  };
  return { value: walk(v), dropped };
}

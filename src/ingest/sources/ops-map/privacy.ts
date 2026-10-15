// Privacy for the ops mappers. The tools already read PII-free views; on top of that, personal-looking fields are
// dropped before mapping, free text (captions, search queries) is redacted, and PENDING items under sensitive headings
// are not even counted.
//
// TODO(privacy): switch redactText to redact() from src/ingest/privacy.ts once Task 2.1 lands. Until then, a local copy
// of the spec §6.3 redaction list. `keep` = how many leading capture groups survive (the label before a value:
// "FOO_TOKEN=", "Team ID ").
interface Redaction { kind: string; re: RegExp; keep?: number; when?: (match: string) => boolean }
const vowelShare = (w: string) => (w.match(/[aeiou]/g)?.length ?? 0) / w.length;
const REDACTIONS: Redaction[] = [
  { kind: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  { kind: "token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|EAA[A-Za-z0-9]{20,})\b/g },
  { kind: "secret", re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)[^\s"'`]+/g, keep: 1 },
  { kind: "secret-path", re: /[^\s"'`()]*aamdani-secrets[^\s"'`()]*|~\/\.config\/[^\s"'`()]+|\/home\/[^\s"'`()]*secrets[^\s"'`()]*/g },
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: "aws-id", re: /\b(?:i|sg|vpc|subnet|eni|ami|vol|snap|eice)-[0-9a-f]{8,17}\b|\barn:aws:[^\s"']+/g },
  { kind: "ipv4", re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g },
  { kind: "cin", re: /\b[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b/g },
  { kind: "duns", re: /(D-?U-?N-?S\b[^0-9\n]{0,24})\d{9}\b/gi, keep: 1 },
  { kind: "team-id", re: /(Team\s?ID[^A-Za-z0-9\n]{0,4})[A-Z0-9]{10}\b/g, keep: 1 },
  // A Supabase project ref is 20 random lowercase letters; a 20-letter English word has far more vowels.
  { kind: "supabase-ref", re: /\b[a-z]{20}\b/g, when: (w) => vowelShare(w) <= 0.35 },
  // +91 98765 43210, 098765-43210, 9876543210, and other +<country> numbers of 8-15 digits.
  { kind: "phone", re: /(?<![\w+])(?:(?:\+|00)?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)|(?<![\w+])\+\d{1,3}[\s-]?\d(?:[\s-]?\d){6,13}(?!\d)/g },
];

export function redactText(s: string): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let text = s;
  for (const { kind, re, keep = 0, when } of REDACTIONS) {
    text = text.replace(re, (match: string, ...groups: unknown[]) => {
      if (when && !when(match)) return match;
      counts[kind] = (counts[kind] ?? 0) + 1;
      return `${groups.slice(0, keep).join("")}[redacted:${kind}]`;
    });
  }
  return { text, counts };
}

// Spec §6.3's section policy: a heading like this marks content that never enters the graph.
export const SENSITIVE_SECTION = /security|audit|access|secret|credential|incident|backup|password|token|ssh|aws|server|infra|finance|bank|kyc/i;

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

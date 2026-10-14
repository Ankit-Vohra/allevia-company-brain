// Redaction engine (spec 6.3, layer 3). Every string that reaches the graph or an LLM goes through `redact`: anything
// that looks like infrastructure, a credential, a contact detail or a company identifier becomes `[redacted:<kind>]`.
// The same detectors back `findSensitive`, which the graph scan (privacy.ts) uses to prove nothing slipped through.
//
// Design rules:
// - Rules run in a fixed order, most specific first, and replace text with a placeholder that no rule matches again,
//   so redact(redact(x)) === redact(x) and a rule never re-reports another rule's work.
// - Context rules (D-U-N-S, Team ID, Supabase refs, "NAME=value") keep their label and redact only the value.
// - When unsure we prefer to redact: a lost word costs little, a leaked key costs a lot. The negative tests in
//   tests/ingest/redact.test.ts pin down what must NOT be touched (dates, counts, versions, money, issue refs, URLs).

export const REDACTION_KINDS = [
  "ipv4", "aws-id", "email", "phone", "secret", "url-credentials", "secret-path", "cin", "duns", "apple-team-id", "supabase-ref",
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

export interface Hit { kind: RedactionKind; match: string }

type Report = (kind: RedactionKind, match: string) => void;
type Rule = (text: string, report: Report) => string;

const ph = (kind: RedactionKind): string => `[redacted:${kind}]`;
const PLACEHOLDER_START = "[redacted:";

// A rule that replaces every match of `re` (optionally filtered by `keep`) with the placeholder.
function simple(kind: RedactionKind, re: RegExp, keep?: (m: string, offset: number, whole: string) => boolean): Rule {
  return (text, report) => text.replace(re, (m: string, ...rest: unknown[]) => {
    const whole = rest[rest.length - 1] as string;
    const offset = rest[rest.length - 2] as number;
    if (keep?.(m, offset, whole)) return m;
    report(kind, m);
    return ph(kind);
  });
}

// Like `simple`, but leaves trailing sentence punctuation outside the placeholder ("see ~/x/y.txt." keeps its dot).
function trimmed(kind: RedactionKind, re: RegExp): Rule {
  return (text, report) => text.replace(re, (m: string) => {
    const core = m.replace(/[.,;:!?]+$/, "");
    report(kind, core);
    return ph(kind) + m.slice(core.length);
  });
}

// ---------- rules ----------

const privateKeyBlock = simple("secret",
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g);

// scheme://user:pass@host/... : the whole URL goes (the host after the @ is as revealing as the password).
const urlCredentials = simple("url-credentials", /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/?#]{1,100}:[^\s@/]{0,200}@[^\s<>"'`)\]]*/gi);

const discordWebhook = simple("secret", /https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/gi);

// Quantifiers here are bounded and greedy runs start at a token boundary, so hostile input (a 200 KB "word", a
// million slashes) cannot make the engine backtrack quadratically.
const PATH_TAIL = "[^\\s`'\"<>)\\]]*";
const PATH_BOUNDED = "[^\\s`'\"<>)\\]]{0,300}";
const secretPaths: Rule[] = [
  // anything under a home directory with "secret" in it: ~/Documents/acme-secrets/x, ~/.acme-secrets/x, /home/u/…/secrets/…
  trimmed("secret-path", new RegExp(`(?:~|\\/Users\\/[\\w.-]{1,40}|\\/home\\/[\\w.-]{1,40})\\/${PATH_BOUNDED}secret${PATH_BOUNDED}`, "gi")),
  trimmed("secret-path", new RegExp(`~\\/\\.config\\/${PATH_TAIL}`, "g")),
  trimmed("secret-path", new RegExp(`~\\/\\.ssh\\/${PATH_TAIL}`, "g")),
  trimmed("secret-path", new RegExp(`(?<![\\w~./-])(?:~|\\/)?(?:[\\w.-]{1,60}\\/){1,15}[\\w.-]{0,60}\\.env\\b`, "g")),
  simple("secret-path", /(?<![\w~./-])[\w~./-]{0,200}\.(?:pem|p12|pfx)\b/g),
];

const FILE_TLDS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "css", "js", "ts", "tsx", "json", "md", "yaml", "yml"]);
// A service-account address cut off before its TLD ("search-sync@demo-project.") still names the cloud project.
const truncatedEmail = simple("email", /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z][A-Za-z0-9]{0,30}(?:-[A-Za-z0-9]{1,30}){1,6}\.(?![A-Za-z0-9])/g);
const email = simple("email", /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,10}[A-Za-z]{2,24}\b/g,
  (m) => FILE_TLDS.has(m.slice(m.lastIndexOf(".") + 1).toLowerCase())); // icon@2x.png is a retina image, not a mailbox

const awsIds: Rule[] = [
  simple("aws-id", /\bs3:\/\/[\w.-]+(?:\/[^\s`'"<>)\],;]*)?/g), // bucket names carry account numbers and reveal the backup layout
  simple("aws-id", /\barn:aws[a-z-]*:[A-Za-z0-9-]*:[A-Za-z0-9-]*:\d*:[^\s`'"<>)\],;]+/g),
  simple("aws-id", /\b(?:i|sg|vpc|subnet|ami|eni|vol|snap|rtb|igw|nat|acl|eipalloc|eipassoc|pcx|tgw|lt)-(?=[0-9a-f]{0,16}\d)[0-9a-f]{8,17}\b/g),
  (text, report) => text.replace(/\b(account(?:\s+(?:id|number))?)([\s:=#`'"*]*)(\d{12})\b/gi,
    (_m, label: string, sep: string, digits: string) => { report("aws-id", digits); return `${label}${sep}${ph("aws-id")}`; }),
];

// Credential shapes. Anchored on distinctive prefixes, so ordinary words are safe.
const secretShapes: Rule[] = [
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\brzp_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\beyJ[A-Za-z0-9_-]{30,}/g,
  /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}\b/g, // Discord bot token: id.timestamp.hmac
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bsbp_[A-Za-z0-9]{20,}\b/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/g,
  /\bEAA[A-Za-z0-9]{40,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
].map((re) => simple("secret", re));

// NAME=value where NAME says it is a secret (FOO_TOKEN, db_password, authToken). Keeps the name, redacts the value.
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)$|(?:^|_)(?:key|token|secret|password|pass|pwd)$|[a-z0-9](?:Key|Token|Secret|Password|Pass|Pwd)$/;
const PLACEHOLDER_VALUE = /^(?:\*+|[xX]+|\.{2,}|…|<[^<>]*>|\[[^[\]]*\]|\{[^{}]*\})$/; // KEY=***, KEY=<token>, KEY=[YOUR-KEY]
const envAssignment: Rule = (text, report) =>
  text.replace(/\b([A-Za-z][A-Za-z0-9_]*)([ \t]*=[ \t]*)("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s,;)"'`&]+)/g,
    (m: string, name: string, eq: string, value: string) => {
      if (!SECRET_NAME.test(name)) return m;
      const quoted = /^["'`]/.test(value);
      const tail = quoted ? "" : /[.,:;!?]+$/.exec(value)?.[0] ?? ""; // sentence punctuation after an unquoted value stays
      const inner = quoted ? value.slice(1, -1) : value.slice(0, value.length - tail.length);
      if (inner === "" || inner.startsWith("$") || inner.startsWith(PLACEHOLDER_START) || PLACEHOLDER_VALUE.test(inner)) return m; // empty, a shell reference, already redacted, or a doc placeholder
      report("secret", inner);
      return `${name}${eq}${ph("secret")}${tail}`;
    });

const cin = simple("cin", /\b[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b/g);

// "D-U-N-S number 123456789": label stays, the number goes. The label must be close, so a stray 9-digit number elsewhere survives.
const duns: Rule = (text, report) =>
  text.replace(/\b(D-U-N-S|DUNS)\b([^0-9\n]{0,14}?)(\d{9}|\d{2}-\d{3}-\d{4})\b/gi,
    (_m, label: string, gap: string, num: string) => { report("duns", num); return `${label}${gap}${ph("duns")}`; });

// "Team ID ABCDE12345": 10 upper-case alphanumerics right after the label (the id part is case-sensitive so a word like
// "registered" after "Team ID" is never taken for one).
const appleTeamId: Rule = (text, report) =>
  text.replace(/\b([Tt][Ee][Aa][Mm][ \t]*[Ii][Dd])\b((?:[^A-Za-z0-9\n]{1,10}|[ \t]+is[ \t]+))([A-Z0-9]{10})\b/g,
    (_m, label: string, gap: string, id: string) => { report("apple-team-id", id); return `${label}${gap}${ph("apple-team-id")}`; });

// Supabase project refs are 20 lowercase letters. Unambiguous in a host or a pooler user; elsewhere they count only
// near the word "supabase" / "project ref" on the same line, and only if the letters look random (few vowels), so a
// 20-letter English word such as "internationalization" is left alone.
const VOWELS = /[aeiou]/g;
const supabaseRefs: Rule[] = [
  (text, report) => text.replace(/\b([a-z]{20})(\.supabase\.(?:co|com|in|net)\b)/g,
    (_m, ref: string, rest: string) => { report("supabase-ref", ref); return ph("supabase-ref") + rest; }),
  (text, report) => text.replace(/\b(postgres\.)([a-z]{20})\b/g,
    (_m, pre: string, ref: string) => { report("supabase-ref", ref); return pre + ph("supabase-ref"); }),
  (text, report) => text.replace(/(?<![A-Za-z0-9_-])[a-z]{20}(?![A-Za-z0-9_-])/g, (m: string, offset: number) => {
    const before = text.slice(Math.max(0, offset - 120), offset);
    const after = text.slice(offset + m.length, offset + m.length + 60);
    const window = before.slice(before.lastIndexOf("\n") + 1) + after.split("\n", 1)[0]; // same line only
    if (!/supabase|project[-_ ]?ref/i.test(window)) return m;
    if ((m.match(VOWELS)?.length ?? 0) > 8) return m;
    report("supabase-ref", m);
    return ph("supabase-ref");
  }),
];

const ipv4 = simple("ipv4",
  /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)/g);

// Phones: any "+CC …" number with 8-15 digits, and Indian mobiles (10 digits starting 6-9, optional 0 / 91 prefix).
// Dates, counts, versions, money and ids never look like either.
const phones: Rule[] = [
  simple("phone", /(?<![\w+])\+\d{1,3}(?:[ \t().-]*\d){7,14}\b/g),
  simple("phone", /(?<![\w.+-])(?:0|91[ -]?)?[6-9]\d{4}[ -]?\d{5}(?![\w-]|\.\d)/g),
];

// Long random-looking tokens (>= 32 chars): API keys and secrets in shapes no specific rule knows. Slugs, paths, UUIDs,
// identifiers made of words, plain numbers and single words without digits are not random-looking.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_CONTEXT = /(?:commit|sha-?\d*|hash|checksum|digest|rev|merge|head|tag|@)[\s:=`"'(@]*$/i;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

function looksRandom(tok: string, before: string): boolean {
  const t = tok.replace(/=+$/, "");
  if (t.length < 32 || UUID.test(t)) return false;
  const words = t.split(/[-_/+]/).filter((p) => /^[a-z]{3,}$/.test(p) && /[aeiouy]/.test(p)).length;
  if (words >= 2) return false;                                  // slug, path or identifier built from words
  const hasDigit = /\d/.test(t);
  const hasLetter = /[A-Za-z]/.test(t);
  if (!hasDigit || !hasLetter) return false;                     // a word or a number, not a key
  if (/^[0-9a-fA-F]+$/.test(t)) {
    if ((t.length === 40 || t.length === 64) && HASH_CONTEXT.test(before)) return false; // a labelled git/sha256 digest
    return entropy(t) >= 3;
  }
  if (/^[A-Za-z_-]+\d+$/.test(t)) return false;                  // identifier with a numeric suffix
  return entropy(t) >= 3.8;
}

const longRandom: Rule = (text, report) =>
  text.replace(/(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g, (m: string, offset: number) => {
    if (!looksRandom(m, text.slice(Math.max(0, offset - 24), offset))) return m;
    report("secret", m);
    return ph("secret");
  });

const RULES: Rule[] = [
  privateKeyBlock, urlCredentials, discordWebhook, ...secretPaths, email, truncatedEmail, ...awsIds, ...secretShapes, envAssignment,
  cin, duns, appleTeamId, ...supabaseRefs, ipv4, ...phones, longRandom,
];

function run(text: string): { text: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const report: Report = (kind, match) => hits.push({ kind, match });
  let out = text;
  for (const rule of RULES) out = rule(out, report);
  return { text: out, hits };
}

export function redact(text: string): { text: string; counts: Record<string, number> } {
  const { text: out, hits } = run(text);
  const counts: Record<string, number> = {};
  for (const h of hits) counts[h.kind] = (counts[h.kind] ?? 0) + 1;
  return { text: out, counts };
}

// What `redact` would remove from `text`, with the raw matches. Used by the graph scan; callers must not log the matches.
export function findSensitive(text: string): Hit[] {
  return run(text).hits;
}

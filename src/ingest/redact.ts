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
// - Every rule must stay linear on hostile input. Two habits keep it so: quantifiers are bounded, and a rule whose run
//   class contains "-", "." or "/" starts at a lookbehind like (?<![A-Za-z0-9_-]), never at \b (\b also matches after
//   each "-", so "eyJ-eyJ-eyJ-…" restarted a full scan at every dash). tests/ingest/redact.test.ts probes each rule.

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
// The URL is the credential: anyone who has it can post to the channel.
const slackWebhook = simple("secret", /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[\w/-]{1,200}/gi);

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
// "@" may arrive URL-encoded (?email=a%40b.co, mailto: links).
const truncatedEmail = simple("email", /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}(?:@|%40)[A-Za-z][A-Za-z0-9]{0,30}(?:-[A-Za-z0-9]{1,30}){1,6}\.(?![A-Za-z0-9])/g);
const email = simple("email", /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}(?:@|%40)(?:[A-Za-z0-9-]{1,63}\.){1,10}[A-Za-z]{2,24}\b/g,
  (m) => FILE_TLDS.has(m.slice(m.lastIndexOf(".") + 1).toLowerCase())); // icon@2x.png is a retina image, not a mailbox

const awsIds: Rule[] = [
  simple("aws-id", /\bs3:\/\/[\w.-]+(?:\/[^\s`'"<>)\],;]*)?/g), // bucket names carry account numbers and reveal the backup layout
  simple("aws-id", /\barn:aws[a-z-]*:[A-Za-z0-9-]*:[A-Za-z0-9-]*:\d*:[^\s`'"<>)\],;]+/g),
  simple("aws-id", /\b(?:i|sg|vpc|subnet|ami|eni|vol|snap|rtb|igw|nat|acl|eipalloc|eipassoc|pcx|tgw|lt)-(?=[0-9a-f]{0,16}\d)[0-9a-f]{8,17}\b/g),
  (text, report) => text.replace(/\b(account(?:\s+(?:id|number))?)([\s:=#`'"*]*)(\d{12})\b/gi,
    (_m, label: string, sep: string, digits: string) => { report("aws-id", digits); return `${label}${sep}${ph("aws-id")}`; }),
];

// Credential shapes. Anchored on distinctive prefixes, so ordinary words are safe.
const SECRET_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\brzp_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // lookbehind, not \b: see the header
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{30,}/g,
  /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}\b/g, // Discord bot token: id.timestamp.hmac
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bsbp_[A-Za-z0-9]{20,}\b/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/g,
  /\bEAA[A-Za-z0-9]{40,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
];
const secretShapes: Rule[] = SECRET_SHAPES.map((re) => simple("secret", re));

// A credential that a hard-wrapped line broke in two ("ghp_a1B2\nc3D4…"). When the part before the break is too short
// for its shape (under ten characters) nothing above would match it, so: a shape prefix at a token start, up to three
// continuation lines, and the joined text must be a complete credential while the first part alone is not. If the first
// part is already complete it is redacted by its own rule and absorbTail takes care of what follows.
const SHAPE_PREFIX = "(?:gh[pousr]_|github_pat_|sk-|[sr]k_(?:live|test)_|rzp_(?:live|test)_|AKIA|ASIA|xox[abprs]-|xapp-|eyJ|AIza|sbp_|sb_(?:secret|publishable)_|EAA|hf_|npm_|ya29\\.)";
const WRAPPED = new RegExp(`(?<![A-Za-z0-9_-])${SHAPE_PREFIX}[A-Za-z0-9_.-]{0,60}(?:[ \\t]*\\r?\\n[ \\t]*[A-Za-z0-9_.-]{1,200}){1,3}(?![A-Za-z0-9_.-])`, "g");
const WHOLE_SHAPES = SECRET_SHAPES.map((re) => new RegExp(`^(?:${re.source})$`));
const isShape = (t: string): boolean => WHOLE_SHAPES.some((re) => re.test(t));
const wrappedSecret: Rule = (text, report) =>
  text.replace(WRAPPED, (m: string) => {
    const parts = m.split(/[ \t]*\r?\n[ \t]*/);
    if (isShape(parts[0]!) || !isShape(parts.join(""))) return m;
    report("secret", m);
    return ph("secret");
  });

// "Authorization: Bearer <token>". Prose such as "Bearer authentication" is left alone: the value needs a digit, or to be
// a long mixed-case run.
const tokenShaped = (v: string): boolean => v.length >= 8 && (/\d/.test(v) || (v.length >= 20 && /[a-z]/.test(v) && /[A-Z]/.test(v)));
const bearer: Rule = (text, report) =>
  text.replace(/\b(Bearer[ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi, (m: string, label: string, value: string) => {
    if (!tokenShaped(value)) return m;
    report("secret", value);
    return `${label}${ph("secret")}`;
  });

// NAME=value, NAME: value, "name": "value" where NAME says it is a secret (FOO_TOKEN, db_password, authToken, password).
// Keeps the name, redacts the value. The key may be quoted and wrapped in bold; `:` may be followed by a closing `**`.
// `=` takes any bare value. `:` is ordinary prose far more often ("Key: we only post at 18:00", "**Webhook secret:** run
// the script"), so after a colon a bare value must start with a letter or digit, must not be a filler word, and for the
// weak names (a bare key/pass) must contain a digit. Quoted values always count, except an ALL_CAPS_SNAKE word, which is
// the name of an environment variable ("Token: `IG_ACCESS_TOKEN` in the env file"), not a value.
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD)$|(?:^|_)(?:key|token|secret|password|passwd|pass|pwd)$|[a-z0-9](?:Key|Token|Secret|Password|Passwd|Pass|Pwd)$/;
const BARE_NAME = /^(?:key|token|secret|password|passwd|pass|pwd)$/i; // "Password: …" and "KEY=…" in any case; "bypass" and "monkey" are not names
const WEAK_NAME = /^(?:key|pass)$/i;
const ENV_VAR_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const FILLER = /^(?:none|n\/?a|na|tbd|todo|unknown|empty|blank|the|an?|is|are|in|on|at|to|run|see|use|set|via|from|same|stored|kept|lives|expires|rotate|rotated|never|not|needed|required|yes|no)$/i;
const PLACEHOLDER_VALUE = /^(?:\*+|[xX]+|\.{2,}|…|<[^<>]*>|\[[^[\]]*\]|\{[^{}]*\})$/; // KEY=***, KEY=<token>, KEY=[YOUR-KEY]
const envAssignment: Rule = (text, report) =>
  text.replace(/(?<![A-Za-z0-9_])(["']?)([A-Za-z][A-Za-z0-9_]*)\1((?:\*\*|__)?[ \t]*)(:|=)((?:\*\*|__)?[ \t]*)("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s,;)"'`&]+)/g,
    (m: string, q: string, name: string, _pre: string, sep: string, gap: string, value: string) => {
      if (!SECRET_NAME.test(name) && !BARE_NAME.test(name)) return m;
      const quoted = /^["'`]/.test(value);
      const tail = quoted ? "" : /[.,:;!?]+$/.exec(value)?.[0] ?? ""; // sentence punctuation after an unquoted value stays
      const inner = quoted ? value.slice(1, -1) : value.slice(0, value.length - tail.length);
      if (inner === "" || inner.startsWith("$") || inner.startsWith("<") || inner.startsWith(PLACEHOLDER_START) || PLACEHOLDER_VALUE.test(inner)) return m; // empty, a shell reference, already redacted, or a doc placeholder
      if (sep === ":" && ENV_VAR_NAME.test(inner)) return m;
      if (sep === ":" && !quoted) {
        if (!/^[A-Za-z0-9]/.test(inner) || FILLER.test(inner)) return m;
        if (WEAK_NAME.test(name) && !(inner.length >= 6 && /\d/.test(inner))) return m;
      }
      report("secret", inner);
      return m.slice(0, m.length - value.length) + ph("secret") + tail;
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

// A version number often has the shape of an address: "iOS 18.1.1.2", "Chrome/120.0.0.0", "version 10.2.3.4".
const VERSION_LABEL = /(?:\b(?:i?os|ipados|tvos|watchos|macos|android|version|ver|build|release|rev|node|python|java|chrome|chromium|safari|firefox|edge|opera|webkit|mozilla|api|sdk)\b[ \t.:=/-]{0,3}|\bv)$/i;
const ipv4 = simple("ipv4",
  /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)/g,
  (_m, offset, whole) => VERSION_LABEL.test(whole.slice(Math.max(0, offset - 16), offset)));

// Phones: any "+CC …" number with 8-15 digits, and Indian mobiles (10 digits starting 6-9, optional 0 / 91 prefix).
// Dates, counts, versions, money and ids never look like either.
// A bare ten-digit number right after a label is an order, ticket or tracking number, a view count or an id: not a phone.
const NUMBER_LABEL = /(?:\b(?:orders?|ids?|ref|tracking|track|awb|views?|invoice|ticket|case|uid)\b|#)[ \t:#.-]{0,4}(?:(?:no|num|number)\b[ \t:#.-]{0,4})?$/i;
const phones: Rule[] = [
  simple("phone", /(?<![\w+])\+\d{1,3}(?:[ \t().-]*\d){7,14}\b/g),
  simple("phone", /(?<![\w.+-])(?:0|91[ -]?)?[6-9]\d{4}[ -]?\d{5}(?![\w-]|\.\d)/g,
    (_m, offset, whole) => NUMBER_LABEL.test(whole.slice(Math.max(0, offset - 24), offset))),
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

// What a hard-wrapped line leaves behind: "[redacted:secret]" then a newline and the rest of the credential. A random-looking
// run (eight or more characters, a letter and a digit, and either mixed case or hex only) at the start of the next line
// goes with it, up to three lines. Ordinary next lines survive: words, dates, plain numbers, "week12plan".
const randomTail = (t: string): boolean =>
  /\d/.test(t) && /[A-Za-z]/.test(t) && ((/[a-z]/.test(t) && /[A-Z]/.test(t)) || /^[0-9a-f]+$/i.test(t));
const TAIL = /(\[redacted:secret\])[ \t]*\r?\n[ \t]*([A-Za-z0-9_+/=-]{8,})(?![A-Za-z0-9_+/=-])/;
const absorbTail: Rule = (text) => {
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(new RegExp(TAIL.source, "g"), (m: string, label: string, tok: string) => (randomTail(tok) ? label : m));
    if (next === out) break;
    out = next;
  }
  return out;
};

const RULES: Rule[] = [
  privateKeyBlock, urlCredentials, discordWebhook, slackWebhook, ...secretPaths, email, truncatedEmail, ...awsIds, wrappedSecret, ...secretShapes,
  bearer, envAssignment, cin, duns, appleTeamId, ...supabaseRefs, ipv4, ...phones, longRandom, absorbTail,
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

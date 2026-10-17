// The privacy filter for what the owner and the team write in chat. Ingest redacts everything it reads before it reaches the graph
// (privacy.ts: paths, sections, redact); this does the same for the nodes a chat turn writes, so a key pasted into a question, a phone
// number said in a note or an address typed into an instruction never reaches the business's graph:
//   - the Turn, its Findings and the Session title (agent/memory.ts), and the log of events saved with the Turn;
//   - what `remember` keeps, and what `propose_action` proposes (agent/tools);
//   - the made things (a poster, a reel script) and the cards waiting for the owner's OK (creative/);
//   - the owner's standing instructions (settings/directives.ts).
// The detectors are the ones ingest uses (redact.ts), so what the graph scan (`scanGraph`) would flag is what is taken out here, and
// the graph scan of a business that only chatted comes back empty.
//
// What it touches: the words (a node's name and summary, every text prop, the text inside a JSON prop such as a card's payload or a
// Turn's event log). What it leaves alone: identity props (`id`, `src`, `of`), digests and content addresses, numbers, vectors.
// `Removed` counts what was taken out, by kind and never the value, so a tool can say so ("I took out a phone number") and a node
// can carry how many were removed.
import type { EdgeInput, NodeInput, Prim } from "../graph/upsert.js";
import { isDigestProp } from "./privacy.js";
import { redact } from "./redact.js";

const IDENTITY_PROPS = new Set(["id", "src", "of"]);

// What each kind of private detail is called to an owner (singular, plural), in the order a sentence lists them.
const WORDS: Record<string, [string, string]> = {
  phone: ["a phone number", "phone numbers"],
  email: ["an email address", "email addresses"],
  secret: ["a key or password", "keys or passwords"],
  "url-credentials": ["a login inside a web address", "logins inside web addresses"],
  "secret-path": ["a private file location", "private file locations"],
  ipv4: ["an IP address", "IP addresses"],
  "aws-id": ["a cloud account detail", "cloud account details"],
  cin: ["a company registration number", "company registration numbers"],
  duns: ["a company registration number", "company registration numbers"],
  "apple-team-id": ["a developer account id", "developer account ids"],
  "supabase-ref": ["a database project id", "database project ids"],
};
const ORDER = Object.keys(WORDS);

/** What was taken out of what a call was given: how many of each kind (never the values). */
export class Removed {
  readonly byKind: Record<string, number> = {};

  add(counts: Record<string, number>): void {
    for (const [kind, n] of Object.entries(counts)) this.byKind[kind] = (this.byKind[kind] ?? 0) + n;
  }

  get total(): number {
    return Object.values(this.byKind).reduce((a, b) => a + b, 0);
  }

  /** "2 phone numbers and an email address", in an owner's words ("" when nothing was removed). */
  words(): string {
    const rank = (kind: string): number => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length);
    const parts = Object.entries(this.byKind).filter(([, n]) => n > 0).sort(([a], [b]) => rank(a) - rank(b)).map(([kind, n]) => {
      const [one, many] = WORDS[kind] ?? ["a private detail", "private details"];
      return n === 1 ? one : `${n} ${many}`;
    });
    return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  }

  /** The sentence a tool or a card note says when something was taken out ("" when nothing was). */
  note(): string {
    return this.total ? `Private details were taken out before saving (${this.words()}); where they were it says [redacted:...].` : "";
  }
}

/** Text with its private details replaced by `[redacted:<kind>]`. */
export function cleanText(text: string, removed?: Removed): string {
  const r = redact(text);
  if (r.text !== text) removed?.add(r.counts);
  return r.text;
}

const looksLikeJson = (s: string): boolean => (s.startsWith("{") || s.startsWith("[")) && s.length > 1;

// A key that may name a secret ("password", "api_key", "authToken"): only these are checked together with their value.
const SECRET_KEY = /key|token|secret|pass|pwd/i;

/**
 * One text under its JSON key. The text is cleaned on its own; then, when the key may name a secret, the pair is shown to the detectors
 * as `"key": "value"`, the way they read it in a config file, so `{"password": "hunter2"}` goes although "hunter2" alone is just a word.
 */
function cleanUnder(key: string | undefined, text: string, removed: Removed | undefined): string {
  const own = new Removed();
  const out = cleanText(text, own);
  removed?.add(own.byKind);
  if (key === undefined || !SECRET_KEY.test(key) || out === "[redacted:secret]") return out;
  const pair = `${JSON.stringify(key)}: ${JSON.stringify(out)}`;
  if (redact(pair).text !== `${JSON.stringify(key)}: [redacted:secret]`) return out;
  removed?.add({ secret: 1 });
  return "[redacted:secret]";
}

function walk(v: unknown, removed: Removed | undefined, key?: string): unknown {
  if (typeof v === "string") return cleanUnder(key, v, removed);
  if (Array.isArray(v)) return v.map((x) => walk(x, removed, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, removed, k)]));
  return v;
}

/**
 * The same for JSON text (a card's payload, a Turn's event log): every string in it is cleaned, key names kept where the detectors
 * need them (see cleanUnder), and the JSON is written back whole. JSON with nothing to take out is returned byte for byte; text that
 * is not JSON is cleaned as text.
 */
export function cleanJson(json: string, removed?: Removed): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return cleanText(json, removed);
  }
  const mine = new Removed();
  const out = JSON.stringify(walk(parsed, mine));
  if (!mine.total) return json;
  removed?.add(mine.byKind);
  return out;
}

function isJson(s: string): boolean {
  if (!looksLikeJson(s)) return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

function cleanProp(prop: string, value: Prim, removed: Removed | undefined): Prim {
  if (IDENTITY_PROPS.has(prop) || isDigestProp(prop, value)) return value;
  if (typeof value === "string") return isJson(value) ? cleanJson(value, removed) : cleanText(value, removed);
  if (Array.isArray(value) && value.length && typeof value[0] === "string") return (value as string[]).map((s) => cleanText(s, removed));
  return value;
}

/** A node's props with every text cleaned. */
export function cleanProps(props: Record<string, Prim>, removed?: Removed): Record<string, Prim> {
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, cleanProp(k, v, removed)]));
}

/** A node to write, with its name, summary and every text prop cleaned. Ids, digests, numbers and the embedding stay as they are. */
export function cleanNode(n: NodeInput, removed?: Removed): NodeInput {
  return {
    ...n,
    name: cleanText(n.name, removed),
    ...(n.summary !== undefined ? { summary: cleanText(n.summary, removed) } : {}),
    ...(n.props ? { props: cleanProps(n.props, removed) } : {}),
  };
}

/** An edge to write, with the text in its props cleaned. */
export function cleanEdge(e: EdgeInput, removed?: Removed): EdgeInput {
  return e.props ? { ...e, props: cleanProps(e.props, removed) } : e;
}

/**
 * What an action card carries for the executor to do its job, not words for anyone to read: who an email goes to, who is invited, the
 * arguments of a connected tool, the account a post goes to, the label that says where. Cleaning these would break the action (an
 * email to `[redacted:email]` goes nowhere), so a payload's cleaning leaves them as they are; the words around them are cleaned.
 */
export const FUNCTIONAL_PAYLOAD_KEYS: readonly string[] = ["to", "cc", "bcc", "attendees", "args", "target", "publish", "connection", "tool"];

/** An action card's payload (the object a tool was given), with the words in it cleaned and the keys the executor needs left alone. */
export function cleanPayload<T extends Record<string, unknown>>(value: T, removed?: Removed, keep: readonly string[] = FUNCTIONAL_PAYLOAD_KEYS): T {
  const words = Object.fromEntries(Object.entries(value ?? {}).filter(([k]) => !keep.includes(k)));
  const text = JSON.stringify(words);
  const cleaned = cleanJson(text, removed);
  if (cleaned === text) return value;
  const clean = JSON.parse(cleaned) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keep.includes(k) ? v : clean[k]])) as T;
}

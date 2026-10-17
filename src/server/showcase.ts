// A showcase: a real business (its data from the owner's own inbox, files and customers) that the public may look at
// (`auth:demo <slug> --showcase`, graph/tenants.ts setShowcase). Its owner and members see everything. A visitor gets every
// answer of every /api/<slug>/... route through one filter, here, applied in app.ts after the route has run, so no page
// can forget it:
//
//   hidden or masked                                         kept
//   - people's names, emails and phone numbers               - numbers and their trends, insights, Today's note
//   - customers (Client) and leads: "a customer", "a lead"   - the brain map's shape, with masked labels on people and messages
//   - messages and meetings: subjects, bodies, recipients    - goals, the website check, public posts and their drafts, ads data
//   - the recipients, subject and text of email and meeting  - the answer paths (their nodes masked the same way)
//     cards waiting for an OK
//   - documents from private sources (inbox, uploaded files, the owner's notes) and every passage (Chunk) of a document
//
// How: an index of what is private in the business's graph (every Person, Lead, Client, Deal, Meeting and Message, and every
// Document from a private source), read once a minute with GRAPH.RO_QUERY. Then the JSON (or each event of a stream) is walked:
//   - a node reference to a private thing gets a masked id ("lead:hidden-3f2a9c0d1e4b", the same within a server run, so the
//     map's links and a tap on a node still work: resolveShowcaseId turns it back) and a placeholder name; its summary goes;
//   - a node's card of a private thing keeps only plain facts (stage, status, value, dates), nothing written by a person;
//   - every string has emails and phone numbers taken out, ids of private things masked, and the names and subjects of
//     private things replaced by "a lead", "a customer", "someone", "a message" (whole names case-insensitively, single
//     first or last names only where capitalised, so "will" stays a verb);
//   - keys that hold contact details (email, phone, cc, guests, ...) are dropped wherever they are;
//   - search drops private things altogether (a visitor cannot test whether a person is a customer);
//   - a tool call's raw arguments are dropped (its step stays), and a stream's typing (`text` events) is dropped: the final
//     answer arrives whole in `final`, scrubbed as one piece, so a name cannot slip through split across two deltas.
// The business's own name and website are not a person's and are never masked.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { AGENTS, DEPARTMENTS } from "../../shared/roster.js";
import { MAX_PAGE, type GraphHandle } from "../graph/client.js";
import { typeOfLabels } from "../graph/schema.js";

export type PrivateKind = "person" | "lead" | "customer" | "deal" | "meeting" | "message" | "document";

const PLACEHOLDER: Record<PrivateKind, { ref: string; text: string }> = {
  person: { ref: "Someone", text: "someone" },
  lead: { ref: "A lead", text: "a lead" },
  customer: { ref: "A customer", text: "a customer" },
  deal: { ref: "A deal", text: "a deal" },
  meeting: { ref: "A meeting", text: "a meeting" },
  message: { ref: "A message", text: "a message" },
  document: { ref: "A private document", text: "a private document" },
};

const LABEL_KIND: Record<string, PrivateKind> = {
  Person: "person", Lead: "lead", Client: "customer", Deal: "deal", Meeting: "meeting", Message: "message", Chunk: "document",
};
// id prefixes (util/ids.ts idPrefix) that always name a private thing
const PREFIX_KIND: Record<string, PrivateKind> = {
  person: "person", lead: "lead", client: "customer", deal: "deal", meeting: "meeting", message: "message", chunk: "document",
};

// Documents from a private source: the owner's uploads and typed instructions, the inbox, and the owner's own notes (the vault:
// notes, decisions, the pending list, agent notes, readmes; a report or registry file only when it came from the vault, which
// gives it a `path`). The website crawl, the check-ups, connected numbers, playbooks and Today's note are public or the team's own.
const PRIVATE_DOC_KINDS = new Set(["upload", "directive", "email", "message", "inbox", "gmail", "mail", "vault", "note", "decision", "pending", "agent", "readme"]);
const VAULT_DOC_KINDS = new Set(["report", "registry"]);

/** Props a private thing's card keeps: plain facts, nothing a person wrote. */
const SAFE_PROPS = new Set([
  "stage", "status", "value", "currency", "direction", "channel", "source", "kind", "createdAt", "updatedAt", "asOf", "openedAt",
  "lastActivityAt", "needsReply", "start", "end", "simulated", "rank", "community",
]);
/** Keys holding contact details or a message's routing: dropped wherever they are. */
const DROP_KEYS = new Set([
  "email", "emails", "phone", "phones", "mobile", "whatsapp", "cc", "bcc", "guests", "attendees", "recipient", "recipients", "sender",
  "replyTo", "externalId", "threadId", "calendarEventId",
]);

const MESSAGE_CARD_KINDS = new Set(["email_send", "calendar_event"]);
export const HIDDEN_TEXT = "The text is private on this public view.";
const EMAIL_HIDDEN = "(email hidden)";
const PHONE_HIDDEN = "(phone hidden)";
const SUBJECT_HIDDEN = "(subject hidden)";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// a run of digits with the usual separators; kept only when it has 9 to 15 digits and is not a date or a time
const PHONE_RE = /(?<![\w:/.#-])\+?\(?\d[\d\s().-]{7,}\d(?![\w-])/g;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$|^\d{4}\s?-\s?\d{4}$/;
const ID_RE = /(?<![\p{L}\p{N}_-])(person|lead|client|deal|meeting|message|chunk|document):[\p{L}\p{N}\p{M}._@/-]+/gu;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’]*/gu;
const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}\p{M}]/u.test(ch);

// Words never masked as a first or last name: the team's own names (The Chief, Techie ...), the office dogs, and words a name list
// picks up from a website ("Team", "Support").
const NEVER_NAMES = new Set([
  ...AGENTS.map((a) => a.name), ...DEPARTMENTS.map((d) => d.name), "Fluffy", "JJ", "Zoe",
  "Team", "Support", "Sales", "Admin", "Info", "Hello", "Contact", "Customer", "Client", "Owner", "Founder", "Manager", "The", "And",
  "Mr", "Mrs", "Ms", "Dr", "Sir", "Madam", "Hi", "Dear", "Re", "Fwd", "Fw",
]);

const SECRET = randomBytes(16);

interface Term { lower: string; text: string }

export class ShowcaseIndex {
  readonly kinds = new Map<string, PrivateKind>();      // real id -> kind, for everything private the index read
  private readonly unmasked = new Map<string, string>(); // masked id -> real id
  private readonly terms = new Map<string, Term[]>();    // first word (lower case) -> whole names and subjects, longest first
  private readonly tokens = new Map<string, string>();   // a capitalised first or last name -> its placeholder
  private readonly keep = new Set<string>();             // words of the business's own name and website
  private readonly own: string;                          // the business's own name

  constructor(business: { name?: string; domain?: string } = {}) {
    this.own = (business.name ?? "").trim().toLowerCase();
    for (const w of `${business.name ?? ""} ${business.domain ?? ""}`.toLowerCase().match(WORD_RE) ?? []) this.keep.add(w);
  }

  /** Something private: its kind decides the placeholder; its name, subject, email and phone are scrubbed from every text. */
  add(id: string, kind: PrivateKind, o: { name?: string | null; email?: string | null; phone?: string | null; subject?: string | null } = {}): void {
    this.kinds.set(id, kind);
    this.unmasked.set(this.maskId(id), id);
    const text = PLACEHOLDER[kind].text;
    const name = (o.name ?? "").trim();
    if (kind === "person" || kind === "lead" || kind === "customer") {
      // a Lead is named "<who>: <subject>"; a Message "<who>: <subject>" or "From <who>: ..."
      const [who, ...rest] = kind === "lead" ? name.split(":") : [name];
      this.term(who ?? "", text, 3);
      if (rest.length) this.term(rest.join(":"), SUBJECT_HIDDEN, 8);
      if (kind !== "customer") for (const w of (who ?? "").match(WORD_RE) ?? []) this.token(w, text);
    } else if (kind === "message" || kind === "meeting" || kind === "deal") {
      const at = name.indexOf(":");
      if (at > 0) {
        const who = name.slice(0, at).replace(/^(?:From|To|Deal with)\s+/i, "");
        this.term(who, "someone", 3);
        for (const w of who.match(WORD_RE) ?? []) this.token(w, "someone");
        this.term(name.slice(at + 1), SUBJECT_HIDDEN, 8);
      }
      this.term(name, text, 8);
    }
    if (o.subject) this.term(o.subject, SUBJECT_HIDDEN, 8);
    if (o.email) this.term(o.email, EMAIL_HIDDEN, 5);
    if (o.phone) this.term(o.phone, PHONE_HIDDEN, 7);
  }

  private term(raw: string, replacement: string, min: number): void {
    const t = raw.trim().replace(/\s+/g, " ");
    if (t.length < min) return;
    const first = t.match(WORD_RE)?.[0];
    if (!first || !t.toLowerCase().startsWith(first.toLowerCase())) return; // a term is found from its first word
    const lower = t.toLowerCase();
    if (this.keep.has(lower) || lower === this.own) return;
    const key = first.toLowerCase();
    const list = this.terms.get(key) ?? [];
    if (!list.some((x) => x.lower === lower)) list.push({ lower, text: replacement });
    list.sort((a, b) => b.lower.length - a.lower.length);
    this.terms.set(key, list);
  }

  private token(w: string, replacement: string): void {
    if (w.length < 3 || !/^\p{Lu}/u.test(w) || NEVER_NAMES.has(w) || this.keep.has(w.toLowerCase())) return;
    if (!this.tokens.has(w)) this.tokens.set(w, replacement);
  }

  /** The kind of a private thing, or undefined for one a visitor may see. */
  kindOf(id: string, label?: string): PrivateKind | undefined {
    const known = this.kinds.get(id);
    if (known) return known;
    if (label && LABEL_KIND[label]) return LABEL_KIND[label];
    const p = id.slice(0, Math.max(0, id.indexOf(":")));
    if (PREFIX_KIND[p]) return PREFIX_KIND[p];
    return this.isMasked(id) ? "document" : undefined;
  }

  isMasked = (id: string): boolean => /^[a-z-]+:hidden-[0-9a-f]{12}$/.test(id);

  maskId(id: string): string {
    if (this.isMasked(id)) return id;
    const prefix = id.includes(":") ? id.slice(0, id.indexOf(":")) : "thing";
    const masked = `${/^[a-z-]+$/.test(prefix) ? prefix : "thing"}:hidden-${createHmac("sha256", SECRET).update(id).digest("hex").slice(0, 12)}`;
    if (!this.unmasked.has(masked) && this.kinds.has(id)) this.unmasked.set(masked, id);
    return masked;
  }

  /** A masked id back to the real one (a tap on a masked node); undefined when it was never one of ours. */
  unmask(id: string): string | undefined {
    return this.unmasked.get(id);
  }

  // ---------- text ----------

  scrub(s: string): string {
    if (!s || !/[\p{L}\p{N}]/u.test(s)) return s;
    let t = s.replace(EMAIL_RE, EMAIL_HIDDEN);
    t = t.replace(PHONE_RE, (m) => {
      const digits = m.replace(/\D/g, "").length;
      return digits >= 9 && digits <= 15 && !DATE_LIKE.test(m.trim()) ? PHONE_HIDDEN : m;
    });
    t = t.replace(ID_RE, (m) => {
      const tail = /[._/-]+$/.exec(m)?.[0] ?? "";
      const id = tail ? m.slice(0, -tail.length) : m;
      return id.startsWith("document:") && !this.kinds.has(id) ? m : `${this.maskId(id)}${tail}`;
    });
    return this.names(t);
  }

  // Whole names and subjects (any case) and capitalised single names, found word by word: one pass, no giant pattern.
  private names(s: string): string {
    if (!this.terms.size && !this.tokens.size) return s;
    const lower = s.toLowerCase();
    let out = "";
    let at = 0;
    for (const m of s.matchAll(WORD_RE)) {
      const i = m.index;
      if (i < at) continue;
      const word = m[0];
      let hit: { end: number; text: string } | undefined;
      for (const term of this.terms.get(word.toLowerCase()) ?? []) {
        if (lower.startsWith(term.lower, i) && !isWordChar(s[i + term.lower.length])) { hit = { end: i + term.lower.length, text: term.text }; break; }
      }
      if (!hit) {
        const tok = this.tokens.get(word) ?? (word.endsWith("'s") || word.endsWith("’s") ? this.tokens.get(word.slice(0, -2)) : undefined);
        if (tok) hit = { end: i + word.length, text: tok };
      }
      if (!hit) continue;
      out += s.slice(at, i) + hit.text;
      at = hit.end;
    }
    return at === 0 ? s : out + s.slice(at);
  }
}

// ---------- reading the index ----------

const isPrivateDoc = (kind: unknown, path: unknown): boolean =>
  typeof kind === "string" && (PRIVATE_DOC_KINDS.has(kind) || (VAULT_DOC_KINDS.has(kind) && typeof path === "string" && !!path));

interface IndexRow { id: string; labels: string[]; name: string | null; email: string | null; phone: string | null; role: string | null; kind: string | null; path: string | null; subject: string | null }

export async function readShowcaseIndex(g: GraphHandle, business: { name?: string; domain?: string }): Promise<ShowcaseIndex> {
  const idx = new ShowcaseIndex(business);
  for (let after = ""; ;) {
    const rows = await g.roQuery<IndexRow>(
      `MATCH (n:Entity) WHERE (n:Person OR n:Lead OR n:Client OR n:Deal OR n:Meeting OR n:Message OR n:Document) AND n.id > $after
       RETURN n.id AS id, labels(n) AS labels, n.name AS name, n.email AS email, n.phone AS phone, n.role AS role, n.kind AS kind,
         n.path AS path, n.subject AS subject
       ORDER BY n.id LIMIT $limit`, { after, limit: MAX_PAGE }, { timeoutMs: 20_000 });
    for (const r of rows) {
      const type = typeOfLabels(r.labels);
      if (type === "Document") {
        if (isPrivateDoc(r.kind, r.path)) idx.add(r.id, "document");
        continue;
      }
      const kind = type ? LABEL_KIND[type] : undefined;
      if (!kind) continue;
      idx.add(r.id, kind === "person" && r.role === "lead" ? "lead" : kind, { name: r.name, email: r.email, phone: r.phone, subject: r.subject });
    }
    if (rows.length < MAX_PAGE) return idx;
    after = rows[rows.length - 1]!.id;
  }
}

// One index per business, read again after a minute (a showcase is read-only: what changes is the owner's own work).
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; idx: Promise<ShowcaseIndex> }>();

export function showcaseIndex(slug: string, load: () => Promise<ShowcaseIndex>, now: number = Date.now()): Promise<ShowcaseIndex> {
  const hit = cache.get(slug);
  if (hit && now - hit.at < TTL_MS) return hit.idx;
  const idx = load();
  cache.set(slug, { at: now, idx });
  idx.catch(() => { if (cache.get(slug)?.idx === idx) cache.delete(slug); });
  return idx;
}

// ---------- the request's view ----------

/** Set by app.ts for a visitor to a showcase: the routes that take a node id from the visitor read it through resolveShowcaseId. */
export const showcaseView = new AsyncLocalStorage<ShowcaseIndex>();

/** The id a route should read: unchanged outside a showcase; in one, a masked id is turned back and a private id asked for
 *  by its real name is refused (null: the route answers 404, as for a node that is not there). */
export function resolveShowcaseId(id: string): string | null {
  const idx = showcaseView.getStore();
  if (!idx) return id;
  if (idx.isMasked(id)) return idx.unmask(id) ?? null;
  return idx.kindOf(id) ? null : id;
}

/** Whether a visitor's search names a private person, customer, lead, message, email or phone: then it finds nothing, so a
 *  search cannot be used to learn who the business's customers are. */
export function showcaseRefusesQuery(q: string): boolean {
  const idx = showcaseView.getStore();
  return !!idx && idx.scrub(q) !== q;
}

/** Whether a visitor to a showcase may not be shown this thing at all (a person, customer, lead, message or private document). */
export function showcaseHides(id: string, type?: string): boolean {
  const idx = showcaseView.getStore();
  return !!idx && !!idx.kindOf(id, type);
}

// ---------- the JSON ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// a node reference: {id, label, name} (NodeRef) or {id, type, name} (the Brain page's things)
const refType = (o: Record<string, unknown>): string | undefined =>
  typeof o.id === "string" && typeof o.name === "string" ? (typeof o.label === "string" ? o.label : typeof o.type === "string" ? o.type : undefined) : undefined;
const isRef = (o: Record<string, unknown>): boolean => refType(o) !== undefined;
const isSourceRef = (o: Record<string, unknown>): boolean => typeof o.id === "string" && typeof o.title === "string" && !("label" in o) && Object.keys(o).every((k) => k === "id" || k === "title" || k === "asOf");

function privateRef(o: Record<string, unknown>, idx: ShowcaseIndex): PrivateKind | undefined {
  if (typeof o.id !== "string") return undefined;
  if (isRef(o)) return idx.kindOf(o.id, refType(o));
  if (isSourceRef(o)) return idx.kindOf(o.id);
  return undefined;
}

// Consecutive typing from the same agent becomes one event, so a name split across two deltas is scrubbed whole.
function joinText(list: unknown[]): unknown[] {
  if (!list.some((e) => isObj(e) && e.type === "text")) return list;
  const out: unknown[] = [];
  for (const e of list) {
    const prev = out[out.length - 1];
    if (isObj(e) && e.type === "text" && isObj(prev) && prev.type === "text" && prev.agent === e.agent && !e.reset && typeof e.delta === "string") {
      out[out.length - 1] = { ...prev, delta: `${String(prev.delta)}${e.delta}` };
    } else out.push(e);
  }
  return out;
}

function maskCard(o: Record<string, unknown>, idx: ShowcaseIndex): Record<string, unknown> {
  const preview = isObj(o.preview) ? o.preview : undefined;
  const when = preview && isObj(preview.when) ? preview.when : undefined;
  const message = MESSAGE_CARD_KINDS.has(String(o.kind)) || !!(preview && (preview.to || preview.subject || (Array.isArray(when?.guests) && when.guests.length)));
  if (!message) return o;
  const title = o.kind === "calendar_event" ? "A meeting with a customer" : "An email to a customer";
  const hide = (p: unknown) => (isObj(p) ? { title, body: HIDDEN_TEXT } : p);
  const out: Record<string, unknown> = { ...o, title, payload: hide(o.payload) };
  if ("editedPayload" in o) out.editedPayload = hide(o.editedPayload);
  if (preview) {
    const { to: _to, cc: _cc, subject: _subject, ...rest } = preview;
    void _to; void _cc; void _subject;
    out.preview = { ...rest, ...(when ? { when: { ...when, guests: [] } } : {}) };
  }
  return out;
}

const safeProps = (p: unknown): Record<string, unknown> =>
  isObj(p) ? Object.fromEntries(Object.entries(p).filter(([k, v]) => SAFE_PROPS.has(k) && (typeof v !== "string" || v.length <= 40))) : {};

/** Everything a visitor to a showcase may see of a JSON value. */
export function maskJson(v: unknown, idx: ShowcaseIndex): unknown {
  if (typeof v === "string") return idx.scrub(v);
  if (Array.isArray(v)) {
    return joinText(v)
      // a search hit on a private thing is left out: a visitor cannot test whether someone is a customer
      .filter((x) => !(isObj(x) && typeof x.score === "number" && isObj(x.node) && privateRef(x.node, idx)))
      .map((x) => maskJson(x, idx));
  }
  if (!isObj(v)) return v;
  let o = v;
  if (o.type === "tool_call" && "args" in o) o = { ...o, args: {} };
  if (o.type === "proposal" && MESSAGE_CARD_KINDS.has(String(o.kind))) o = { ...o, title: o.kind === "calendar_event" ? "A meeting with a customer" : "An email to a customer" };
  if (typeof o.kind === "string" && isObj(o.payload) && typeof o.status === "string") o = maskCard(o, idx);
  // a node's card: a private thing keeps its plain facts only, in its versions too
  if (isObj(o.node) && isObj(o.props) && Array.isArray(o.neighbors) && privateRef(o.node, idx)) {
    o = {
      ...o, props: safeProps(o.props), sources: [],
      versions: Array.isArray(o.versions) ? o.versions.map((x) => (isObj(x) ? { since: x.since, until: x.until, props: safeProps(x.props) } : x)) : [],
    };
  }
  const kind = privateRef(o, idx);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    if (DROP_KEYS.has(k)) continue;
    if (kind && (k === "summary" || k === "snippet")) continue;
    if (kind && k === "id") { out.id = idx.maskId(x as string); continue; }
    if (kind && (k === "name" || k === "title")) { out[k] = PLACEHOLDER[kind].ref; continue; }
    out[k] = maskJson(x, idx);
  }
  return out;
}

// ---------- the response ----------

// An event stream, frame by frame: typing is dropped (the final answer comes whole), every other event is masked.
function maskStream(body: ReadableStream<Uint8Array>, idx: ShowcaseIndex): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const frame = (f: string): string | null => {
    const data = f.split("\n").find((l) => l.startsWith("data:"));
    if (!data) return `${f}\n\n`; // a comment (": ping")
    let e: unknown;
    try { e = JSON.parse(data.slice(5).trim()); } catch { return null; }
    if (isObj(e) && e.type === "text") return null;
    const masked = maskJson(e, idx);
    const type = isObj(masked) && typeof masked.type === "string" ? masked.type : "message";
    return `event: ${type}\ndata: ${JSON.stringify(masked)}\n\n`;
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const f = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const out = frame(f);
        if (out) ctrl.enqueue(enc.encode(out));
      }
    },
    flush(ctrl) {
      if (buf.trim()) { const out = frame(buf); if (out) ctrl.enqueue(enc.encode(out)); }
    },
  }));
}

/** The response a visitor to a showcase gets: JSON masked whole, an event stream event by event; pictures and files as they are
 *  (the routes that serve files serve brand assets and the team's own drafts of public posts). */
export async function maskResponse(res: Response, idx: ShowcaseIndex): Promise<Response> {
  const type = res.headers.get("content-type") ?? "";
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  if (type.includes("application/json")) {
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { return new Response(text, { status: res.status, headers }); }
    return new Response(JSON.stringify(maskJson(body, idx)), { status: res.status, headers });
  }
  if (type.includes("text/event-stream") && res.body) return new Response(maskStream(res.body, idx), { status: res.status, headers });
  return res;
}

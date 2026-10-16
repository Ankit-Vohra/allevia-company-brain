// One post, step by step, on the platform's own Composio actions. Nothing here decides WHETHER to post (that is the owner's OK,
// the dry run and the limits, in executor.ts): it only knows HOW, and what went wrong in words the owner can read.
//
//   readAccount    who the connection is signed in as (a read; used to put "your account @cafe" on the card, and to check at post
//                  time that it is still that account)
//   publishPost    makes the post. Instagram is two calls (a media container from a public picture or video address, then publish
//                  the container); the container id is handed back so that a retry never makes a second post
//   PublishFailure what stopped it: `words` for the owner, whether it may have gone out anyway (`maybePosted`), whether a retry
//                  can work, and the container to carry on with
import { scrub } from "../connections/audit.js";
import { ComposioError, ComposioToolError } from "../connections/composio.js";
import { asObj, deepArr, deepStr } from "./data.js";
import { slugsOf, verifyPublishTools, type Account, type PlatformSpec } from "./platforms.js";

export interface PostSession {
  execute(tool: string, args: Record<string, unknown>): Promise<unknown>;
  listTools?(search?: string): Promise<Array<{ slug: string; name: string; description: string; params?: { required: string[]; properties: string[] } }>>;
}

export interface PostMedia { kind: "image" | "video"; url: string; width?: number; height?: number }

export interface PostInput {
  caption: string;
  account: Account;
  media?: PostMedia;
  /** Instagram: the container an earlier attempt already made, so the retry carries on instead of starting a second post. */
  containerId?: string;
}

export interface Posted { id?: string; url?: string; containerId?: string }

export interface PostOpts {
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for Instagram to finish preparing the picture or video before leaving it for the scheduler (default 45 s). */
  maxWaitMs?: number;
  pollMs?: number;
  now?: () => number;
}

export class PublishFailure extends Error {
  override name = "PublishFailure";
  constructor(
    readonly words: string,
    readonly o: { maybePosted?: boolean; retryable?: boolean; containerId?: string; pending?: boolean; reconnect?: boolean } = {},
  ) {
    super(words);
  }
  get maybePosted(): boolean { return this.o.maybePosted === true; }
  get retryable(): boolean { return this.o.retryable !== false; }
  /** Not failed: the platform is still preparing it. The scheduler carries on with `containerId`. */
  get pending(): boolean { return this.o.pending === true; }
  get containerId(): string | undefined { return this.o.containerId; }
  get reconnect(): boolean { return this.o.reconnect === true; }
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** A provider's own error text, as a sentence an owner can use. The first match wins; anything else is clipped and scrubbed. */
export function plainWhy(spec: PlatformSpec, raw: string): { words: string; reconnect?: boolean } {
  const name = spec.name;
  const t = raw || "";
  if (/(expired|invalid|revoked|session).{0,40}(token|session|oauth)|oauth|\(#?190\)|code[": ]+190|not authori[sz]ed|unauthori[sz]ed|reconnect|connected account/i.test(t) && !/permission/i.test(t)) {
    return { words: `${name} stopped letting us in. Connect ${name} again, then try again.`, reconnect: true };
  }
  if (/permission|\(#?200\)|\(#?10\)|scope|not allowed to/i.test(t)) return { words: `${name} says the connection isn't allowed to post. Connect ${name} again and leave every box ticked.`, reconnect: true };
  if (/aspect ratio|\(#?9007\)|\(#?9004\)|2207\d{3}|media.{0,30}(not|cannot|couldn't|could not).{0,20}(fetch|download|retriev|access)|image.{0,30}(size|format|type)|unsupported (image|format)/i.test(t)) {
    return { words: `${name} couldn't use the picture. It has to be a JPEG or PNG that loads from the internet, with a shape between 4:5 and 1.91:1 for the feed.` };
  }
  if (/rate.?limit|too many|\(#?4\)|\(#?17\)|\(#?32\)|\(#?613\)|spam|quota|limit reached|temporarily blocked/i.test(t)) return { words: `${name} says too many posts or requests came in at once. Wait a while, then try again.` };
  if (/duplicate/i.test(t)) return { words: `${name} says this looks like a post you already made.` };
  const detail = clip(scrub(t) ?? "", 140);
  return { words: detail ? `${name} wouldn't take it: ${detail}` : `${name} wouldn't take it.` };
}

const sleepFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The slug check: every action we call is in Composio's list for the toolkit, with the arguments we send. Fails closed. */
const checked = new Map<string, { at: number; ok: boolean; why: string }>();
export const resetToolChecks = (): void => checked.clear();

async function ensureTools(spec: PlatformSpec, s: PostSession, now: number): Promise<void> {
  if (!s.listTools) return;
  const hit = checked.get(spec.id);
  if (hit && now - hit.at < 10 * 60_000) {
    if (!hit.ok) throw new PublishFailure(hit.why, { retryable: true });
    return;
  }
  let listed;
  try {
    listed = await s.listTools();
  } catch {
    return; // the list could not be read: the call itself will say if something is wrong
  }
  const c = verifyPublishTools(spec, listed);
  const why = c.ok ? "" : `${spec.name}'s connection no longer offers what posting needs (${[...c.missing, ...c.badArgs.map((b) => `${b.slug} ${b.arg}`)].slice(0, 3).join(", ")}). Nothing was posted. Your team has been told to look at it.`;
  checked.set(spec.id, { at: now, ok: c.ok, why });
  if (!c.ok) throw new PublishFailure(why, { retryable: true });
}

/** One call on the platform. `posts`: this is the call that puts it out, so a failure we cannot read may still have gone out. */
async function step(spec: PlatformSpec, s: PostSession, slug: string, args: Record<string, unknown>, o: { posts?: boolean; containerId?: string } = {}): Promise<unknown> {
  try {
    return await s.execute(slug, args);
  } catch (e) {
    // the tool itself said no: what it refused was not done. Anything else (Composio did not answer, the line dropped) is unknown.
    if (e instanceof ComposioToolError) {
      const why = plainWhy(spec, e.message);
      throw new PublishFailure(why.words, { retryable: true, ...(o.containerId ? { containerId: o.containerId } : {}), ...(why.reconnect ? { reconnect: true } : {}) });
    }
    if (e instanceof PublishFailure) throw e;
    const unsure = o.posts === true;
    const status = e instanceof ComposioError ? e.status : 0;
    throw new PublishFailure(
      unsure
        ? `We couldn't confirm that ${spec.name} took it${status ? ` (${spec.name}'s connection answered with an error)` : ""}. Check ${spec.id === "instagram" ? "your Instagram account" : spec.id === "facebook" ? "your Page" : "your LinkedIn profile"} before trying again.`
        : `${spec.name} didn't answer just now. Nothing was posted. Try again in a minute.`,
      { maybePosted: unsure, retryable: true, ...(o.containerId ? { containerId: o.containerId } : {}) },
    );
  }
}

// ---------- who the connection is signed in as ----------

/** `want`: the account id the owner approved. A Facebook login can manage several Pages; the one approved is found among them (not "the first"). */
export async function readAccount(spec: PlatformSpec, s: PostSession, want?: string): Promise<Account> {
  const a = spec.actions;
  if (spec.id === "instagram") {
    const d = await step(spec, s, a.account!.slug, {});
    const id = deepStr(d, ["id", "ig_user_id"]);
    const username = deepStr(d, ["username"]);
    if (!id) throw new PublishFailure("Instagram didn't say which account this is. Connect Instagram again.", { reconnect: true });
    return { id, name: username || id, ...(username ? { handle: `@${username.replace(/^@/, "")}` } : {}) };
  }
  if (spec.id === "facebook") {
    const d = await step(spec, s, a.account!.slug, {});
    const pages = deepArr(d, "data").map(asObj).filter((p) => typeof p.id === "string" && p.id);
    const first = want ? pages.find((p) => String(p.id) === want) : pages[0];
    if (!first) throw new PublishFailure(want && pages.length ? "The Facebook Page you approved isn't on this login any more, so nothing was posted. Connect Facebook again and choose that Page." : "No Facebook Page is connected to this login. Connect Facebook again and choose your Page.", { reconnect: true });
    // only the id and the name are kept: the list also carries an access token for each Page, which never leaves this function
    return { id: String(first.id), name: typeof first.name === "string" && first.name ? first.name : String(first.id) };
  }
  const d = await step(spec, s, a.account!.slug, {});
  const raw = deepStr(d, ["author_id", "sub", "id"]);
  if (!raw) throw new PublishFailure("LinkedIn didn't say whose profile this is. Connect LinkedIn again.", { reconnect: true });
  const name = deepStr(d, ["name"]) || [deepStr(d, ["given_name"]), deepStr(d, ["family_name"])].filter(Boolean).join(" ") || "LinkedIn profile";
  return { id: raw.startsWith("urn:") ? raw : `urn:li:person:${raw}`, name };
}

// ---------- LinkedIn's text format ----------

/** LinkedIn reads these characters as markup in a post's text, and cuts the post short at an unescaped one. A # that starts a word stays (a hashtag). */
export function linkedinText(caption: string): string {
  return caption.replace(/[\\|{}@[\]()<>*_~]/g, (c) => `\\${c}`).replace(/#(?![\p{L}\p{N}_])/gu, "\\#");
}

// ---------- publishing ----------

const URL_ID = (id: string): string => encodeURIComponent(id);

async function instagram(spec: PlatformSpec, s: PostSession, p: PostInput, o: Required<PostOpts>): Promise<Posted> {
  const A = spec.actions;
  let creation = p.containerId;
  if (!creation) {
    if (!p.media) throw new PublishFailure("Instagram posts need a picture or a video, and this one has none. Nothing was posted.", { retryable: false });
    const video = p.media.kind === "video";
    const made = await step(spec, s, A.container!.slug, {
      ig_user_id: p.account.id, caption: p.caption,
      ...(video ? { video_url: p.media.url, content_type: "reel" } : { image_url: p.media.url, content_type: "photo" }),
    });
    creation = deepStr(made, ["id", "creation_id"]);
    if (!creation) throw new PublishFailure("Instagram didn't accept the picture, so nothing was posted. Try again in a minute.", { retryable: true });
  }
  // wait until Instagram has finished preparing it (a video takes a while); a picture is usually ready at once
  const t0 = o.now();
  for (;;) {
    let st = "";
    try {
      st = deepStr(await s.execute(A.status!.slug, { creation_id: creation }), ["status_code", "status"]).toUpperCase();
    } catch {
      break; // the status could not be read: publishing says if it was not ready
    }
    if (st === "FINISHED" || st === "") break;
    if (st === "PUBLISHED") {
      // an earlier attempt already put it out: find it, never make a second one
      const found = await findRecent(spec, s, p);
      return { ...found, containerId: creation };
    }
    if (st === "ERROR") throw new PublishFailure("Instagram couldn't prepare the file, so nothing was posted. Try making the picture or video again.", { retryable: false, containerId: creation });
    if (st === "EXPIRED") throw new PublishFailure("Instagram waited too long and dropped it, so nothing was posted. Try again to start it over.", { retryable: true });
    if (o.now() - t0 >= o.maxWaitMs) throw new PublishFailure("Instagram is still preparing it. We'll finish posting as soon as it's ready.", { pending: true, containerId: creation });
    await o.sleep(o.pollMs);
  }
  const out = await step(spec, s, A.publish!.slug, { ig_user_id: p.account.id, creation_id: creation }, { posts: true, containerId: creation });
  const id = deepStr(out, ["id", "media_id"]);
  const link = id ? await permalinkOf(spec, s, p, id) : undefined;
  return { ...(id ? { id } : {}), ...(link ? { url: link } : {}), containerId: creation };
}

/** The post's own address, from the account's recent posts. A convenience: never fails the post. */
async function permalinkOf(spec: PlatformSpec, s: PostSession, p: PostInput, id: string): Promise<string | undefined> {
  try {
    const d = await s.execute(spec.actions.recent!.slug, { ig_user_id: p.account.id, limit: 5 });
    const hit = deepArr(d, "data").map(asObj).find((m) => m.id === id);
    return typeof hit?.permalink === "string" && hit.permalink ? hit.permalink : undefined;
  } catch {
    return undefined;
  }
}

async function findRecent(spec: PlatformSpec, s: PostSession, p: PostInput): Promise<Posted> {
  try {
    const d = await s.execute(spec.actions.recent!.slug, { ig_user_id: p.account.id, limit: 10 });
    const same = (c: unknown) => typeof c === "string" && c.replace(/\s+/g, " ").trim() === p.caption.replace(/\s+/g, " ").trim();
    const hit = deepArr(d, "data").map(asObj).find((m) => same(m.caption));
    if (hit && typeof hit.id === "string") return { id: hit.id, ...(typeof hit.permalink === "string" && hit.permalink ? { url: hit.permalink } : {}) };
  } catch {
    // below
  }
  throw new PublishFailure("Instagram says this one was already posted, but we couldn't find it to link to. Check your Instagram account.", { retryable: false, maybePosted: true });
}

async function facebook(spec: PlatformSpec, s: PostSession, p: PostInput): Promise<Posted> {
  const A = spec.actions;
  const page = p.account.id;
  let out: unknown;
  let url: (id: string) => string = (id) => `https://www.facebook.com/${URL_ID(id)}`;
  if (p.media?.kind === "video") {
    out = await step(spec, s, A.video!.slug, { page_id: page, file_url: p.media.url, description: p.caption, published: true }, { posts: true });
    url = (id) => `https://www.facebook.com/watch/?v=${URL_ID(id)}`;
  } else if (p.media) {
    out = await step(spec, s, A.photo!.slug, { page_id: page, url: p.media.url, message: p.caption, published: true }, { posts: true });
  } else {
    out = await step(spec, s, A.text!.slug, { page_id: page, message: p.caption, published: true }, { posts: true });
  }
  const id = deepStr(out, ["post_id", "id"]);
  return id ? { id, url: url(id) } : {};
}

async function linkedin(spec: PlatformSpec, s: PostSession, p: PostInput): Promise<Posted> {
  const out = await step(spec, s, spec.actions.post!.slug, { author: p.account.id, commentary: linkedinText(p.caption), visibility: "PUBLIC", lifecycleState: "PUBLISHED" }, { posts: true });
  const id = deepStr(out, ["share_id", "x-restli-id", "id"]);
  if (!id) return {};
  const urn = id.startsWith("urn:") ? id : `urn:li:share:${id}`;
  return { id, url: `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/` };
}

export async function publishPost(spec: PlatformSpec, s: PostSession, p: PostInput, opts: PostOpts = {}): Promise<Posted> {
  const o: Required<PostOpts> = { sleep: opts.sleep ?? sleepFor, maxWaitMs: opts.maxWaitMs ?? 45_000, pollMs: opts.pollMs ?? 3000, now: opts.now ?? (() => Date.now()) };
  await ensureTools(spec, s, o.now());
  if (spec.id === "instagram") return instagram(spec, s, p, o);
  if (spec.id === "facebook") return facebook(spec, s, p);
  return linkedin(spec, s, p);
}

export { slugsOf };

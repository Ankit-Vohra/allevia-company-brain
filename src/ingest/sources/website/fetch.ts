// Every byte the website source downloads goes through guardedFetch, the crawler's own requests and everything the
// browser asks for while rendering a page (crawl.ts fulfils the browser's requests from here). Onboarding fetches a URL
// a stranger typed, so:
// - only http(s); credentials in URLs are dropped;
// - a literal private, loopback or link-local host is refused before any connection; a host NAME is checked when it
//   resolves, inside the socket's own lookup, so the address checked is the address connected to (no DNS-rebinding
//   gap between a check and the connect);
// - redirects are followed by hand, at most maxRedirects, and every hop passes the same checks;
// - bodies are capped (after decompression, so a gzip bomb stops at the cap) and every request has a deadline.
// Tests opt in to their local server with allowHosts ["127.0.0.1:<port>"]: an exact host:port, nothing wider.
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import { isBlockedAddress, isPrivateHost } from "./urls.js";

export const USER_AGENT = "AlleviaBot/0.1 (+onboarding preview)";

export class BlockedUrlError extends Error {
  override name = "BlockedUrlError";
}

// A redirect hop the caller refused (off-site, a login page, a path robots.txt disallows); the page behind it is never requested.
export class RedirectRefusedError extends Error {
  override name = "RedirectRefusedError";
}

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

export interface FetchOpts {
  method?: "GET" | "HEAD";
  maxBytes?: number;        // default 3 MB, counted after decompression
  timeoutMs?: number;       // default 20 s for the whole fetch, redirects included
  maxRedirects?: number;    // default 5
  allowHosts?: string[];    // exact "host:port" pairs that may be private (tests)
  resolver?: Resolver;      // default dns.lookup (tests inject one)
  userAgent?: string;
  accept?: string;
  headers?: Record<string, string>; // extra request headers (lower-case names); cannot replace the user agent
  hopCheck?: (next: URL) => string | undefined; // called before each redirect is followed; a reason refuses it (RedirectRefusedError)
}

export interface FetchResult {
  url: string;              // as requested
  finalUrl: string;         // after redirects
  redirects: string[];      // the hops before finalUrl, in order
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;       // the body hit maxBytes and was cut
  responseMs: number;       // time to the final response's headers
  totalMs: number;
}

const DEFAULTS = { maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 5 };

const hostPort = (u: URL): string => `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;

// The checks a URL passes before any connection. Returns the URL without credentials or fragment.
export function checkUrl(raw: string, allowHosts: string[] = []): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError(`not a URL: ${JSON.stringify(raw.slice(0, 200))}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError(`only http(s) URLs are fetched, not ${u.protocol}`);
  if (!u.hostname) throw new BlockedUrlError("the URL has no host");
  u.username = "";
  u.password = "";
  u.hash = "";
  if (isPrivateHost(u.hostname) && !allowHosts.includes(hostPort(u))) {
    throw new BlockedUrlError(`${u.hostname} is a private, loopback or local address`);
  }
  return u;
}

// The socket's lookup: resolve, then refuse if ANY address is private (a name with one public and one private address
// could be steered to the private one).
export function guardedLookup(resolver?: Resolver, allowPrivate = false): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number | string }, cb: (...a: unknown[]) => void) => {
    const resolve: Resolver = resolver ?? ((h) => new Promise((ok, fail) =>
      dnsLookup(h, { all: true }, (err, addrs: LookupAddress[]) => (err ? fail(err) : ok(addrs)))));
    resolve(hostname).then((addrs) => {
      if (!addrs.length) return cb(Object.assign(new Error(`${hostname} did not resolve`), { code: "ENOTFOUND" }));
      const bad = addrs.find((a) => isBlockedAddress(a.address));
      if (bad && !allowPrivate) return cb(new BlockedUrlError(`${hostname} resolves to a private or local address`));
      if (options?.all) return cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
      return cb(null, addrs[0]!.address, addrs[0]!.family);
    }, (e: unknown) => cb(e));
  }) as unknown as LookupFunction;
}

const flat = (h: http.IncomingHttpHeaders): Record<string, string> =>
  Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));

interface Hop { status: number; headers: Record<string, string>; body: Buffer; truncated: boolean; responseMs: number }

function requestOnce(u: URL, o: Required<Pick<FetchOpts, "maxBytes">> & FetchOpts, signal: AbortSignal, allowPrivate: boolean): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const t0 = performance.now();
    const req = mod.request(u, {
      method: o.method ?? "GET",
      headers: {
        "user-agent": o.userAgent ?? USER_AGENT,
        accept: o.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en",
        "accept-encoding": "gzip, deflate, br",
        ...Object.fromEntries(Object.entries(o.headers ?? {}).filter(([k]) => !["user-agent", "accept-encoding", "host", "cookie", "authorization"].includes(k.toLowerCase()))),
      },
      lookup: guardedLookup(o.resolver, allowPrivate),
      signal,
    }, (res) => {
      const responseMs = Math.round(performance.now() - t0);
      const status = res.statusCode ?? 0;
      const headers = flat(res.headers);
      if (o.method === "HEAD" || (status >= 300 && status < 400 && headers.location)) {
        res.resume();
        resolve({ status, headers, body: Buffer.alloc(0), truncated: false, responseMs });
        return;
      }
      const enc = (headers["content-encoding"] ?? "").trim().toLowerCase();
      let stream: Readable = res;
      if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (truncated: boolean) => {
        if (done) return;
        done = true;
        resolve({ status, headers, body: Buffer.concat(chunks), truncated, responseMs });
      };
      stream.on("data", (c: Buffer) => {
        if (done) return;
        if (size + c.length > o.maxBytes) {
          chunks.push(c.subarray(0, o.maxBytes - size));
          size = o.maxBytes;
          finish(true);
          res.destroy();
          return;
        }
        chunks.push(c);
        size += c.length;
      });
      stream.on("end", () => finish(false));
      stream.on("error", (e) => (done ? undefined : reject(e)));
      res.on("error", (e) => (done ? undefined : reject(e)));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function guardedFetch(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
  const o = { ...DEFAULTS, ...opts };
  const allow = o.allowHosts ?? [];
  const started = performance.now();
  const signal = AbortSignal.timeout(o.timeoutMs);
  let u = checkUrl(url, allow);
  const redirects: string[] = [];
  for (;;) {
    const hop = await requestOnce(u, o, signal, allow.includes(hostPort(u)));
    const loc = hop.headers.location;
    if (hop.status >= 300 && hop.status < 400 && loc) {
      if (redirects.length >= o.maxRedirects) throw new BlockedUrlError(`more than ${o.maxRedirects} redirects from ${url}`);
      let next: string;
      try {
        next = new URL(loc, u).toString();
      } catch {
        throw new BlockedUrlError(`redirect to an invalid URL ${JSON.stringify(loc.slice(0, 200))}`);
      }
      redirects.push(u.toString());
      u = checkUrl(next, allow); // the same checks on every hop
      const refused = o.hopCheck?.(u);
      if (refused) throw new RedirectRefusedError(refused);
      continue;
    }
    return {
      url, finalUrl: u.toString(), redirects, status: hop.status, headers: hop.headers, body: hop.body, truncated: hop.truncated,
      responseMs: hop.responseMs, totalMs: Math.round(performance.now() - started),
    };
  }
}

// At most one crawler request per minDelayMs (default 1 s), in the order asked. Robots' Crawl-delay can only slow it.
export class Pacer {
  private next = 0;
  constructor(
    private delayMs: number,
    private readonly clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
      now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
  ) {}
  get minDelayMs(): number {
    return this.delayMs;
  }
  slowTo(ms: number): void {
    this.delayMs = Math.max(this.delayMs, ms);
  }
  async wait(): Promise<void> {
    const now = this.clock.now();
    const at = Math.max(now, this.next);
    this.next = at + this.delayMs;
    if (at > now) await this.clock.sleep(at - now);
  }
}

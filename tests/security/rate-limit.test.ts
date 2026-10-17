// Rate limits on the two doors a stranger can knock on before hosting (issue #23): POST /api/auth/open (each try costs a registry read)
// and POST /api/onboard (spends the operator's model time and makes a graph). The clock is a fake one; nothing here needs a database.
import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp, type ServerDeps } from "../../src/server/app.js";
import { SlidingWindow, makeLimits, DEFAULT_LIMITS, clientKey, type RateLimitConfig } from "../../src/server/ratelimit.js";

const clock = { t: 1_000_000 };
const advance = (ms: number) => { clock.t += ms; };

function appWith(rateLimit: RateLimitConfig | undefined, over: Partial<ServerDeps> = {}) {
  const verified: string[] = [];
  const onboarded: string[] = [];
  const app: Hono = createApp({
    publicMode: false,
    listTenants: async () => [],
    openGraph: async () => { throw new Error("no graph in this test"); },
    askDeps: async () => { throw new Error("no ask in this test"); },
    loadOnboard: async () => async (input) => { onboarded.push(input.slug); },
    auth: {
      enabled: true,
      verify: async (token) => { verified.push(token); return token === "good" ? { scope: "tenant_a", tokenId: "tok_1" } : token === "op" ? { scope: "operator", tokenId: "tok_2" } : null; },
    },
    ...(rateLimit ? { rateLimit } : {}),
    heartbeatMs: 0, replaySpeed: 0, now: () => clock.t, tenantCacheMs: 0, log: () => {}, ...over,
  });
  return { app, verified, onboarded };
}

const open = (app: Hono, token: string, headers: Record<string, string> = {}) =>
  app.request("/api/auth/open", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ token }) });
const setUp = async (app: Hono, name: string, headers: Record<string, string> = {}) => {
  const res = await app.request("/api/onboard", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name, url: `${name.toLowerCase()}.example` }) });
  await res.text(); // let the stream finish, so "another business is being set up" is not what answers the next one
  return res;
};

describe("SlidingWindow", () => {
  it("allows max events in the window, then says how long to wait, and lets one in as the oldest falls out", () => {
    let t = 0;
    const w = new SlidingWindow({ max: 3, windowMs: 60_000 }, () => t);
    expect([w.take("a"), w.take("a"), w.take("a")]).toEqual([null, null, null]);
    expect(w.take("a")).toBe(60);
    t = 10_000;
    expect(w.take("a")).toBe(50); // a refused event is not recorded: the wait shrinks as time passes
    t = 60_001; // every event of the first minute has left the window
    expect([w.take("a"), w.take("a"), w.take("a")]).toEqual([null, null, null]);
    expect(w.take("a")).toBe(60);
    t = 90_000;
    expect(w.take("a")).toBe(31); // half a minute on, the wait is what is left of the window
  });

  it("keeps every key apart", () => {
    const w = new SlidingWindow({ max: 1, windowMs: 1000 }, () => 0);
    expect(w.take("a")).toBeNull();
    expect(w.take("b")).toBeNull();
    expect(w.take("a")).toBe(1);
  });

  it("keeps its memory bounded when a flood of different clients arrives", () => {
    let t = 0;
    const w = new SlidingWindow({ max: 1, windowMs: 1000 }, () => t, 100);
    for (let i = 0; i < 1000; i++) { t += 1; w.take(`client-${i}`); }
    expect((w as unknown as { hits: Map<string, number[]> }).hits.size).toBeLessThanOrEqual(100);
    // the newest clients are still remembered
    expect(w.take("client-999")).not.toBeNull();
  });

  it("refuses a limit that cannot work", () => {
    expect(() => new SlidingWindow({ max: 0, windowMs: 1000 })).toThrow();
    expect(() => new SlidingWindow({ max: 1, windowMs: 0 })).toThrow();
  });

  it("is on by default and switched off one door at a time", () => {
    const on = makeLimits(undefined, () => 0);
    expect([on.authOpen, on.authOpenAll, on.onboard, on.onboardRuns].every((x) => x !== null)).toBe(true);
    expect(DEFAULT_LIMITS.authOpen.max).toBeLessThanOrEqual(10);
    const off = makeLimits({ authOpen: false, onboardRuns: false }, () => 0);
    expect([off.authOpen, off.onboardRuns]).toEqual([null, null]);
    expect(off.authOpenAll).not.toBeNull();
  });
});

describe("clientKey", () => {
  const ctx = (headers: Record<string, string>, remote?: string) => ({
    req: { header: (n: string) => headers[n.toLowerCase()] }, env: remote ? { incoming: { socket: { remoteAddress: remote } } } : undefined,
  }) as never;
  it("is the connection's address, and believes no header unless a proxy is trusted", () => {
    expect(clientKey(ctx({ "x-forwarded-for": "203.0.113.66" }, "10.0.0.5"), false)).toBe("10.0.0.5");
    expect(clientKey(ctx({}), false)).toBe("unknown");
  });
  it("with a proxy trusted, is the last address in X-Forwarded-For (the one the proxy added), else X-Real-IP, else the connection", () => {
    expect(clientKey(ctx({ "x-forwarded-for": "203.0.113.66, 203.0.113.9" }, "10.0.0.5"), true)).toBe("203.0.113.9");
    expect(clientKey(ctx({ "x-real-ip": "203.0.113.7" }, "10.0.0.5"), true)).toBe("203.0.113.7");
    expect(clientKey(ctx({}, "10.0.0.5"), true)).toBe("10.0.0.5");
  });
});

describe("POST /api/auth/open", () => {
  it("lets a client try ten times a minute; the eleventh is a 429 with Retry-After, and reads nothing", async () => {
    const { app, verified } = appWith({ trustProxy: true });
    for (let i = 0; i < 10; i++) expect((await open(app, `wrong-${i}`, { "x-forwarded-for": "203.0.113.1" })).status).toBe(401);
    const refused = await open(app, "good", { "x-forwarded-for": "203.0.113.1" });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toEqual({ error: "Too many tries. Wait a minute, then open your link again." });
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(verified).toHaveLength(10); // the refused try cost no registry read
  });

  it("opens again once the minute has passed", async () => {
    const { app } = appWith({ trustProxy: true });
    for (let i = 0; i < 10; i++) await open(app, `wrong-${i}`, { "x-forwarded-for": "203.0.113.2" });
    expect((await open(app, "good", { "x-forwarded-for": "203.0.113.2" })).status).toBe(429);
    advance(61_000);
    const ok = await open(app, "good", { "x-forwarded-for": "203.0.113.2" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/^allevia_k_tenant_a=/);
  });

  it("one client's tries do not use up another's (proxy trusted: each has its own address)", async () => {
    const { app } = appWith({ trustProxy: true });
    for (let i = 0; i < 10; i++) await open(app, `wrong-${i}`, { "x-forwarded-for": "203.0.113.3" });
    expect((await open(app, "good", { "x-forwarded-for": "203.0.113.3" })).status).toBe(429);
    expect((await open(app, "good", { "x-forwarded-for": "203.0.113.4" })).status).toBe(200);
  });

  it("without a trusted proxy a header cannot move a client into a new bucket", async () => {
    const { app } = appWith({});
    for (let i = 0; i < 10; i++) await open(app, `wrong-${i}`, { "x-forwarded-for": `198.51.100.${i}` });
    expect((await open(app, "good", { "x-forwarded-for": "198.51.100.200" })).status).toBe(429);
  });

  it("everybody together are bounded too: a guesser who changes address every try still runs out", async () => {
    const { app } = appWith({ trustProxy: true, authOpen: { max: 5, windowMs: 60_000 }, authOpenAll: { max: 20, windowMs: 60_000 } });
    let refused = 0;
    for (let i = 0; i < 30; i++) if ((await open(app, `wrong-${i}`, { "x-forwarded-for": `203.0.113.${100 + i}` })).status === 429) refused++;
    expect(refused).toBe(10);
  });

  it("can be switched off, and does not apply when owner links are off (the route is not there)", async () => {
    const off = appWith({ authOpen: false, authOpenAll: false });
    for (let i = 0; i < 30; i++) expect((await open(off.app, `wrong-${i}`)).status).toBe(401);
    const noAuth = appWith(undefined, { auth: { enabled: false, verify: async () => null } });
    expect((await open(noAuth.app, "x")).status).toBe(404);
  });
});

describe("POST /api/onboard", () => {
  const op = { authorization: "Bearer op" };

  it("lets a client ask ten times in ten minutes, whoever they are; the eleventh is a 429 before anything is checked", async () => {
    const { app, onboarded, verified } = appWith({ trustProxy: true });
    for (let i = 0; i < 10; i++) expect((await setUp(app, `Shop${i}`, { ...op, "x-forwarded-for": "203.0.113.20" })).status).toBe(200);
    expect(onboarded).toHaveLength(10);
    const before = verified.length;
    const refused = await setUp(app, "OneTooMany", { ...op, "x-forwarded-for": "203.0.113.20" });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(onboarded).toHaveLength(10);
    expect(verified.length).toBe(before); // refused at the door: no token was read
    advance(11 * 60_000);
    expect((await setUp(app, "NextDay", { ...op, "x-forwarded-for": "203.0.113.20" })).status).toBe(200);
  });

  it("a stranger hammering it cannot use up the operator's set-ups: only requests that were let in count against everybody", async () => {
    const { app, onboarded } = appWith({ trustProxy: true, onboard: { max: 1000, windowMs: 60_000 }, onboardRuns: { max: 3, windowMs: 3_600_000 } });
    for (let i = 0; i < 50; i++) expect((await setUp(app, `Stranger${i}`, { "x-forwarded-for": "198.51.100.77" })).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await setUp(app, `Mine${i}`, { ...op, "x-forwarded-for": "203.0.113.30" })).status).toBe(200);
    expect(onboarded).toHaveLength(3);
    expect((await setUp(app, "Mine4", { ...op, "x-forwarded-for": "203.0.113.30" })).status).toBe(429);
    expect(onboarded).toHaveLength(3);
  });

  it("someone who is not the operator is refused, and does not count against the set-ups", async () => {
    const { app } = appWith({ trustProxy: true, onboardRuns: { max: 1, windowMs: 3_600_000 } });
    expect((await setUp(app, "Nope", { authorization: "Bearer good", "x-forwarded-for": "203.0.113.40" })).status).toBe(403);
    expect((await setUp(app, "Mine", { ...op, "x-forwarded-for": "203.0.113.41" })).status).toBe(200);
  });

  it("can be switched off", async () => {
    const { app } = appWith({ onboard: false, onboardRuns: false });
    for (let i = 0; i < 15; i++) expect((await setUp(app, `Free${i}`, op)).status).toBe(200);
  });
});

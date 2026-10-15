// The production engine on a fake `higgsfield` CLI: quote first, caps, the ledger, idempotency by job id, graceful
// declines, a private temp dir that is always removed, and a real exec runner that never goes through a shell.
// No credits are spent here: the fakes answer everything.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { CreditLedger, DailyCapReached, creditCaps, creditsWords } from "../../src/studio/credits.js";
import { ChainEngine, EngineDecline, FakeEngine, type EditInput, type EditOpts } from "../../src/studio/engine.js";
import { execCli, fetchResult, HiggsfieldEngine, parseBalance, parseCliJson, parseCost, parseJob, parseJobId, pickResultUrl } from "../../src/studio/higgsfield.js";
import { fakeCli, type FakeCliOpts } from "../helpers/fake-higgsfield.js";

const DAY = Date.parse("2026-10-15T09:00:00Z");
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const OPTS: EditOpts = { treatment: "relight-clean-editorial", aspect: "same" };
const PROMPT = "Edit this photo of Harbour House: relight softly. $(touch /tmp/pwned) `id` ; rm -rf / \"quoted\" 'single'";
let png: Buffer;
const input = (sha = "a".repeat(64)): EditInput => ({ image: Buffer.from("jpeg-bytes-of-the-owners-photo"), mime: "image/jpeg", originalSha256: sha, tenant: "kestrel_oak" });

function rig(cli: FakeCliOpts = {}, o: { caps?: { run: number; daily: number }; floor?: number; ledgerNow?: () => number } = {}) {
  const dataDir = tmp("allevia-hf-data-");
  const tmpRoot = tmp("allevia-hf-tmp-");
  const fake = fakeCli(cli);
  const ledger = new CreditLedger(dataDir, { now: o.ledgerNow ?? (() => DAY) });
  const quotes: string[] = [];
  const fetched: string[] = [];
  const engine = new HiggsfieldEngine({
    cli: fake.run, ledger, caps: o.caps ?? { run: 5, daily: 25 }, balanceFloor: o.floor ?? 20, tmpRoot,
    fetchImage: async (url) => { fetched.push(url); return png; },
    timeouts: { account: 1000, cost: 1000, create: 1000, wait: 2000 },
  });
  return { fake, ledger, engine, tmpRoot, quotes, fetched, dataDir };
}

const declined = async (p: Promise<unknown>): Promise<EngineDecline> => {
  try { await p; } catch (e) { if (e instanceof EngineDecline) return e; throw e; }
  throw new Error("expected an EngineDecline");
};

beforeEach(async () => { png = await sharp({ create: { width: 64, height: 80, channels: 3, background: "#aa8866" } }).png().toBuffer(); });

describe("the engine's happy path", () => {
  it("quotes first (spending nothing), then creates, reserves the job in the ledger, waits, fetches and marks it done", async () => {
    const r = rig({ status: "completed" });
    const q = await r.engine.quote(input(), PROMPT, OPTS);
    expect(q).toEqual({ credits: 2, words: "about 2 Studio credits" });
    expect(r.fake.calls.map((c) => c.slice(0, 3).filter((a) => !a.startsWith("--")).join(" "))).toEqual(["account status", "generate cost"]);
    expect(r.ledger.spentOn()).toBe(0);

    const res = await r.engine.edit(input(), PROMPT, { ...OPTS, onQuote: (x) => r.quotes.push(x.words) });
    const verbs = r.fake.calls.map((c) => c.filter((a) => !a.startsWith("--")).slice(0, 2).join(" "));
    expect(verbs.slice(2)).toEqual(["account status", "generate cost", "generate create", "generate wait", "generate get"]);
    expect(res).toMatchObject({ engine: "higgsfield", model: "nano_banana_2_1", credits: 2, recorded: false, jobId: r.fake.created[0] });
    expect(res.image.equals(png)).toBe(true);
    expect(r.fetched).toEqual(["https://cdn.example.test/out.png"]); // the result, not the thumbnail
    expect(r.quotes).toEqual(["about 2 Studio credits"]);
    expect(r.ledger.entries()).toMatchObject([{ jobId: r.fake.created[0], credits: 2, status: "done", tenant: "kestrel_oak", model: "nano_banana_2_1" }]);
    expect(r.ledger.spentOn()).toBe(2);
  });

  it("hands the CLI an argument array: the prompt is one element, untouched, and nothing is run by a shell", async () => {
    const r = rig();
    await r.engine.edit(input(), PROMPT, OPTS);
    const create = r.fake.calls.find((c) => c.includes("create"))!;
    expect(create[create.indexOf("--prompt") + 1]).toBe(PROMPT);
    expect(create.filter((a) => a === PROMPT)).toHaveLength(1);
    expect(existsSync("/tmp/pwned")).toBe(false);
    expect(create).toContain("--resolution");
    expect(create[create.indexOf("--resolution") + 1]).toBe("2k");
  });

  it("passes the photo as a file in a private directory that exists while the CLI uses it and is deleted afterwards", async () => {
    const r = rig();
    await r.engine.edit(input(), PROMPT, OPTS);
    expect(r.fake.images.length).toBeGreaterThanOrEqual(2); // cost, then create
    for (const im of r.fake.images) {
      expect(im.existed).toBe(true);
      expect(im.dirMode).toBe(0o700);
      expect(im.fileMode).toBe(0o600);
      expect(im.bytes).toBe(input().image.length);
      expect(existsSync(im.path)).toBe(false); // gone now
    }
    expect(readdirSync(r.tmpRoot)).toEqual([]);
  });

  it("the temp directory is removed when the job fails too", async () => {
    const r = rig({ status: "failed" });
    await declined(r.engine.edit(input(), PROMPT, OPTS));
    expect(readdirSync(r.tmpRoot)).toEqual([]);
  });

  it("a prompt that starts with a dash cannot become a flag", async () => {
    const r = rig();
    await r.engine.edit(input("b".repeat(64)), "--yes --prompt do something else", OPTS);
    const create = r.fake.calls.find((c) => c.includes("create"))!;
    expect(create[create.indexOf("--prompt") + 1]).toMatch(/^Edit: --yes/);
  });
});

describe("caps", () => {
  it("refuses above the per-run cap before creating anything, in plain words", async () => {
    const r = rig({ cost: 6 });
    const d = await declined(r.engine.edit(input(), PROMPT, OPTS));
    expect(d.code).toBe("run-cap");
    expect(d.message).toMatch(/about 6 Studio credits, more than the 5 Studio credits allowed for one edit/);
    expect(r.fake.created).toEqual([]);
    expect(r.ledger.entries()).toEqual([]);
  });

  it("a request can tighten the cap but never loosen it", async () => {
    const r = rig({ cost: 3 });
    expect((await declined(r.engine.edit(input(), PROMPT, { ...OPTS, maxCredits: 2 }))).code).toBe("run-cap");
    expect(r.fake.created).toEqual([]);
  });

  it("the daily cap is checked before each run and shown in plain words", async () => {
    const r = rig({}, { caps: { run: 5, daily: 25 } });
    for (let i = 0; i < 12; i++) await r.ledger.reserve({ jobId: `old-${i}`, key: `k${i}`, tenant: "avs_atelier", model: "m", credits: 2 });
    expect(r.ledger.spentOn()).toBe(24);
    const d = await declined(r.engine.edit(input(), PROMPT, OPTS));
    expect(d.code).toBe("daily-cap");
    expect(d.message).toMatch(/Today's Studio budget for AI edits is used up \(24 Studio credits of 25 today\)/);
    expect(r.fake.created).toEqual([]);
  });

  it("the daily cap is also enforced inside the ledger's lock, so two runs cannot both spend the last credits", async () => {
    const dataDir = tmp("allevia-hf-race-");
    const ledger = new CreditLedger(dataDir, { now: () => DAY });
    const results = await Promise.allSettled([1, 2, 3].map((i) => ledger.reserve({ jobId: `j${i}`, key: `k${i}`, tenant: "t", model: "m", credits: 2 }, 5)));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((x) => x.status === "rejected").every((x) => (x as PromiseRejectedResult).reason instanceof DailyCapReached)).toBe(true);
    expect(ledger.spentOn()).toBe(4);
  });

  it("yesterday's spend does not count today", async () => {
    let now = DAY;
    const r = rig({}, { ledgerNow: () => now });
    await r.ledger.reserve({ jobId: "y", key: "ky", tenant: "t", model: "m", credits: 24 });
    now = DAY + 24 * 3_600_000;
    expect(r.ledger.spentOn()).toBe(0);
    await r.engine.edit(input(), PROMPT, OPTS);
    expect(r.fake.created).toHaveLength(1);
  });

  it("the caps come from the environment, with safe defaults", () => {
    expect(creditCaps({})).toEqual({ run: 5, daily: 25 });
    expect(creditCaps({ ALLEVIA_STUDIO_RUN_CREDIT_CAP: "3", ALLEVIA_STUDIO_DAILY_CREDIT_CAP: "40" })).toEqual({ run: 3, daily: 40 });
    expect(creditCaps({ ALLEVIA_STUDIO_RUN_CREDIT_CAP: "-1", ALLEVIA_STUDIO_DAILY_CREDIT_CAP: "lots" })).toEqual({ run: 5, daily: 25 });
  });

  it("says credits the way the owner reads them", () => {
    expect(creditsWords(1)).toBe("1 Studio credit");
    expect(creditsWords(2)).toBe("2 Studio credits");
    expect(creditsWords(2, { about: true })).toBe("about 2 Studio credits");
    expect(creditsWords(7.5, { about: true })).toBe("about 7.5 Studio credits");
  });
});

describe("idempotent by job id, and a failed or timed-out job costs nothing twice", () => {
  it("the same request again joins its job: one create, one charge", async () => {
    const r = rig();
    const a = await r.engine.edit(input(), PROMPT, OPTS);
    const b = await r.engine.edit(input(), PROMPT, OPTS);
    expect(r.fake.created).toHaveLength(1);
    expect(b.jobId).toBe(a.jobId);
    expect(r.ledger.entries()).toHaveLength(1);
    expect(r.ledger.spentOn()).toBe(2);
  });

  it("reserving the same job id again changes nothing", async () => {
    const r = rig();
    const e = { jobId: "j1", key: "k", tenant: "t", model: "m", credits: 2 };
    expect((await r.ledger.reserve(e)).created).toBe(true);
    expect((await r.ledger.reserve({ ...e, credits: 9 })).created).toBe(false);
    expect(r.ledger.spentOn()).toBe(2);
  });

  it("a failed job is marked failed and does not count; trying again makes one new job, charged once", async () => {
    let failing = true;
    const r = rig({ status: () => (failing ? "failed" : "completed") });
    const d = await declined(r.engine.edit(input(), PROMPT, OPTS));
    expect(d.code).toBe("failed");
    expect(d.message).toMatch(/No Studio credits were counted/);
    expect(r.ledger.entries()).toMatchObject([{ status: "failed" }]);
    expect(r.ledger.spentOn()).toBe(0);
    failing = false;
    const ok = await r.engine.edit(input(), PROMPT, OPTS);
    expect(r.fake.created).toHaveLength(2);
    expect(ok.jobId).toBe(r.fake.created[1]);
    expect(r.ledger.spentOn()).toBe(2); // the failed one never counted, the good one counts once
  });

  it("a job that is still running when the wait ends stays counted and is joined later, not created again", async () => {
    let state: "running" | "completed" = "running";
    const r = rig({ status: () => state });
    const d = await declined(r.engine.edit(input(), PROMPT, OPTS));
    expect(d.code).toBe("timeout");
    expect(d.message).toMatch(/not charged twice/);
    expect(r.ledger.spentOn()).toBe(2); // reserved: counted until it is known to have failed
    state = "completed";
    const ok = await r.engine.edit(input(), PROMPT, OPTS);
    expect(r.fake.created).toHaveLength(1);
    expect(ok.jobId).toBe(r.fake.created[0]);
    expect(r.ledger.entries()[0]!.status).toBe("done");
    expect(r.ledger.spentOn()).toBe(2);
  });

  it("a create that fails reserves nothing", async () => {
    const r = rig({ createFails: true });
    const d = await declined(r.engine.edit(input(), PROMPT, OPTS));
    expect(d.code).toBe("failed");
    expect(r.ledger.entries()).toEqual([]);
  });

  it("a result that cannot be downloaded leaves the job counted and joinable", async () => {
    const r = rig();
    const flaky = new HiggsfieldEngine({
      cli: r.fake.run, ledger: r.ledger, caps: { run: 5, daily: 25 }, balanceFloor: 20, tmpRoot: r.tmpRoot,
      fetchImage: async () => { throw new Error("network down"); }, timeouts: { account: 1000, cost: 1000, create: 1000, wait: 2000 },
    });
    expect((await declined(flaky.edit(input(), PROMPT, OPTS))).code).toBe("failed");
    expect(r.ledger.spentOn()).toBe(2);
    const ok = await r.engine.edit(input(), PROMPT, OPTS);
    expect(r.fake.created).toHaveLength(1);
    expect(ok.image.equals(png)).toBe(true);
  });
});

describe("degrades gracefully: the local variant still delivers", () => {
  it("not logged in", async () => {
    const r = rig({ loggedIn: false });
    const d = await declined(r.engine.edit(input(), PROMPT, OPTS));
    expect(d.code).toBe("not-logged-in");
    expect(d.message).toMatch(/isn't signed in right now, so I made the simple clean-up only/);
    expect(r.fake.calls).toHaveLength(1); // only the account check
  });
  it("the CLI is missing", async () => {
    const r = rig({ missing: true });
    const d = await declined(r.engine.edit(input(), PROMPT, OPTS));
    expect(d.code).toBe("missing");
    expect(d.message).toMatch(/isn't set up on this computer/);
  });
  it("the balance is low: the founder's own credits are protected by a floor", async () => {
    const r = rig({ balance: 21, cost: 2 });
    const d = await declined(r.engine.edit(input(), PROMPT, OPTS));
    expect(d.code).toBe("low-balance");
    expect(d.message).toMatch(/credits are running low/);
    expect(r.fake.created).toEqual([]);
  });
  it("a price it cannot read means nothing is generated", async () => {
    const r = rig({ cost: "garbage" });
    const d = await declined(r.engine.edit(input(), PROMPT, OPTS));
    expect(d.code).toBe("unavailable");
    expect(d.message).toMatch(/Nothing was spent/);
    expect(r.fake.created).toEqual([]);
  });
});

describe("the CLI's answers, read tolerantly", () => {
  it("cost, balance and job ids in the shapes the CLI may use", () => {
    expect(parseCost('{"credits": 2}')).toBe(2);
    expect(parseCost('progress...\n{"cost": "7.5"}')).toBe(7.5);
    expect(parseCost("nope")).toBeUndefined();
    expect(parseBalance('{"credits": 613.05, "email": "x@y.z"}')).toBe(613.05);
    expect(parseBalance("{}")).toBeUndefined();
    const id = "0a1b2c3d-1111-4222-8333-444455556666";
    expect(parseJobId(`{"job_ids":["${id}"]}`)).toBe(id);
    expect(parseJobId(`[{"id":"${id}","status":"queued"}]`)).toBe(id);
    expect(parseJobId(`{"jobs":[{"job_id":"${id}"}]}`)).toBe(id);
    expect(parseJobId(`created job ${id}`)).toBe(id);
    expect(parseCliJson("")).toBeUndefined();
  });
  it("a finished job's result URL is the picture, never a thumbnail or the input", () => {
    const j = parseJob(JSON.stringify([{ status: "Completed", params: { medias: [{ url: "https://cdn.example.test/input.png" }] }, results: [{ min_url: "https://cdn.example.test/min.webp", raw_url: "https://cdn.example.test/final.png" }] }]))!;
    expect(j.status).toBe("completed");
    expect(pickResultUrl(j, "image")).toBe("https://cdn.example.test/final.png");
    const v = parseJob(JSON.stringify({ job: { status: "completed", result: { url: "https://cdn.example.test/clip.mp4", poster: "https://cdn.example.test/poster.jpg" } } }))!;
    expect(pickResultUrl(v, "video")).toBe("https://cdn.example.test/clip.mp4");
  });
  it("only public https addresses are fetched", async () => {
    await expect(fetchResult("http://cdn.example.test/a.png")).rejects.toThrow(/public https/);
    await expect(fetchResult("https://localhost/a.png")).rejects.toThrow(/public https/);
    await expect(fetchResult("https://127.0.0.1/a.png")).rejects.toThrow(/public https/);
    await expect(fetchResult("https://192.168.1.4/a.png")).rejects.toThrow(/public https/);
    const ok = await fetchResult("https://cdn.example.test/a.png", (async () => new Response(new Uint8Array(500), { status: 200 })) as unknown as typeof fetch);
    expect(ok.length).toBe(500);
    await expect(fetchResult("https://cdn.example.test/a.png", (async () => new Response("no", { status: 404 })) as unknown as typeof fetch)).rejects.toThrow(/404/);
  });
});

describe("the real exec runner (against a fake executable)", () => {
  const bin = fileURLToPath(new URL("../fixtures/fake-higgsfield.mjs", import.meta.url));
  let log: string;
  beforeEach(() => { log = join(tmp("allevia-hf-log-"), "calls.jsonl"); process.env.FAKE_HF_LOG = log; delete process.env.FAKE_HF_MODE; });
  afterEach(() => { delete process.env.FAKE_HF_LOG; delete process.env.FAKE_HF_MODE; });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; imageExists: boolean | null; imageMode: number | null }) : []);

  it("passes each argument as its own element: shell characters in a prompt do nothing", async () => {
    const run = execCli(bin);
    const marker = join(tmp("allevia-hf-marker-"), "pwned");
    const nasty = `x"; touch ${marker}; echo "$(touch ${marker})" \`touch ${marker}\` && rm -rf /`;
    const r = await run(["--json", "generate", "cost", "nano_banana_2_1", "--prompt", nasty], { timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(parseCost(r.stdout)).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(calls()[0]!.args).toEqual(["--json", "generate", "cost", "nano_banana_2_1", "--prompt", nasty]);
  });

  it("kills a CLI that hangs and says so", async () => {
    process.env.FAKE_HF_MODE = "sleep";
    const t0 = Date.now();
    const r = await execCli(bin)(["--json", "account", "status"], { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("a missing CLI is reported, not thrown", async () => {
    const r = await execCli("/nonexistent/higgsfield-nope")(["--json", "account", "status"]);
    expect(r).toMatchObject({ missing: true, code: null });
  });

  it("a whole edit through the real runner: photo file private, deleted afterwards, nothing in the tmp root", async () => {
    const dataDir = tmp("allevia-hf-data-");
    const tmpRoot = tmp("allevia-hf-tmp-");
    const engine = new HiggsfieldEngine({
      cli: execCli(bin), ledger: new CreditLedger(dataDir, { now: () => DAY }), caps: { run: 5, daily: 25 }, balanceFloor: 20, tmpRoot,
      fetchImage: async () => png, timeouts: { account: 5000, cost: 5000, create: 5000, wait: 5000 },
    });
    const res = await engine.edit(input(), PROMPT, OPTS);
    expect(res.jobId).toBe("0a1b2c3d-1111-4222-8333-444455556666");
    const withImage = calls().filter((c) => c.imageExists !== null);
    expect(withImage.length).toBe(2);
    for (const c of withImage) expect(c.imageExists).toBe(true);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});

describe("the chain of engines", () => {
  it("a recording wins for free; a decline from one engine does not stop the next; the last decline is the one heard", async () => {
    const fake = new FakeEngine(async () => Buffer.from("x"), { credits: 0 });
    const decliner = { name: "decline", edit: async () => { throw new EngineDecline("daily-cap", "Today's Studio budget for AI edits is used up."); } };
    expect((await new ChainEngine([decliner, fake]).edit(input(), "p", OPTS))?.engine).toBe("fake");
    expect((await declined(new ChainEngine([decliner]).edit(input(), "p", OPTS))).code).toBe("daily-cap");
    expect(await new ChainEngine([{ name: "none", edit: async () => null }]).edit(input(), "p", OPTS)).toBeNull();
    await expect(new ChainEngine([{ name: "boom", edit: async () => { throw new Error("bug"); } }]).edit(input(), "p", OPTS)).rejects.toThrow("bug");
  });
});

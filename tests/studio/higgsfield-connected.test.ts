// The Studio on the business's own Higgsfield, connected through Composio (app-higgsfield_mcp), with a fake Composio that answers
// the toolkit's actions the way the live service did on 17 Oct 2026 (BALANCE {credits}, GENERATE_IMAGE get_cost {cost}, ...).
// The same money rules as the CLI path: quote first, the caps, the ledger, joining a job instead of paying twice. And the server
// with no CLI (Linux ARM) never tries it, never crashes, and says so in plain words. No live calls, nothing spent.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { CreditLedger } from "../../src/studio/credits.js";
import { EngineDecline, type EditInput, type EditOpts } from "../../src/studio/engine.js";
import { CliBackend, cliProbe, HiggsfieldEngine, OffBackend, pickBackend, type CliRun } from "../../src/studio/higgsfield.js";
import { ComposioHiggsfieldBackend, jsonParams, mediaRole, type McpCall } from "../../src/studio/higgsfield-composio.js";
import { higgsfieldCreativeEngine } from "../../src/creative/wiring.js";
import { realComposioClient } from "../../src/connections/composio.js";

const DAY = Date.parse("2026-10-17T09:00:00Z");
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const JOB = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const MEDIA = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const OPTS: EditOpts = { treatment: "relight-clean-editorial", aspect: "4:5" };
const input = (): EditInput => ({ image: Buffer.from("jpeg-bytes-of-the-owners-photo"), mime: "image/jpeg", originalSha256: "b".repeat(64), tenant: "aamdani" });

interface FakeOpts { credits?: number; cost?: number; jobStatus?: "completed" | "failed" | "in_progress"; generateAnswer?: Record<string, unknown>; throwOn?: { tool: string; error: Error } }

function fakeComposio(o: FakeOpts = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const puts: Array<{ url: string; type: string; bytes: number }> = [];
  const ops: string[] = [];
  const call: McpCall = async (tool, args) => {
    calls.push({ tool, args });
    if (o.throwOn?.tool === tool) throw o.throwOn.error;
    switch (tool) {
      case "HIGGSFIELD_MCP_BALANCE": return { credits: o.credits ?? 509.67, subscription_plan_type: "max" };
      case "HIGGSFIELD_MCP_MEDIA_UPLOAD": return { uploads: [{ upload_url: "https://uploads.example.test/put?sig=1", media_id: MEDIA, content_type: "image/jpeg", method: "PUT", expires_in_seconds: 900, instructions: "PUT the bytes" }] };
      case "HIGGSFIELD_MCP_MEDIA_CONFIRM": return { results: [{ media_id: MEDIA, status: "confirmed" }] };
      case "HIGGSFIELD_MCP_GENERATE_IMAGE":
      case "HIGGSFIELD_MCP_GENERATE_VIDEO": {
        const p = (args.params ?? {}) as Record<string, unknown>;
        if (p.get_cost) return { cost: { credits: Math.max(1, Math.floor(o.cost ?? 2)), credits_exact: o.cost ?? 2 } };
        return o.generateAnswer ?? { results: [{ id: JOB, type: tool.endsWith("VIDEO") ? "video" : "image", status: "queued", model: p.model, params: { prompt: p.prompt } }] };
      }
      case "HIGGSFIELD_MCP_JOBS_WAIT": {
        const s = o.jobStatus ?? "completed";
        return { jobs: [{ index: 0, job_id: JOB, status: s, ...(s === "completed" ? { result_url: "https://cdn.example.test/result.png", thumbnail_url: "https://cdn.example.test/thumb.png" } : {}) }], summary: {}, all_terminal: s !== "in_progress", poll_after_seconds: 1 };
      }
      default: throw new Error(`unexpected ${tool}`);
    }
  };
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    puts.push({ url: String(url), type: String((init?.headers as Record<string, string>)["content-type"]), bytes: (init?.body as Uint8Array).length });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  let t = DAY;
  const backend = new ComposioHiggsfieldBackend({ session: async (op, fn) => { ops.push(op); return fn(call); }, fetchFn, waitMs: 5_000, sleep: async (ms) => { t += ms; }, now: () => t });
  return { calls, puts, ops, backend };
}

async function rig(o: FakeOpts = {}, caps = { run: 5, daily: 25 }) {
  const png = await sharp({ create: { width: 64, height: 80, channels: 3, background: "#aa8866" } }).png().toBuffer();
  const f = fakeComposio(o);
  const ledger = new CreditLedger(tmp("allevia-hfc-"), { now: () => DAY });
  const fetched: string[] = [];
  const engine = new HiggsfieldEngine({ backend: f.backend, ledger, caps, balanceFloor: 20, fetchImage: async (u) => { fetched.push(u); return png; } });
  return { ...f, ledger, engine, fetched, png };
}

const declined = async (p: Promise<unknown>): Promise<EngineDecline> => {
  try { await p; } catch (e) { if (e instanceof EngineDecline) return e; throw e; }
  throw new Error("expected an EngineDecline");
};
const OWNER_SAFE = (s: string) => expect(s).not.toMatch(/HIGGSFIELD_MCP|app-higgsfield|higgsfield_mcp|composio|media_id|Native CLI|linux-arm64|\/tmp\/|[0-9a-f]{8}-[0-9a-f]{4}-/i);

describe("the Studio on the business's connected Higgsfield (Composio)", () => {
  it("edits a photo: uploads it privately, prices it (nothing submitted), then generates from credits, waits, fetches, ledgers", async () => {
    const r = await rig();
    const quotes: string[] = [];
    const res = await r.engine.edit(input(), "Relight softly.", { ...OPTS, onQuote: (q) => quotes.push(q.words) });
    expect(res).toMatchObject({ engine: "higgsfield", model: "nano_banana_2_1", credits: 2, jobId: JOB, recorded: false });
    expect(r.calls.map((c) => c.tool.replace("HIGGSFIELD_MCP_", ""))).toEqual(["MEDIA_UPLOAD", "MEDIA_CONFIRM", "BALANCE", "GENERATE_IMAGE", "GENERATE_IMAGE", "JOBS_WAIT"]);
    expect(r.puts).toEqual([{ url: "https://uploads.example.test/put?sig=1", type: "image/jpeg", bytes: input().image.length }]);
    const [price, make] = r.calls.filter((c) => c.tool === "HIGGSFIELD_MCP_GENERATE_IMAGE").map((c) => c.args.params as Record<string, unknown>);
    expect(price).toMatchObject({ get_cost: true, model: "nano_banana_2_1", aspect_ratio: "4:5", resolution: "2k", use_unlim: false, medias: [{ role: "image_references", value: MEDIA }] });
    expect(make).toMatchObject({ model: "nano_banana_2_1", use_unlim: false, medias: [{ role: "image_references", value: MEDIA }] });
    expect(make).not.toHaveProperty("get_cost");
    expect(quotes).toEqual(["about 2 Studio credits"]);
    expect(r.fetched).toEqual(["https://cdn.example.test/result.png"]);
    expect(r.ledger.entries()).toMatchObject([{ jobId: JOB, credits: 2, status: "done", tenant: "aamdani" }]);
  });

  it("the same request again joins its job: nothing is uploaded, priced or generated twice", async () => {
    const r = await rig({ jobStatus: "in_progress" });
    expect((await declined(r.engine.edit(input(), "Relight softly.", OPTS))).code).toBe("timeout");
    const before = r.calls.filter((c) => /GENERATE|UPLOAD/.test(c.tool) && !(c.args.params as { get_cost?: boolean } | undefined)?.get_cost).length;
    await declined(r.engine.edit(input(), "Relight softly.", OPTS));
    expect(r.calls.filter((c) => /GENERATE|UPLOAD/.test(c.tool) && !(c.args.params as { get_cost?: boolean } | undefined)?.get_cost).length).toBe(before);
    expect(r.ledger.entries()).toHaveLength(1);
  });

  it("draws a poster's picture from a description with no upload, through the creating tools' engine", async () => {
    const r = await rig();
    const ce = higgsfieldCreativeEngine(r.engine, "aamdani");
    expect(await ce.status()).toMatchObject({ ok: true, credits: 509.67 });
    expect(await ce.quote({ prompt: "Dussehra evening, diyas on a doorstep", aspect: "4:5" })).toBe(2);
    const img = await ce.generate({ prompt: "Dussehra evening, diyas on a doorstep", aspect: "4:5" });
    expect(img).toMatchObject({ engine: "higgsfield", credits: 2, recorded: false });
    expect(r.calls.some((c) => c.tool === "HIGGSFIELD_MCP_MEDIA_UPLOAD")).toBe(false);
    const make = r.calls.filter((c) => c.tool === "HIGGSFIELD_MCP_GENERATE_IMAGE").map((c) => c.args.params as Record<string, unknown>).at(-1)!;
    expect(make).not.toHaveProperty("medias");
  });

  it("makes a clip from a still: the start frame's role, a whole-number duration and silent sound", async () => {
    const r = await rig();
    const out = await r.engine.clip({ image: Buffer.from("frame"), tenant: "aamdani", sourceSha256: "c".repeat(64), prompt: "A slow push-in." });
    expect(out).toMatchObject({ jobId: JOB, credits: 2, model: "kling3_0" });
    const make = r.calls.filter((c) => c.tool === "HIGGSFIELD_MCP_GENERATE_VIDEO").map((c) => c.args.params as Record<string, unknown>).at(-1)!;
    expect(make).toMatchObject({ model: "kling3_0", duration: 5, sound: "off", aspect_ratio: "9:16", medias: [{ role: "start_image", value: MEDIA }] });
  });

  it("keeps the caps exactly: over the per-run cap nothing is generated", async () => {
    const r = await rig({ cost: 7 });
    expect((await declined(r.engine.edit(input(), "Relight softly.", OPTS))).code).toBe("run-cap");
    expect(r.calls.filter((c) => c.tool === "HIGGSFIELD_MCP_GENERATE_IMAGE" && !(c.args.params as { get_cost?: boolean }).get_cost)).toHaveLength(0);
    expect(r.ledger.entries()).toHaveLength(0);
  });

  it("a failed job is marked failed and not counted", async () => {
    const r = await rig({ jobStatus: "failed" });
    expect((await declined(r.engine.edit(input(), "Relight softly.", OPTS))).code).toBe("failed");
    expect(r.ledger.entries()).toMatchObject([{ status: "failed" }]);
  });

  it("says no in plain words: low credits, a dropped connection, a request to buy, an unexpected error", async () => {
    const low = await rig({ credits: 10 });
    const d1 = await declined(low.engine.edit(input(), "x", OPTS));
    expect(d1.code).toBe("low-balance");
    const buy = await rig({ generateAnswer: { error: "Not enough credits", upgrade_url: "https://higgsfield.example.test/buy" } });
    const d2 = await declined(buy.engine.edit(input(), "x", OPTS));
    expect(d2.code).toBe("low-balance");
    const err = Object.assign(new Error("app-higgsfield_mcp isn't connected"), { name: "NotConnectedError" });
    const gone = await rig({ throwOn: { tool: "HIGGSFIELD_MCP_BALANCE", error: err } });
    const d3 = await declined(gone.engine.preflight("aamdani"));
    expect(d3.code).toBe("not-logged-in");
    const odd = await rig({ throwOn: { tool: "HIGGSFIELD_MCP_GENERATE_IMAGE", error: new Error("HIGGSFIELD_MCP_GENERATE_IMAGE 500 at /tmp/x for ca_123") } });
    const d4 = await declined(odd.engine.draw({ prompt: "x", aspect: "1:1", tenant: "aamdani" }));
    for (const d of [d1, d2, d3, d4]) OWNER_SAFE(d.message);
  });

  it("maps the CLI's parameters to the action's JSON and each model's media role", () => {
    expect(jsonParams({ duration: "5", generate_audio: "false", aspect_ratio: "9:16", resolution: "720p" })).toEqual({ duration: 5, generate_audio: false, aspect_ratio: "9:16", resolution: "720p" });
    expect(mediaRole("nano_banana_2_1", "image")).toBe("image_references");
    expect(mediaRole("gpt_image_2", "image")).toBe("image");
    expect(mediaRole("seedance_2_0", "video")).toBe("start_image");
  });
});

describe("choosing the backend, and never crashing on a missing CLI", () => {
  const cliSays = (r: Partial<{ code: number | null; stdout: string; stderr: string; missing: boolean }>): { run: CliRun; calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, run: async (args) => { calls.push(args); return { code: 1, stdout: "", stderr: "", timedOut: false, missing: false, ...r }; } };
  };

  it("the business's connected Higgsfield comes first", async () => {
    const f = fakeComposio();
    const cli = cliSays({ code: 0, stdout: "1.1.0" });
    const pick = pickBackend({ connected: async (t) => (t === "aamdani" ? f.backend : null), cli: new CliBackend({ cli: cli.run }), cliUsable: cliProbe(cli.run, { platform: "darwin", arch: "arm64" }) });
    expect((await pick("aamdani")).name).toBe("higgsfield-connected");
    expect((await pick("avs_atelier")).name).toBe("higgsfield-cli");
  });

  it("on Linux ARM the CLI is never even tried, and with no connection pictures are 'not switched on yet'", async () => {
    const cli = cliSays({ code: 1, stderr: "Error: Native CLI binary for linux-arm64 not found" });
    const probe = cliProbe(cli.run, { platform: "linux", arch: "arm64" });
    expect(await probe()).toBe(false);
    expect(cli.calls).toHaveLength(0);
    const engine = new HiggsfieldEngine({ backend: pickBackend({ connected: async () => null, cli: new CliBackend({ cli: cli.run }), cliUsable: probe }), ledger: new CreditLedger(tmp("allevia-hfp-")) });
    const d = await declined(engine.draw({ prompt: "x", aspect: "1:1", tenant: "aamdani" }));
    expect(d.code).toBe("missing");
    expect(d.message).toBe("Picture making isn't switched on yet, so I made the simple clean-up only.");
    expect(cli.calls).toHaveLength(0);
    expect(await higgsfieldCreativeEngine(engine, "aamdani").status()).toEqual({ ok: false, reason: "no_cli", plain: "pictures aren't switched on yet" });
  });

  it("a CLI that answers 'no build for this computer' counts as missing, never as a raw error", async () => {
    const cli = cliSays({ code: 1, stderr: "Error: Native CLI binary for linux-arm64 not found" });
    expect(await cliProbe(cli.run, { platform: "darwin", arch: "x64" })()).toBe(false);
    const d = await declined(new CliBackend({ cli: cli.run }).balance());
    expect(d.code).toBe("missing");
    OWNER_SAFE(d.message);
  });

  it("a backend that throws something unexpected is said plainly, and the creating tools never echo it", async () => {
    const boom = new OffBackend();
    boom.balance = async () => { throw new Error("spawn higgsfield EACCES: Native CLI binary for linux-arm64 not found"); };
    const engine = new HiggsfieldEngine({ backend: boom, ledger: new CreditLedger(tmp("allevia-hfb-")) });
    const st = await higgsfieldCreativeEngine(engine, "aamdani").status();
    expect(st).toEqual({ ok: false, reason: "error", plain: "picture making failed just now" });
  });
});

describe("Composio lists and runs the latest toolkit version", () => {
  it("asks for toolkit_versions=latest when listing, and version latest when executing", async () => {
    const sent: Array<{ url: string; body?: string }> = [];
    const fetchFn = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      sent.push({ url, ...(init?.body ? { body: init.body } : {}) });
      const text = JSON.stringify(url.includes("/tools?") ? { items: [{ slug: "HIGGSFIELD_MCP_BALANCE", name: "Balance", description: "credits", input_parameters: { properties: {} } }] } : { data: { credits: 1 }, successful: true });
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    };
    const c = realComposioClient("k", fetchFn);
    expect((await c.tools("higgsfield_mcp")).map((t) => t.slug)).toEqual(["HIGGSFIELD_MCP_BALANCE"]);
    expect(new URL(sent[0]!.url).searchParams.get("toolkit_versions")).toBe("latest");
    await c.execute({ tool: "HIGGSFIELD_MCP_BALANCE", accountId: "ca_1", userId: "al_x", args: {} });
    expect(JSON.parse(sent[1]!.body!)).toMatchObject({ version: "latest", connected_account_id: "ca_1", arguments: {} });
  });
});

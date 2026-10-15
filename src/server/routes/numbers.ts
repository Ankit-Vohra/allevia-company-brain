// "Add your numbers": the owner drops a spreadsheet of their own numbers (visits, orders, enquiries, sales...) and the
// goals read them (src/connectors/upload/). Two steps, so nothing is decided for the owner:
//   POST /api/:t/numbers/preview   multipart {file}: what we found, in plain words, with our guess for every column
//   POST /api/:t/numbers/import    multipart {file, plan}: the plan as the owner confirmed or edited it; writes the numbers
//   GET  /api/:t/numbers           the files added so far, newest first
// The file travels with each call (nothing is kept between them), so there is no server-side session to expire and no
// memory held for a half-finished upload. Caps: 20 MB, 50,000 rows, 100 columns, two uploads being read at once on the
// whole server; every refusal is a sentence an owner can act on. Both POSTs are refused in public mode. Discord can call
// the same two functions (previewUpload, importUpload) with an attachment's bytes.
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import { z } from "zod";
import { previewTable } from "../../connectors/upload/analyse.js";
import { businessFacts, importNumbers, type ImportResult } from "../../connectors/upload/import.js";
import { MAX_FILE_BYTES, UploadError } from "../../connectors/upload/limits.js";
import { readTable } from "../../connectors/upload/table.js";
import type { Preview, UploadPlan } from "../../connectors/upload/types.js";
import type { GraphHandle } from "../../graph/client.js";
import { currentProgram, programGoals } from "../../program/program.js";
import { HttpError, type RouteCtx } from "../http.js";

export const NUMBERS_UPLOAD_PATH = /^\/api\/[^/]+\/numbers\/(?:preview|import)$/;
const MAX_READING = 2;

const PlanBody = z.object({
  dateColumn: z.number().int().min(0).max(200),
  dateOrder: z.enum(["dmy", "mdy"]),
  cadence: z.enum(["day", "week", "month", "ranges"]).nullable(),
  weekAnchor: z.enum(["start", "end"]),
  columns: z.array(z.object({ index: z.number().int().min(0).max(200), metric: z.string().max(60).nullable(), label: z.string().max(60).optional() })).max(100),
});

export interface UploadedNumbers { fileName: string; bytes: Buffer }

// What a surface needs for the first step: the guess for this file, with the goals it would fill in.
export async function previewUpload(g: GraphHandle, businessId: string, file: UploadedNumbers): Promise<Preview> {
  const facts = await businessFacts(g, businessId);
  const p = previewTable(readTable(file.bytes, file.fileName), {
    fileName: file.fileName, fileHash: createHash("sha256").update(file.bytes).digest("hex"), ...(facts.countryCode ? { country: facts.countryCode } : {}),
  });
  const keys = new Set(p.plan.columns.map((c) => c.metric).filter((m): m is string => !!m && m !== "skip" && m !== "other"));
  const program = await currentProgram(g, businessId);
  const goals = program ? await programGoals(g, program.id) : [];
  const feeds = goals.filter((gl) => gl.sources.some((s) => keys.has(s.metric)) || keys.has(gl.metricKey)).map((gl) => ({ id: gl.id, name: gl.name }));
  return feeds.length ? { ...p, feedsGoals: feeds } : p;
}

export const importUpload = (g: GraphHandle, businessId: string, file: UploadedNumbers, plan: UploadPlan, now: number): Promise<ImportResult> =>
  importNumbers({ g, businessId, fileName: file.fileName, bytes: file.bytes, plan, now });

export function registerNumbersRoutes(app: Hono, ctx: RouteCtx): void {
  let reading = 0;
  const tooBig = (c: import("hono").Context) => c.json({ error: "That file is too big: send one under 20 MB. A row per day or week is plenty." }, 413);
  const limit = bodyLimit({ maxSize: MAX_FILE_BYTES + 256 * 1024, onError: tooBig });

  async function receive(c: import("hono").Context): Promise<{ file: UploadedNumbers; form: Record<string, string | File | (string | File)[]> }> {
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw new HttpError(400, "Send the spreadsheet as multipart/form-data with a `file` field.");
    }
    const f = form.file;
    if (!(f instanceof File) || f.size === 0) throw new HttpError(400, "Add a spreadsheet first (a .csv or .xlsx file).");
    if (f.size > MAX_FILE_BYTES) throw new HttpError(413, "That file is too big: send one under 20 MB. A row per day or week is plenty.");
    return { file: { fileName: f.name || "your file", bytes: Buffer.from(await f.arrayBuffer()) }, form };
  }

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (reading >= MAX_READING) throw new HttpError(429, "We're reading other files right now. Try again in a minute.");
    reading++;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof UploadError) throw new HttpError(e.code === "too_big" ? 413 : 400, e.message);
      throw e;
    } finally {
      reading--;
    }
  }

  app.post("/api/:t/numbers/preview", limit, async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const { file } = await receive(c);
    return c.json(await guarded(() => previewUpload(g, reg.businessId, file)));
  });

  app.post("/api/:t/numbers/import", limit, async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const { file, form } = await receive(c);
    let plan: UploadPlan;
    try {
      const raw = typeof form.plan === "string" ? (JSON.parse(form.plan) as unknown) : undefined;
      const r = PlanBody.safeParse(raw);
      if (!r.success) throw new Error("bad plan");
      plan = r.data as UploadPlan;
    } catch {
      throw new HttpError(400, "Send what you confirmed about the columns as `plan` (the preview's plan, with any changes).");
    }
    return c.json(await guarded(() => importUpload(g, reg.businessId, file, plan, ctx.now())));
  });

  app.get("/api/:t/numbers", async (c) => {
    const { g } = await ctx.tenantOf(c);
    const rows = await g.roQuery<{ id: string; file: string | null; from: string | null; to: string | null; at: number | null; status: string | null; rows: number | null }>(
      `MATCH (d:Document {kind:'upload'}) RETURN d.id AS id, d.filename AS file, d.firstDate AS from, d.lastDate AS to, d.uploadedAt AS at, d.status AS status, d.rows AS rows
       ORDER BY coalesce(d.uploadedAt, 0) DESC, d.id LIMIT 50`);
    return c.json({ uploads: rows.map((r) => ({ id: r.id, fileName: r.file ?? "your file", from: r.from, to: r.to, uploadedAt: r.at ? new Date(r.at).toISOString() : null, rows: r.rows ?? 0, replaced: r.status === "replaced" })) });
  });
}

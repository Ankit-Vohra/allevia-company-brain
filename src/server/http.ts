// What every route file shares: the JSON error (HttpError, turned into {error} by app.ts's onError), body parsing
// against a zod schema, and the per-request context a route needs from createApp (the tenant's graph, the clock, the
// public-mode guard).
import type { Context } from "hono";
import type { z } from "zod";
import type { GraphHandle } from "../graph/client.js";

export class HttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 501 | 503, message: string) {
    super(message);
  }
}

export async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "The request body must be JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HttpError(400, `Bad request: ${issue ? `${issue.path.join(".") || "body"} ${issue.message}` : "invalid body"}.`);
  }
  return r.data;
}

export interface TenantRef { slug: string; name: string; businessId: string; demo?: boolean }

export interface RouteCtx {
  tenantOf: (c: Context) => Promise<{ reg: TenantRef; g: GraphHandle }>;
  // A registered tenant by slug, for a route whose path has no tenant in it (the Google redirect back, where the tenant
  // comes from the signed state): a 404 for anything not in the registry.
  tenantBySlug?: (slug: string) => Promise<{ reg: TenantRef; g: GraphHandle }>;
  refuseInPublicMode: () => void;
  publicMode: boolean;
  now: () => number;
  log: (line: string) => void;
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

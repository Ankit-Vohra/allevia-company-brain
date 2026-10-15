// Owner tokens: the credential behind "open with your link" (docs/tenant-isolation.md, "Who may open a business").
//
// A token is `<scope>.<secret>`: the scope is one business's slug (or `operator`, for the person who runs Allevia), the
// secret is 32 random bytes in base64url (256 bits, so it cannot be guessed or brute-forced). Only the SHA-256 of the
// secret is stored, as an (:AuthToken) node in the registry graph (allevia_meta), next to the (:Tenant) nodes:
//   {tokenId, scope, hash, label, createdAt, expiresAt?, revokedAt?}
// The token itself is shown once, when it is issued, and cannot be read back. A fast hash is right here because the
// secret is already 256 random bits; there is nothing to guess and nothing for a slow hash to protect. Looking a token
// up is one indexed read by hash, so revoking takes effect on the very next request. The scope in the token is a
// convenience (it picks the cookie and rejects a token for another business without a read); the stored scope decides.
import { createHash, randomBytes } from "node:crypto";
import { openGraphByName } from "../graph/client.js";
import { ensureIndexes } from "../graph/indexes.js";
import { isTenantSlug } from "../graph/slug.js";
import { getTenant, metaName, type TenantOpts } from "../graph/tenants.js";

export const OPERATOR_SCOPE = "operator";
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_LENGTH = 100;

export interface TokenOpts extends TenantOpts { now?: number }

export interface IssuedToken { token: string; tokenId: string; scope: string; label: string; createdAt: number; expiresAt?: number }
export interface VerifiedToken { scope: string; tokenId: string }
export interface TokenInfo { tokenId: string; scope: string; label: string; createdAt: number; expiresAt: number | null; revoked: boolean; revokedAt: number | null }

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const isScope = (s: unknown): s is string => s === OPERATOR_SCOPE || isTenantSlug(s);

// `<scope>.<secret>`, or null for anything else (including a string with whitespace, a prefix, a case change or extra parts).
export function parseToken(raw: unknown): { scope: string; secret: string } | null {
  if (typeof raw !== "string" || raw.length > MAX_TOKEN_LENGTH) return null;
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const scope = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  return isScope(scope) && SECRET.test(secret) ? { scope, secret } : null;
}

async function registry(opts?: TokenOpts) {
  return openGraphByName(metaName(opts));
}

const missingGraph = (e: unknown): boolean => /empty key/i.test(String((e as Error)?.message));

export async function issueToken(scope: string, o: { label?: string; expiresAt?: number } = {}, opts?: TokenOpts): Promise<IssuedToken> {
  if (!isScope(scope)) throw new Error(`scope must be a tenant slug or "${OPERATOR_SCOPE}", got ${JSON.stringify(scope)}`);
  const now = opts?.now ?? Date.now();
  if (o.expiresAt !== undefined && !(Number.isFinite(o.expiresAt) && o.expiresAt > now)) throw new Error("expiresAt must be a time in the future");
  if (scope !== OPERATOR_SCOPE && !(await getTenant(scope, opts))) throw new Error(`No such business "${scope}" in the registry. Onboard it first.`);
  const secret = randomBytes(32).toString("base64url");
  const tokenId = `tok_${randomBytes(5).toString("hex")}`;
  const label = (o.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const meta = await registry(opts);
  await ensureIndexes(meta, [
    { label: "AuthToken", prop: "hash", type: "RANGE" }, { label: "AuthToken", prop: "tokenId", type: "RANGE" }, { label: "AuthToken", prop: "scope", type: "RANGE" },
  ]);
  await meta.query(
    "CREATE (t:AuthToken {tokenId:$tokenId, scope:$scope, hash:$hash, label:$label, createdAt:$now}) SET t.expiresAt = $expiresAt",
    { tokenId, scope, hash: sha256(secret), label, now, expiresAt: o.expiresAt ?? null });
  return { token: `${scope}.${secret}`, tokenId, scope, label, createdAt: now, ...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}) };
}

// The token's scope and id when it is one we issued, not revoked and not expired; otherwise null. Never throws on a
// token that is merely wrong; a registry that cannot be reached throws (the caller refuses the request).
export async function verifyToken(raw: unknown, opts?: TokenOpts): Promise<VerifiedToken | null> {
  const parsed = parseToken(raw);
  if (!parsed) return null;
  const meta = await registry(opts);
  let rows: Array<{ scope: string; tokenId: string; revokedAt: number | null; expiresAt: number | null }>;
  try {
    rows = await meta.roQuery("MATCH (t:AuthToken {hash:$hash}) RETURN t.scope AS scope, t.tokenId AS tokenId, t.revokedAt AS revokedAt, t.expiresAt AS expiresAt LIMIT 1", { hash: sha256(parsed.secret) });
  } catch (e) {
    if (missingGraph(e)) return null;
    throw e;
  }
  const t = rows[0];
  if (!t || t.scope !== parsed.scope || (t.revokedAt !== null && t.revokedAt !== undefined)) return null;
  if (t.expiresAt !== null && t.expiresAt !== undefined && t.expiresAt <= (opts?.now ?? Date.now())) return null;
  return { scope: t.scope, tokenId: t.tokenId };
}

// What the CLI lists. Never the hash, never the token.
export async function listTokens(o: { scope?: string } = {}, opts?: TokenOpts): Promise<TokenInfo[]> {
  const meta = await registry(opts);
  try {
    const rows = await meta.roQuery<{ tokenId: string; scope: string; label: string | null; createdAt: number; expiresAt: number | null; revokedAt: number | null }>(
      `MATCH (t:AuthToken) WHERE $scope IS NULL OR t.scope = $scope
       RETURN t.tokenId AS tokenId, t.scope AS scope, t.label AS label, t.createdAt AS createdAt, t.expiresAt AS expiresAt, t.revokedAt AS revokedAt, id(t) AS rid
       ORDER BY createdAt, rid`, { scope: o.scope ?? null });
    return rows.map((r) => ({
      tokenId: r.tokenId, scope: r.scope, label: r.label ?? "", createdAt: r.createdAt, expiresAt: r.expiresAt ?? null,
      revoked: r.revokedAt !== null && r.revokedAt !== undefined, revokedAt: r.revokedAt ?? null,
    }));
  } catch (e) {
    if (missingGraph(e)) return [];
    throw e;
  }
}

// Revokes one token (by its id) or every live token of one scope. Returns how many it revoked now.
export async function revokeToken(which: { tokenId: string } | { scope: string }, opts?: TokenOpts): Promise<number> {
  const now = opts?.now ?? Date.now();
  const meta = await registry(opts);
  try {
    const rows = "tokenId" in which
      ? await meta.query<{ n: number }>("MATCH (t:AuthToken {tokenId:$id}) WHERE t.revokedAt IS NULL SET t.revokedAt = $now RETURN count(t) AS n", { id: which.tokenId, now })
      : await meta.query<{ n: number }>("MATCH (t:AuthToken {scope:$scope}) WHERE t.revokedAt IS NULL SET t.revokedAt = $now RETURN count(t) AS n", { scope: which.scope, now });
    return rows[0]?.n ?? 0;
  } catch (e) {
    if (missingGraph(e)) return 0;
    throw e;
  }
}

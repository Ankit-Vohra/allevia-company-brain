// Sealing connector secrets (OAuth tokens) at rest. AES-256-GCM with a key derived (HKDF-SHA256) from the server's
// connector key and bound to the tenant and the connector: the derived key, and the authenticated data, both name the
// tenant, so a sealed file copied into another tenant's folder, or opened under another connector's name, fails to open.
// Format: v1.<nonce>.<tag>.<ciphertext>, each part base64url. Nothing here logs or returns the key or a plain value on error.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const MIN_KEY_CHARS = 32;
export class SealError extends Error {
  override name = "SealError";
}

const b64 = (b: Buffer): string => b.toString("base64url");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64url");

function derive(key: string, tenant: string, connector: string, purpose: string): Buffer {
  if (typeof key !== "string" || key.length < MIN_KEY_CHARS) {
    throw new SealError(`The connector key is missing or too short (it needs at least ${MIN_KEY_CHARS} characters). Set ALLEVIA_CONNECTOR_KEY.`);
  }
  return Buffer.from(hkdfSync("sha256", Buffer.from(key, "utf8"), Buffer.from(`allevia:${purpose}`), Buffer.from(`${tenant}\u0000${connector}`), 32));
}

export function seal(key: string, tenant: string, connector: string, value: unknown): string {
  const k = derive(key, tenant, connector, "seal");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(Buffer.from(`${tenant}\u0000${connector}`));
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return `v1.${b64(iv)}.${b64(c.getAuthTag())}.${b64(body)}`;
}

export function open<T = unknown>(key: string, tenant: string, connector: string, sealed: string): T {
  const k = derive(key, tenant, connector, "seal");
  try {
    const [v, iv, tag, body] = sealed.trim().split(".");
    if (v !== "v1" || !iv || !tag || !body) throw new Error("format");
    const d = createDecipheriv("aes-256-gcm", k, unb64(iv));
    d.setAAD(Buffer.from(`${tenant}\u0000${connector}`));
    d.setAuthTag(unb64(tag));
    return JSON.parse(Buffer.concat([d.update(unb64(body)), d.final()]).toString("utf8")) as T;
  } catch {
    throw new SealError("The stored connection could not be opened (wrong key, another business's file, or damaged). Connect it again.");
  }
}

// A signed, expiring value for the OAuth `state` parameter: it carries the tenant through Google and back, and cannot be
// forged or moved to another tenant without the key.
export function signState(key: string, payload: Record<string, string | number>): string {
  const k = derive(key, "state", "oauth", "sign");
  const body = b64(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${b64(createHmac("sha256", k).update(body).digest())}`;
}

export function verifyState<T extends Record<string, string | number>>(key: string, state: string): T | null {
  try {
    const k = derive(key, "state", "oauth", "sign");
    const [body, sig] = state.split(".");
    if (!body || !sig) return null;
    const want = createHmac("sha256", k).update(body).digest();
    const got = unb64(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    return JSON.parse(unb64(body).toString("utf8")) as T;
  } catch {
    return null;
  }
}

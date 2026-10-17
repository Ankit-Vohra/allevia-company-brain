// Passwords for accounts (docs/tenant-isolation.md, "Accounts"). A password is never stored: only its scrypt hash, with its own
// random salt and the cost settings it was made with, as one string `scrypt$<N>$<r>$<p>$<salt>$<hash>` (base64url), so the cost
// can be raised later without breaking the passwords stored before.
//
// Why scrypt with N=2^15, r=8, p=1: it is built into Node (no native module to install), and it is memory-hard (32 MB a try), so
// a stolen hash costs a guesser real memory and time per guess, on a GPU too; these are the settings OWASP lists for scrypt. A
// password is compared in constant time. An email with no account still pays for one hash (burnTime), so how long a sign-in
// takes does not tell anyone whether the address has an account.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";

export const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLength: 64, saltBytes: 16 } as const;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200; // a password is hashed on every sign-in, so its length is bounded

// 128 * N * r bytes is what scrypt needs (32 MB here); Node's default ceiling is exactly that, so give it room.
const MAX_MEM = 64 * 1024 * 1024;
// What a stored hash may ask for: a hash with wilder settings is not ours (and must not make a sign-in cost a gigabyte).
const N_RANGE = { min: 2 ** 14, max: 2 ** 17 };

function scrypt(password: BinaryLike, salt: Buffer, keyLength: number, o: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, keyLength, { ...o, maxmem: MAX_MEM }, (e, key) => (e ? reject(e) : resolve(key))));
}

// The same password typed on two keyboards can arrive as different code points ("é" as one or two); NFKC makes them one.
const bytesOf = (password: string): Buffer => Buffer.from(password.normalize("NFKC"), "utf8");

/** The plain sentence for a password that cannot be used, or null when it is fine. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "Choose a password.";
  if ([...password].length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for your password.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters for your password.`;
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await scrypt(bytesOf(password), salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

interface Parsed { N: number; r: number; p: number; salt: Buffer; key: Buffer }

function parse(stored: unknown): Parsed | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (!Number.isInteger(N) || N < N_RANGE.min || N > N_RANGE.max || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 16 || key.length < 32) return null;
  return { N, r, p, salt, key };
}

/** True when `password` is the one `stored` was made from. False for anything else, including a hash that is not ours. */
export async function verifyPassword(password: unknown, stored: unknown): Promise<boolean> {
  const h = parse(stored);
  if (!h || typeof password !== "string" || password.length > MAX_PASSWORD) {
    await burnTime(typeof password === "string" ? password.slice(0, MAX_PASSWORD) : "");
    return false;
  }
  const key = await scrypt(bytesOf(password), h.salt, h.key.length, { N: h.N, r: h.r, p: h.p });
  return key.length === h.key.length && timingSafeEqual(key, h.key);
}

// One hash's worth of work for a sign-in that has no account to check against, so it takes as long as one that does.
let dummy: Promise<string> | undefined;
export async function burnTime(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(18).toString("base64url"));
  const h = parse(await dummy)!;
  await scrypt(bytesOf(password || "x"), h.salt, h.key.length, { N: h.N, r: h.r, p: h.p });
}

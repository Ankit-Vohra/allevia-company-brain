// Passwords (src/auth/passwords.ts): scrypt with N=2^15, r=8, p=1 and a 16-byte salt of its own per password, compared in
// constant time, at least 10 characters. No database.
import { describe, expect, it } from "vitest";
import { MIN_PASSWORD, SCRYPT, burnTime, hashPassword, passwordProblem, verifyPassword } from "../../src/auth/passwords.js";

describe("password hashing", () => {
  it("keeps the cost settings and a fresh salt with every hash, and never the password", async () => {
    const pw = "correct horse battery";
    const [a, b] = [await hashPassword(pw), await hashPassword(pw)];
    expect(a).not.toBe(b); // a salt of its own each time
    const [kind, N, r, p, salt, key] = a.split("$");
    expect([kind, Number(N), Number(r), Number(p)]).toEqual(["scrypt", 2 ** 15, 8, 1]);
    expect(SCRYPT).toMatchObject({ N: 2 ** 15, r: 8, p: 1, saltBytes: 16 });
    expect(Buffer.from(salt!, "base64url")).toHaveLength(16);
    expect(Buffer.from(key!, "base64url")).toHaveLength(64);
    expect(a).not.toContain(pw);
    expect(a).not.toContain(Buffer.from(pw).toString("base64url"));
  });

  it("checks the right password and refuses every other", async () => {
    const stored = await hashPassword("Kestrel&Oak-2026");
    expect(await verifyPassword("Kestrel&Oak-2026", stored)).toBe(true);
    for (const wrong of ["kestrel&oak-2026", "Kestrel&Oak-2026 ", " Kestrel&Oak-2026", "Kestrel&Oak-202", "", "x".repeat(5000)]) {
      expect(await verifyPassword(wrong, stored), JSON.stringify(wrong).slice(0, 30)).toBe(false);
    }
    expect(await verifyPassword(undefined, stored)).toBe(false);
    expect(await verifyPassword(42, stored)).toBe(false);
  });

  it("reads the same password typed with composed or decomposed letters as one (NFKC)", async () => {
    const stored = await hashPassword("café-au-lait-42");
    expect(await verifyPassword("café-au-lait-42", stored)).toBe(true);
  });

  it("refuses a stored value that is not one of its hashes, including one that asks for a huge cost", async () => {
    const good = await hashPassword("long enough password");
    const [, , r, p, salt, key] = good.split("$");
    for (const bad of ["", "plain", "scrypt$1$1$1$a$b", `scrypt$${2 ** 24}$${r}$${p}$${salt}$${key}`, `scrypt$32769$${r}$${p}$${salt}$${key}`, `bcrypt$${2 ** 15}$${r}$${p}$${salt}$${key}`, null, 7]) {
      expect(await verifyPassword("long enough password", bad), String(bad).slice(0, 40)).toBe(false);
    }
  });

  it("asks for at least 10 characters, and bounds the length", async () => {
    expect(MIN_PASSWORD).toBe(10);
    expect(passwordProblem("123456789")).toMatch(/at least 10 characters/);
    expect(passwordProblem("1234567890")).toBeNull();
    expect(passwordProblem("x".repeat(201))).toMatch(/at most/);
    expect(passwordProblem(undefined)).toMatch(/Choose a password/);
    await expect(hashPassword("short")).rejects.toThrow(/at least 10/);
  });

  it("does a hash's worth of work for a sign-in with no account to check (burnTime)", async () => {
    const t0 = performance.now();
    await burnTime("anything at all");
    await burnTime("anything at all");
    expect(performance.now() - t0).toBeGreaterThan(5); // scrypt at these settings is tens of milliseconds, never free
  });
});

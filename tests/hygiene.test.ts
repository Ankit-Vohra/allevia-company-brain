// Repo hygiene: this repository goes public, so no real identifier may reach it. Two checks.
//
//  1. Every tracked text file under src/, shared/, docs/, scripts/, web/src/ and tests/ is run through the redaction
//     detectors (the same ones that guard the graph). Any hit fails, except the explicit allowlists below.
//  2. When the real vault is on this machine, every value the detectors find in the vault (an e-mail, a phone number, a
//     CIN, a D-U-N-S, a Team ID, an AWS or Supabase id, a credential) must be absent from EVERY tracked file, fixtures
//     included. This catches a real value pasted without the label that made the detector recognise it.
//
// Failure messages name `path:line kind` and never the matched value, so a leak is not copied into a log.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findSensitive, type Hit } from "../src/ingest/redact.js";
import { BRAIN_PATH } from "./helpers/vault.js";

const REPO = new URL("../", import.meta.url).pathname;
const SCAN_ROOTS = ["src/", "shared/", "docs/", "scripts/", "web/src/", "tests/"];

// Files that plant synthetic patterns on purpose, or whose job is to describe them. Keep this list short.
const ALLOWED_PATHS: Array<{ test: (path: string) => boolean; why: string }> = [
  { test: (p) => p.startsWith("tests/fixtures/"), why: "synthetic fixtures with planted patterns (the fixture tests prove they are redacted)" },
  { test: (p) => /^tests\/ingest\/(?:privacy|redact|adr|pending)\.test\.ts$/.test(p), why: "the privacy and parser-redaction tests plant synthetic secrets, phones and ids" },
  { test: (p) => p === "src/ingest/redact.ts", why: "the detector's own comments give an example of each pattern" },
  { test: (p) => p === "tests/hygiene.test.ts", why: "plants synthetic values to prove the scanner works" },
];

// Exact matches that are documented, not real. Matched against what the detector reports, anywhere in the scanned files.
const ALLOWED_VALUES: Array<{ match: string; why: string }> = [
  { match: "~/.config/allevia/allevia.env", why: "Allevia's own documented config file (the path, not its contents)" },
  { match: "~/.config/…", why: "docs name the kind of path the privacy filter drops" },
  { match: "https://u:p@host", why: "plan: example input for the url-credentials test" },
  { match: "i-0abc123def4567890", why: "plan: example input for the aws-id test" },
  { match: "sg-0123456789abcdef0", why: "plan: example input for the aws-id test" },
  { match: "~/Documents/acme-secrets/x.txt", why: "plan: example input for the secret-path test (a made-up folder name)" },
  { match: "U12345MH2020PTC123456", why: "plan: example input for the cin test (patterned digits)" },
  { match: "123456789", why: "plan: example input for the D-U-N-S test (patterned digits)" },
  { match: "ABCDE12345", why: "plan: example input for the Team ID test (patterned)" },
  { match: "abcdefghijklmnopqrst", why: "plan: example input for the Supabase ref test (the alphabet)" },
  { match: "/ca.pem", why: "tests: a certificate file name in an environment fixture, not a key" },
  { match: "/cert.pem", why: "tests: a certificate file name in an environment fixture, not a key" },
  { match: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", why: "tests: the standard SHA-256 test vector for \"abc\"" },
];

// ---------- what counts as a real identifier ----------

// The detectors over-redact on purpose, and they are tuned to prose: on source code they also fire on `cacheKey = f(x)`.
// These classes are not identifiers, so they are not hits:
//   - loopback, the unspecified address, and the three RFC 5737 documentation ranges
//   - addresses at the reserved example domains, and the commit-trailer address
//   - a `secret` that is not credential-shaped (code punctuation, whitespace, under six characters, or no digit);
//     a private key block is always a hit
const credentialShaped = (m: string): boolean =>
  m.startsWith("-----BEGIN") || (m.length >= 6 && /\d/.test(m) && /[A-Za-z]/.test(m) && !/[()[\]{}<>!;,|\s]/.test(m));

export function isBenign(h: Hit): boolean {
  switch (h.kind) {
    case "ipv4": return /^(?:127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(h.match);
    case "email": return /@example\.(?:com|org|net)$/i.test(h.match) || h.match === "noreply@anthropic.com";
    case "secret": return !credentialShaped(h.match);
    default: return false;
  }
}

const allowedValue = (h: Hit): boolean => ALLOWED_VALUES.some((a) => a.match === h.match);
const allowedPath = (path: string): boolean => ALLOWED_PATHS.some((a) => a.test(path));
const lineOf = (text: string, match: string): number => {
  const i = text.indexOf(match);
  return i < 0 ? 1 : text.slice(0, i).split("\n").length;
};

// Offenders in one file as `path:line kind`: never the value.
export function scanText(path: string, text: string): string[] {
  if (allowedPath(path)) return [];
  return findSensitive(text).filter((h) => !isBenign(h) && !allowedValue(h)).map((h) => `${path}:${lineOf(text, h.match)} ${h.kind}`);
}

// ---------- files ----------

const MAX_BYTES = 2_000_000;
function readText(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_BYTES) return undefined;
    const t = readFileSync(path, "utf8");
    return t.includes("\u0000") ? undefined : t; // binary
  } catch {
    return undefined;
  }
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);

// ---------- the scanner itself ----------

describe("scanText (the scanner is not vacuous)", () => {
  // Built from parts so this file does not contain a literal that trips the detectors it tests.
  const publicIp = ["8", "8", "4", "4"].join(".");
  const mail = ["ceo", "bigshop.in"].join("@");
  const phone = ["+91", "98765", "12345"].join(" ");
  const key = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0"].join("");
  const secretPath = ["~", "Documents", "shop-secrets", "keys.txt"].join("/");

  it("flags a public address, a real-looking e-mail, a phone, a credential and a secrets path, and names the line", () => {
    const text = `ok\nhost ${publicIp}\nmail ${mail}\ncall ${phone}\ntoken ${key}\nsee ${secretPath}\n`;
    expect(scanText("src/x.ts", text).sort()).toEqual([
      "src/x.ts:2 ipv4", "src/x.ts:3 email", "src/x.ts:4 phone", "src/x.ts:5 secret", "src/x.ts:6 secret-path",
    ]);
  });

  it("never puts the matched value in the offender text", () => {
    const out = scanText("docs/a.md", `${mail} ${key} ${publicIp}`).join("\n");
    for (const v of [mail, key, publicIp]) expect(out).not.toContain(v);
  });

  it("flags a labelled company identifier", () => {
    const cin = ["U", "74999", "DL", "2015", "PTC", "123456"].join("");
    expect(scanText("docs/a.md", `Registered as ${cin}.`)).toEqual(["docs/a.md:1 cin"]);
    expect(scanText("docs/a.md", `D-U-N-S ${["48", "000", "9999"].join("")}`)).toEqual(["docs/a.md:1 duns"]);
  });

  it("does not flag loopback, documentation addresses, example domains or code that merely looks like an assignment", () => {
    const text = [
      "redis://127.0.0.1:6390", "host 203.0.113.45", "write to ops@example.org", "Co-Authored-By: Claude <noreply@anthropic.com>",
      "const cacheKey = sha256(JSON.stringify([a, b]));", "KEY=VALUE", "if (apiKey === undefined) {}", "~/.config/allevia/allevia.env",
    ].join("\n");
    expect(scanText("src/x.ts", text)).toEqual([]);
  });

  it("skips the allowlisted paths and nothing else", () => {
    const text = `mail ${mail}`;
    expect(scanText("tests/fixtures/brain/x.yaml", text)).toEqual([]);
    expect(scanText("tests/ingest/privacy.test.ts", text)).toEqual([]);
    expect(scanText("tests/ingest/adr.test.ts", text)).toEqual([]);
    expect(scanText("tests/graph/upsert.test.ts", text)).toHaveLength(1);
    expect(scanText("src/graph/upsert.ts", text)).toHaveLength(1);
    expect(scanText("docs/superpowers/plans/x.md", text)).toHaveLength(1);
  });
});

// ---------- the repo ----------

describe("tracked files hold no real identifier (detector scan)", () => {
  const files = tracked.filter((p) => SCAN_ROOTS.some((r) => p.startsWith(r)));

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("src/, shared/, docs/, scripts/, web/src/ and tests/ pass the detectors", () => {
    const offenders = files.flatMap((p) => {
      const t = readText(join(REPO, p));
      return t === undefined ? [] : scanText(p, t);
    });
    expect(offenders).toEqual([]);
  });
});

// ---------- the real vault, when it is here ----------

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// Phones are compared by their last ten digits (so "+91 98765 12345" and "09876512345" are one number). A number made of
// one to three digits, or a run like 9876543210, is a placeholder people write on purpose, never a real contact.
const last10 = (s: string): string => s.replace(/\D/g, "").slice(-10);
const placeholderPhone = (d: string): boolean => new Set(d).size <= 3 || "01234567890".includes(d) || "09876543210".includes(d);
const COMPARED: Hit["kind"][] = ["email", "aws-id", "cin", "duns", "apple-team-id", "supabase-ref", "url-credentials", "ipv4", "secret"];

// `v` as a whole token: not glued to a letter or digit on either side.
function tokenIn(line: string, v: string): boolean {
  for (let i = line.indexOf(v); i >= 0; i = line.indexOf(v, i + 1)) {
    if (!/[a-z0-9]/.test(line[i - 1] ?? " ") && !/[a-z0-9]/.test(line[i + v.length] ?? " ")) return true;
  }
  return false;
}

describe("vault comparison helpers", () => {
  it("tokenIn matches a whole token only", () => {
    expect(tokenIn("mail ops@shop.in now", "ops@shop.in")).toBe(true);
    expect(tokenIn("mail xops@shop.in now", "ops@shop.in")).toBe(false);
    expect(tokenIn("ops@shop.in2", "ops@shop.in")).toBe(false);
    expect(tokenIn("a ops@shop.in b ops@shop.in", "ops@shop.in")).toBe(true);
  });

  it("phones compare by their last ten digits; patterned numbers are placeholders", () => {
    expect(last10("+91 98765 12345")).toBe(last10("09876512345"));
    expect(placeholderPhone("9876543210")).toBe(true);
    expect(placeholderPhone("7777777777")).toBe(true);
    expect(placeholderPhone("6000000001")).toBe(true);
    expect(placeholderPhone("9142857306")).toBe(false);
  });
});

describe.skipIf(!existsSync(BRAIN_PATH))("no real vault identifier appears in any tracked file", () => {
  // From the whole vault, the excluded folders too (that is where the sensitive values live).
  const values = new Map<string, Hit["kind"]>(); // lower-cased value -> kind
  const phones = new Set<string>();
  for (const p of walk(BRAIN_PATH)) {
    const t = readText(p);
    if (t === undefined) continue;
    for (const h of findSensitive(t)) {
      if (h.kind === "phone") {
        if (last10(h.match).length === 10 && !placeholderPhone(last10(h.match))) phones.add(last10(h.match));
      } else if (COMPARED.includes(h.kind) && !isBenign(h) && h.match.trim().length >= 7) {
        values.set(h.match.trim().toLowerCase(), h.kind);
      }
    }
  }

  it("found values to compare against (the vault is not empty of identifiers)", () => {
    expect(values.size).toBeGreaterThan(0);
    expect(phones.size).toBeGreaterThan(0);
  });

  it("none of them is in a tracked file", () => {
    const offenders = new Set<string>();
    for (const p of tracked) {
      if (p === "package-lock.json") continue;
      const t = readText(join(REPO, p));
      if (t === undefined) continue;
      t.toLowerCase().split("\n").forEach((low, i) => {
        for (const [v, kind] of values) if (tokenIn(low, v)) offenders.add(`${p}:${i + 1} ${kind}`);
      });
      for (const h of findSensitive(t)) if (h.kind === "phone" && phones.has(last10(h.match))) offenders.add(`${p}:${lineOf(t, h.match)} phone`);
    }
    expect([...offenders]).toEqual([]);
  });
});

// Repo hygiene: this repository goes public, so no real identifier may reach it. Two checks.
//
//  1. Every tracked text file except package-lock.json (source, tests, fixtures, docs, vendored files, root files, dot
//     folders) is run through the redaction detectors, the same ones that guard the graph. A hit fails unless the value is
//     clearly fake or is in ALLOWED_VALUES. There are no path exemptions: a fixture that plants an e-mail has to plant
//     one at an example domain.
//  2. When the real vault is on this machine, every value the detectors find in it (an e-mail, a phone number, a CIN, a
//     D-U-N-S, a Team ID, an AWS or Supabase id, a credential) must be absent from EVERY tracked file. This catches a real
//     value pasted without the label that made the detector recognise it.
//
// Failure messages name `path:line kind` and never the matched value, so a leak is not copied into a log.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findSensitive, type Hit } from "../src/ingest/redact.js";
import { BRAIN_PATH } from "./helpers/vault.js";

const REPO = new URL("../", import.meta.url).pathname;

// ---------- what counts as clearly fake ----------

// Made-up names that mark an example: acme, demo, widget, example, sample, dummy, fake, foo, bar, placeholder, and this
// project's own name (its config file lives under ~/.config/allevia).
const FAKE_WORD = /(?:^|[^a-z])(?:acme|demo|widget|example|sample|dummy|fake|foo|bar|placeholder|allevia)(?:[^a-z]|$)/i;

// Four or more consecutive digits or letters in either direction (1234, 9876, abcd, dcba), looked for in the digits and the
// letters on their own so that "0a1b2c3d4e5f" and "U12345MH2020" count; five or more of one character (00000, xxxxx); or
// nothing but one to three different characters.
function hasRun(s: string, min: number): boolean {
  let up = 1;
  let down = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    up = d === 1 ? up + 1 : 1;
    down = d === -1 ? down + 1 : 1;
    if (up >= min || down >= min) return true;
  }
  return false;
}
export function isPatterned(value: string): boolean {
  const alnum = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (alnum.length < 4) return false;
  return hasRun(alnum.replace(/\D/g, ""), 4) || hasRun(alnum.replace(/[^a-z]/g, ""), 4) || /(.)\1{4,}/.test(alnum) || new Set(alnum).size <= 3;
}

// Phones are compared by their last ten digits. Fiction ranges: US 555-01xx, UK Ofcom drama numbers (+44 7700 900xxx
// and 020 7946 0xxx).
export const last10 = (s: string): string => s.replace(/\D/g, "").slice(-10);
const FICTION_PHONE = /^(?:\d*555-?01\d\d|(?:44|0)?7700900\d{3}|(?:44|0)?2079460\d{3})$/;
export function isFakePhone(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  return isPatterned(last10(match)) || FICTION_PHONE.test(digits);
}

const credentialShaped = (m: string): boolean =>
  m.startsWith("-----BEGIN") || (m.length >= 6 && /\d/.test(m) && /[A-Za-z]/.test(m) && !/[()[\]{}<>!;,|\s]/.test(m));

// The detectors over-redact on purpose, and they are tuned to prose: on source code they also fire on `cacheKey = f(x)`.
// A hit is fine when it is one of these:
//   ipv4             reserved and special-purpose ranges (loopback, RFC 1918, link-local, CGNAT, documentation, benchmarking,
//                    multicast/reserved) and the public resolvers 8.8.8.8 / 1.1.1.1
//   email            an example.* domain, a reserved example TLD, a made-up or one-letter domain, the commit-trailer address
//   phone            patterned digits (9876543210), 555-01xx, +44 7700 900xxx, 020 7946 0xxx
//   cin, duns, apple-team-id, aws-id, supabase-ref   patterned (U12345…, 987654321, ABCDE12345, i-0123456789abcdef0)
//   url-credentials  a host at example.* or with a made-up name
//   secret-path      a path with a made-up name (acme, demo, widget, …) or this project's own config file
//   secret           not credential-shaped (code punctuation, under six characters, no digit), or patterned
export function isClearlyFake(h: Hit): boolean {
  const m = h.match;
  switch (h.kind) {
    // Reserved and special-purpose ranges identify nothing (an SSRF guard has to name them): loopback, 0/8, RFC 1918,
    // link-local (incl. the cloud metadata address), CGNAT, IETF/documentation/benchmarking, multicast and reserved,
    // plus the two well-known public resolvers. A real host's public address still fails.
    case "ipv4": return /^(?:127\.|0\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.0\.|192\.0\.2\.|198\.1[89]\.|198\.51\.100\.|203\.0\.113\.|2(?:2[4-9]|[3-5]\d)\.|8\.8\.8\.8$|1\.1\.1\.1$)/.test(m);
    case "email": {
      const domain = m.slice(m.lastIndexOf("@") + 1).replace(/^.*%40/, "").toLowerCase().replace(/\.$/, "");
      const labels = domain.split(".");
      const base = labels.length > 1 ? labels[labels.length - 2]! : labels[0]!;
      return m === "noreply@anthropic.com" || /(?:^|\.)example(?:\.[a-z]+)?$/.test(domain) || /\.(?:invalid|test|localhost)$/.test(domain)
        || FAKE_WORD.test(domain) || base.length <= 1;
    }
    case "phone": return isFakePhone(m);
    case "cin": case "duns": case "apple-team-id": case "aws-id": case "supabase-ref": return isPatterned(m);
    case "url-credentials": return FAKE_WORD.test(m.slice(m.lastIndexOf("@") + 1));
    case "secret-path": return FAKE_WORD.test(m) || /^\.[a-z0-9]+$/.test(m); // a bare extension (".pem") names no file
    case "secret": return !credentialShaped(m) || isPatterned(m);
    default: return false;
  }
}

// Exact matches that are neither patterned nor made up, but are documented: not real. Keep this list short.
const ALLOWED_VALUES: Array<{ match: string; why: string }> = [
  { match: "1ecea1993b7fce257ffbd686c070948b5e07eda6", why: "vendor/skills/i-have-adhd/NOTICE.md: the public git commit the MIT-licensed skill was taken from" },
  { match: "225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8", why: "vendor/skills/humanizer/NOTICE.md: the public commit the MIT-licensed humanizer skill was taken from" },
  { match: "ankit@allevia-ai.in", why: "site/src/company.ts: the public contact address printed on the website's legal and contact pages" },
  { match: "harjinder@allevia-ai.in", why: "the second public alias at the website's domain, listed for completeness" },
  { match: "172.32.0.1", why: "SSRF boundary test: the first address just outside RFC 1918 172.16/12" },
  { match: "+441174960000", why: "Ofcom reserved drama range (0117 496 0xxx), never assigned" },
  { match: "~/.config/…", why: "docs name the kind of path the privacy filter drops" },
  { match: "/home/u/…/secrets/…", why: "the detector's comment names the kind of path it drops" },
  { match: "https://u:p@host", why: "plan: example input for the url-credentials test" },
  { match: "scheme://user:pass@host/...", why: "the detector's comment shows the shape of a URL with credentials" },
  { match: "/ca.pem", why: "tests: a certificate file name in an environment fixture, not a key" },
  { match: "/cert.pem", why: "tests: a certificate file name in an environment fixture, not a key" },
  { match: "10-company/.env", why: "tests: a made-up path for the vault path policy" },
  { match: "10-company/id.pem", why: "tests: a made-up path for the vault path policy" },
  { match: "xkqzbtwhrnvdmfgjpsly", why: "tests and fixtures: a made-up 20-letter Supabase ref (random letters, not a real project)" },
  { match: "abc123", why: "tests: an invented password value" },
  { match: "ga4_sessions", why: "src/onboard/templates.ts: the name of the GA4 sessions metric a goal reads, not a credential" },
  { match: "hunter2", why: "tests: the classic invented password" },
  { match: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", why: "tests: the standard SHA-256 test vector for \"abc\"" },
  // upstream commit ids, public, pinned in the vendored and skill notices
  { match: "069432cac935ed1895859df201c31436c07fb74e", why: "NOTICE: pinned upstream commit of the vendored skill" },
  { match: "d03c56bb598be770c60b201f94237e5d1a4268a6", why: "vendor NOTICE: pinned upstream commit" },
  { match: "d7ea7852480601af9bc8870942af8311a410e567", why: "vendor NOTICE: pinned upstream commit" },
  { match: "4b99de2f7de7e7d5247042e5fb5b4ea9368ef734", why: "vendor NOTICE: pinned upstream commit" },
  { match: "2dc826f7b9aea762f5557e56ba88a3e515bd2fed", why: "vendor NOTICE: pinned upstream commit" },
  { match: "45f51253f2d2c67377dd092191ecfccf87df3237", why: "vendor/skills/marketingskills/NOTICE.md: pinned upstream commit" },
  { match: "e6b505348c39c6e751a70d52ff407e7b0a6bf676", why: "vendor/skills/knowledge-work-plugins/NOTICE.md: pinned upstream commit" },
  { match: "405ce209775f8cb8f9dbaa511656594bb682cf9f", why: "vendor/skills/localseoskills/NOTICE.md: pinned upstream commit" },
  { match: "ba75bb1b20d42af5746b246ad348c202419ae681", why: "vendor/skills/madr/NOTICE.md: pinned upstream commit" },
  { match: "com/2025-11-19-Workday-Signs-Definitive-Agreement-to-Acquire-Pipedream", why: "docs/connections-design.md: the path of a public Workday press-release URL, not a credential" },
  { match: "support@brand.com", why: "vendor/skills/marketingskills/sms/references/compliance.md: the upstream's placeholder support address in a HELP-reply template, kept verbatim" },
];

const allowedValue = (h: Hit): boolean => ALLOWED_VALUES.some((a) => a.match === h.match);
const lineOf = (text: string, match: string): number => {
  const i = text.indexOf(match);
  return i < 0 ? 1 : text.slice(0, i).split("\n").length;
};

// Offenders in one file as `path:line kind`: never the value.
export function scanText(path: string, text: string): string[] {
  return findSensitive(text).filter((h) => !isClearlyFake(h) && !allowedValue(h)).map((h) => `${path}:${lineOf(text, h.match)} ${h.kind}`);
}

// ---------- files ----------

const MAX_BYTES = 20_000_000;
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
const LOCKFILE = "package-lock.json"; // integrity hashes are not text
// any package-lock.json (root, web/, …): integrity hashes look like secrets but are not text
const isLockfile = (p: string): boolean => p === LOCKFILE || p.endsWith("/" + LOCKFILE);
const scanned = tracked.filter((p) => !isLockfile(p));

// ---------- the scanner itself ----------

describe("scanText (the scanner is not vacuous)", () => {
  // Built from parts so this file does not contain a literal that trips the detectors it tests.
  const publicIp = ["8", "8", "4", "4"].join(".");
  const mail = ["ceo", "bigshop.in"].join("@");
  const phone = ["+91", "98213", "70465"].join(" ");
  const key = ["gh", "p_", "Zq7Kd2Wm9XvB4nT8rLp3"].join("");
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
    const cin = ["U", "74999", "DL", "2015", "PTC", "630295"].join("");
    expect(scanText("docs/a.md", `Registered as ${cin}.`)).toEqual(["docs/a.md:1 cin"]);
    expect(scanText("docs/a.md", `D-U-N-S ${["48", "073", "9526"].join("")}`)).toEqual(["docs/a.md:1 duns"]);
    expect(scanText("docs/a.md", `Team ID ${["K7QM", "2X9PLA"].join("")}`)).toEqual(["docs/a.md:1 apple-team-id"]);
  });

  it("does not flag clearly fake values, wherever the file is (there are no path exemptions)", () => {
    const text = [
      "redis://127.0.0.1:6390", "hosts 192.0.2.7, 198.51.100.9 and 203.0.113.45",
      "write to ops@example.org, a@b.co or sales@acme-shop.in", "Co-Authored-By: Claude <noreply@anthropic.com>",
      "call +44 7700 900123, +1 (415) 555-0132, +44 20 7946 0958 or +91 98765 43210",
      "CIN U12345MH2020PTC123456, D-U-N-S 987654321, Team ID ABCDE12345",
      "i-0123456789abcdef0 and sg-0a1b2c3d4e5f60718",
      "see ~/Documents/acme-secrets/x.txt and ~/.config/widget/ops.env and ~/.config/allevia/allevia.env",
      "postgres://admin:pw@db.example.internal/app",
      "const cacheKey = sha256(JSON.stringify([a, b]));", "KEY=VALUE", "if (apiKey === undefined) {}",
    ].join("\n");
    for (const p of ["src/x.ts", "docs/a.md", "tests/fixtures/brain/x.yaml", "tests/ingest/redact.test.ts", ".env.example", "vendor/a.json"]) {
      expect(scanText(p, text), p).toEqual([]);
    }
  });

  it("fixtures get no exemption: the same real-looking value fails under tests/fixtures", () => {
    expect(scanText("tests/fixtures/brain/x.yaml", `mail ${mail}`)).toEqual(["tests/fixtures/brain/x.yaml:1 email"]);
    expect(scanText("tests/ingest/privacy.test.ts", `mail ${mail}`)).toHaveLength(1);
  });

  it("the explicit allowlist is by exact value", () => {
    expect(scanText("docs/a.md", "see https://u:p@host here")).toEqual([]);
    expect(scanText("docs/a.md", `see ${["https://u:p", "hostile.in"].join("@")} here`)).toHaveLength(1);
  });
});

describe("what counts as patterned or fictional", () => {
  it("recognises runs, repeats and low variety, in digits and in letters", () => {
    for (const v of ["987654321", "ABCDE12345", "U12345MH2020PTC123456", "i-0a1b2c3d4e5f60718", "abcdefghijklmnopqrst", "7777777777", "6000000001", "xxxxxxxxxxxx"]) {
      expect(isPatterned(v), v).toBe(true);
    }
    for (const v of ["xkqzbtwhrnvdmfgjpsly", "q8Zr3KfL0pXw9sTb2VnY", "81f3a9c27e", "K7QM2X9PLA"]) expect(isPatterned(v), v).toBe(false);
  });

  it("phones: patterned, 555-01xx and the UK drama ranges are fake; an ordinary number is not", () => {
    for (const v of ["+91 98765 43210", "09876543210", "+1 (415) 555-0132", "+44 7700 900123", "+44 20 7946 0958", "7777777777"]) {
      expect(isFakePhone(v), v).toBe(true);
    }
    expect(isFakePhone(["+91", "98213", "70465"].join(" "))).toBe(false);
    expect(isFakePhone(["+44", "7911", "462085"].join(" "))).toBe(false);
    expect(last10("+91 98765 12345")).toBe(last10("09876512345"));
  });
});

// ---------- the repo ----------

describe("tracked files hold no real identifier (detector scan)", () => {
  it("scans every tracked text file, binary files excepted", () => {
    expect(scanned.length).toBeGreaterThan(100);
    for (const root of ["src/", "shared/", "docs/", "scripts/", "tests/fixtures/", "vendor/", ".claude/"]) {
      expect(scanned.some((p) => p.startsWith(root)), root).toBe(true);
    }
    for (const p of [".env.example", ".gitignore", "package.json", "vitest.config.ts"]) expect(scanned, p).toContain(p);
    expect(scanned).not.toContain(LOCKFILE);
    const skipped = scanned.filter((p) => readText(join(REPO, p)) === undefined);
    expect(skipped.filter((p) => !/\.(?:png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|mp[34]|mov|wav|glb|wasm|ogg)$/i.test(p))).toEqual([]);
  });

  it("every one of them passes", () => {
    const offenders = scanned.flatMap((p) => {
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
    expect(tokenIn("mail ops@example.org now", "ops@example.org")).toBe(true);
    expect(tokenIn("mail xops@example.org now", "ops@example.org")).toBe(false);
    expect(tokenIn("ops@example.org2", "ops@example.org")).toBe(false);
    expect(tokenIn("a ops@example.org b ops@example.org", "ops@example.org")).toBe(true);
  });
});

describe.skipIf(!existsSync(BRAIN_PATH))("no real vault identifier appears in any tracked file", () => {
  // From the whole vault, the excluded folders too (that is where the sensitive values live). Values that are clearly
  // fake are skipped: the vault writes placeholders too, and so do the tests.
  const values = new Map<string, Hit["kind"]>(); // lower-cased value -> kind
  const phones = new Set<string>();
  for (const p of walk(BRAIN_PATH)) {
    const t = readText(p);
    if (t === undefined) continue;
    for (const h of findSensitive(t)) {
      if (isClearlyFake(h)) continue;
      if (h.kind === "phone") {
        if (last10(h.match).length === 10) phones.add(last10(h.match));
      } else if (COMPARED.includes(h.kind) && h.match.trim().length >= 7) {
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
    for (const p of scanned) {
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

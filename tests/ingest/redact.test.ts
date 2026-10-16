// Redaction tests. Every fixture is invented (documentation IP ranges, made-up ids), and token-shaped strings are
// assembled at run time so no secret-looking literal sits in the repo for a secret scanner to trip over.
import { describe, it, expect } from "vitest";
import { redact, findSensitive } from "../../src/ingest/redact.js";

const rep = (s: string, n: number) => s.repeat(n);

// Token shapes, built from parts.
const GH = "gh" + "p_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const GH_PAT = "github" + "_pat_" + "11ABCDEFG0" + "_" + "xYz9AbC8dEf7GhI6jKl5MnO4pQr3StU2vWx1";
const SK = "s" + "k-" + "proj-abc123DEF456ghi789JKL012";
const AKIA = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
const SLACK = "xo" + "xb-" + "123456789012-abcdefghijklmnop";
const JWT = "ey" + "J" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "abcDEF123_-xyz456";
const DISCORD = "M" + "TA2NzM4OTkxMjM0NTY3ODkwMTIz" + "." + "GaBcDe" + "." + "x1Y2z3A4b5C6d7E8f9G0h1I2j3K4l5M6n7O";
const GOOGLE = "AI" + "za" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";
const RAZORPAY = "rz" + "p_test_" + "Ab12Cd34Ef56Gh";
const RANDOM_B64 = "q8Zr3KfL0pXw" + "9sTb2VnYh6JdA4mCe1GuP7oIz5";
const RANDOM_HEX = "9f86d081884c7d659a2f" + "eaa0c55ad015a3bf4f1b";
const SUPA_REF = "xkqzbtwhrnvdmfgjpsly"; // 20 lowercase letters, no vowels: made up
const FAKE_KEY = "abcdefgh" + "12345678"; // an obviously invented credential value
const SLACK_HOOK = "https://hooks.slack" + ".com/services/T00000000/B00000000/" + "X".repeat(24);

describe("redact: each pattern from spec 6.3 is replaced and counted", () => {
  const cases: Array<[string, string, string, string?]> = [
    // [label, input, kind, expected output (default: the whole input becomes the placeholder)]
    ["ipv4", "host 203.0.113.45 is up", "ipv4", "host [redacted:ipv4] is up"],
    ["ipv4 end of sentence", "server at 192.0.2.7.", "ipv4", "server at [redacted:ipv4]."],
    ["aws instance id", "box i-0a1b2c3d4e5f60718 restarted", "aws-id", "box [redacted:aws-id] restarted"],
    ["aws short instance id", "i-0a1b2c3d", "aws-id", "[redacted:aws-id]"],
    ["aws security group", "sg-0123456789abcdef0", "aws-id", "[redacted:aws-id]"],
    ["aws vpc", "vpc-0abc1234def567890", "aws-id", "[redacted:aws-id]"],
    ["aws subnet", "subnet-0fedcba9876543210", "aws-id", "[redacted:aws-id]"],
    ["aws ami", "ami-0123456789abcdef0", "aws-id", "[redacted:aws-id]"],
    ["aws arn", "role arn:aws:iam::123456789012:role/demo-role,", "aws-id", "role [redacted:aws-id],"],
    ["aws account id after label", "AWS account id: 123456789012", "aws-id", "AWS account id: [redacted:aws-id]"],
    ["aws account number in backticks", "the server sits in AWS account `123456789012`, region x", "aws-id", "the server sits in AWS account `[redacted:aws-id]`, region x"],
    ["email truncated before the tld", 'Service account search-sync@demo-project."', "email", 'Service account [redacted:email]"'],
    ["s3 bucket uri", "dump to s3://demo-backups-123456789012/daily/x.sql.gz (14 d)", "aws-id", "dump to [redacted:aws-id] (14 d)"],
    ["email", "mail jane.doe+x@example.org now", "email", "mail [redacted:email] now"],
    ["gcp service account email", "search-sync@demo-project.iam.gserviceaccount.com", "email"],
    ["indian mobile with +91 and spaces", "call +91 98765 43210 today", "phone", "call [redacted:phone] today"],
    ["indian mobile +91 dash", "+91-9876543210", "phone"],
    ["indian mobile bare", "ring 9876543210.", "phone", "ring [redacted:phone]."],
    ["indian mobile 5+5", "98765 43210", "phone"],
    ["indian mobile 0 prefix", "09876543210", "phone"],
    ["indian mobile e164", "+919876543210", "phone"],
    ["us number", "+1 (415) 555-0132", "phone"],
    ["uk number", "+44 20 7946 0958", "phone"],
    ["github classic token", GH, "secret"],
    ["github fine-grained token", GH_PAT, "secret"],
    ["openai/anthropic style key", `key ${SK}`, "secret", "key [redacted:secret]"],
    ["short openai-style key", "key sk-test1234 here", "secret", "key [redacted:secret] here"],
    ["aws access key id", AKIA, "secret"],
    ["slack token", SLACK, "secret"],
    ["jwt", JWT, "secret"],
    ["discord bot token shape", DISCORD, "secret"],
    ["google api key", GOOGLE, "secret"],
    ["razorpay key id", RAZORPAY, "secret"],
    ["long random base64", `blob ${RANDOM_B64} end`, "secret", "blob [redacted:secret] end"],
    ["long random hex", `blob ${RANDOM_HEX} end`, "secret", "blob [redacted:secret] end"],
    ["private key block", "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", "secret"],
    ["discord webhook url", "https://discord.com/api/webhooks/123456789012345678/AbCdEf_gh-IJ", "secret"],
    ["env assignment keeps name", "FOO_TOKEN=abc", "secret", "FOO_TOKEN=[redacted:secret]"],
    ["env assignment keeps the sentence period", "Use FOO_TOKEN=abc123.", "secret", "Use FOO_TOKEN=[redacted:secret]."],
    ["env assignment quoted", 'SUPABASE_SERVICE_ROLE_KEY="s3cr3t value"', "secret", "SUPABASE_SERVICE_ROLE_KEY=[redacted:secret]"],
    ["env assignment password", "DB_PASSWORD='hunter2'", "secret", "DB_PASSWORD=[redacted:secret]"],
    ["env assignment pass", "API_PASS=x1", "secret", "API_PASS=[redacted:secret]"],
    ["env assignment lower snake", "set api_key=abc123 then", "secret", "set api_key=[redacted:secret] then"],
    ["env assignment camelCase", "authToken=abc123", "secret", "authToken=[redacted:secret]"],
    ["url with credentials", "see https://u:p@host.example/path now", "url-credentials", "see [redacted:url-credentials] now"],
    ["db url with credentials", "postgres://admin:hunter2@db.example.internal:5432/app", "url-credentials", "[redacted:url-credentials]"],
    ["secret path in Documents", "saved to ~/Documents/acme-secrets/x.txt.", "secret-path", "saved to [redacted:secret-path]."],
    ["secret path dotdir", "~/.acme-secrets/token", "secret-path"],
    ["secret path config", "env ~/.config/acme/ops.env (mode 600)", "secret-path", "env [redacted:secret-path] (mode 600)"],
    ["secret path home secrets", "/home/demo/app/secrets/marketing.txt", "secret-path"],
    ["secret path relative env file", "in secrets/widget.env on the box", "secret-path", "in [redacted:secret-path] on the box"],
    ["secret path pem", "key at ~/.ssh/demo-box.pem", "secret-path", "key at [redacted:secret-path]"],
    ["bare pem file", "use demo-box.pem for login", "secret-path", "use [redacted:secret-path] for login"],
    ["cin", "CIN U12345MH2020PTC123456 on the certificate", "cin", "CIN [redacted:cin] on the certificate"],
    ["duns", "D-U-N-S number 987654321 issued", "duns", "D-U-N-S number [redacted:duns] issued"],
    ["duns no dashes", "DUNS: 987654321", "duns", "DUNS: [redacted:duns]"],
    ["duns grouped", "D-U-N-S 98-765-4321", "duns", "D-U-N-S [redacted:duns]"],
    ["apple team id", "Team ID ABCDE12345 in the portal", "apple-team-id", "Team ID [redacted:apple-team-id] in the portal"],
    ["apple team id punctuated", "Team ID: `ABCDE12345`", "apple-team-id", "Team ID: `[redacted:apple-team-id]`"],
    ["supabase ref in host", `https://${SUPA_REF}.supabase.co/rest/v1`, "supabase-ref", "https://[redacted:supabase-ref].supabase.co/rest/v1"],
    ["supabase ref near the word", `Supabase prod (${SUPA_REF}, London)`, "supabase-ref", "Supabase prod ([redacted:supabase-ref], London)"],
    ["supabase ref near project-ref", `project-ref: \`${SUPA_REF}\``, "supabase-ref", "project-ref: `[redacted:supabase-ref]`"],
    ["supabase pooler user", `postgres.${SUPA_REF}`, "supabase-ref", "postgres.[redacted:supabase-ref]"],
  ];

  cases.push(
    // key: value and quoted keys
    ["colon assignment", `API_KEY: ${FAKE_KEY}`, "secret", "API_KEY: [redacted:secret]"],
    ["colon assignment no space", `api_secret:${FAKE_KEY}`, "secret", "api_secret:[redacted:secret]"],
    ["colon password", "password: hunter2", "secret", "password: [redacted:secret]"],
    ["colon password plain word", "Password: swordfish", "secret", "Password: [redacted:secret]"],
    ["json quoted key and value", `{"apiKey": "${FAKE_KEY}"}`, "secret", '{"apiKey": [redacted:secret]}'],
    ["json single quotes", `{'auth_token': '${FAKE_KEY}'}`, "secret", "{'auth_token': [redacted:secret]}"],
    ["json no spaces", `{"password":"hunter2","user":"x"}`, "secret", '{"password":[redacted:secret],"user":"x"}'],
    ["bold label then value", `**API key:** ${FAKE_KEY} (rotates monthly)`, "secret", "**API key:** [redacted:secret] (rotates monthly)"],
    ["bold key", `**Password**: hunter2`, "secret", "**Password**: [redacted:secret]"],
    ["quoted key with equals", `"db_password" = "hunter2"`, "secret", '"db_password" = [redacted:secret]'],
    // bearer tokens and webhooks
    ["bearer token", `Authorization: Bearer ${FAKE_KEY}`, "secret", "Authorization: Bearer [redacted:secret]"],
    ["bearer opaque token without digits is still long", "curl -H 'Authorization: Bearer " + "AbCdEfGhIjKlMnOpQrStUvWxYz" + "'", "secret", "curl -H 'Authorization: Bearer [redacted:secret]'"],
    ["bearer jwt is one secret", `Bearer ${JWT}`, "secret", "Bearer [redacted:secret]"],
    ["slack webhook url", `post to ${SLACK_HOOK} daily`, "secret", "post to [redacted:secret] daily"],
    // url-encoded at sign
    ["email with %40", "open mailto:jane.doe%40example.org now", "email", "open mailto:[redacted:email] now"],
    ["email with %40 in a query", "?email=a%40b.co&x=1", "email", "?email=[redacted:email]&x=1"],
    // a secret wrapped over a line break
    ["secret wrapped over a line: the tail is absorbed", `key ${GH}\n${RANDOM_B64.slice(0, 12)} rest`, "secret", "key [redacted:secret] rest"],
    ["secret wrapped twice", `${GH}\n${RANDOM_B64.slice(0, 12)}\n${RANDOM_B64.slice(12, 24)}\nnext line`, "secret", "[redacted:secret]\nnext line"],
    ["secret wrapped with indentation", `FOO_TOKEN=${FAKE_KEY}\n    ${RANDOM_B64.slice(0, 12)}`, "secret", "FOO_TOKEN=[redacted:secret]"],
    ["secret wrapped when the first part is under ten characters", `${GH.slice(0, 8)}\n${GH.slice(8)}`, "secret", "[redacted:secret]"],
    ["secret wrapped, prefix alone on the line", `${AKIA.slice(0, 4)}\n${AKIA.slice(4)}`, "secret", "[redacted:secret]"],
  );

  for (const [label, input, kind, expected] of cases) {
    it(label, () => {
      const r = redact(input);
      expect(r.text).toBe(expected ?? `[redacted:${kind}]`);
      expect(r.counts[kind]).toBeGreaterThanOrEqual(1);
      expect(redact(r.text)).toEqual({ text: r.text, counts: {} }); // redacting the result changes and reports nothing
    });
  }

  it("counts per kind across a mixed paragraph", () => {
    const r = redact(`Mail a@b.co and c@d.co from 203.0.113.45, call +91 98765 43210. ${SK}`);
    expect(r.counts).toEqual({ email: 2, ipv4: 1, phone: 1, secret: 1 });
    expect(r.text).toBe("Mail [redacted:email] and [redacted:email] from [redacted:ipv4], call [redacted:phone]. [redacted:secret]");
  });

  it("is idempotent: redacting redacted text changes nothing and reports nothing", () => {
    const once = redact(`FOO_TOKEN=abc ${GH} a@b.co D-U-N-S 987654321 Team ID ABCDE12345 Supabase (${SUPA_REF})`);
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.counts).toEqual({});
  });
});

describe("redact: things that must survive", () => {
  const keep = [
    "2026-10-05",
    // a JSON field called "key" that names a check-up fix is a label, not a credential (audit #39: every check-up tripped privacy-scan)
    `[{"key":"site-down","title":"Your website does not open"},{"key":"sitemap"}]`,
    "Updated 2026-10-09 18:30 BST, built ~18:30 BST",
    "40 orders in 21 days",
    "v1.0 build 11",
    "release 9 on hold, vc7, model 4.2, tool 3.1.150",
    "$2,500 a month, £1,000 budget, AED 10k ads, ₹1,00,000 in lakh style",
    "N7 and #12 and app #12",
    "migrations 31–36 and 37",
    "10 testers × 7 days; customers 80, products 23, orders 140",
    "https://www.example.com/jobs",
    "https://example.com:8080/path/to/page?x=1",
    "https://github.com/Acme-Org/widget-brain/issues/42",
    "react@18.3.1 and vitest@5.0.4",
    "commit 1a2b3c4d and 9e8f7a6",
    "UUID 123e4567-e89b-12d3-a456-426614174000",
    "channel id 1234567890123456789",
    "epoch 1760000000 and 1760000000000",
    "widget-site/docs/specs/2026-10-02-widget-shop-design.md",
    "reference to registry/connectors/print-shop.yaml and 20-growth/channels/newsletter.md",
    "supercalifragilisticexpialidocious is a long word but it has no digits at all",
    "the word internationalization sits next to Supabase and must stay",
    "Team ID registered and team identifiers",
    "bypass=true and NODE_ENV=production and TOKEN_EXPIRY=2026-12-01",
    "CAPTCHA_SECRET_KEY=*** and DB_ACCESS_TOKEN=<token> and API_KEY=[YOUR-KEY] and X_TOKEN=xxxx",
    "plugin chat@example-plugins and .env.local files",
    "FOO_KEY=$FOO and BAR_TOKEN=${BAR}",
    "icon@2x.png",
    "rzp_test_ keys come later",
    "sk-learn and task-based and risk-adjusted and ask-me-anything",
    "D-U-N-S is on file; the number 987654321 appears elsewhere",
    "the lookup is 9,87,65,43,210 in lakh style",
    "FooBarBazQuxQuuxCorgeGraultGarplyWaldo2",
    `a random 20-letter token ${SUPA_REF} with nothing else around it`,
    "git commit sha: " + rep("ab12", 10), // 40 hex after a commit label
    // numbers that follow a label are ids, counts or tracking numbers, not phones
    "order 9876543210 shipped",
    "Order #9876543210 and ticket #9876543211",
    "tracking no. 9876543210 for the parcel",
    "views: 9876543210 this year",
    "ID 9876543210 and id: 9876543211",
    // versions are not addresses
    "updated to iOS 18.1.1.2 today",
    "Chrome/120.0.0.0 on Android 14.0.0.1",
    "version 10.2.3.4 and v1.2.3.4",
    // the name of an environment variable is not its value
    "- Token: `META_LONG_LIVED_TOKEN` in the env file (a never-expiring token)",
    "Token: IG_LOGIN_ACCESS_TOKEN and secret: `SHOP_WEBHOOK_SECRET`",
    // prose around a secret-looking label is not a value
    "**Webhook secret:** run the rotation script on staging",
    "Key: we only post at 18:00",
    "Bearer authentication is used by the API",
    "password: none and token: n/a and secret: tbd",
    "Token expires 2026-12-01; token: see the vault",
    // a redacted secret followed by an ordinary line
    "FOO_TOKEN=[redacted:secret]\nNext paragraph here",
    "FOO_TOKEN=[redacted:secret]\n2026-10-05 notes",
    "FOO_TOKEN=[redacted:secret]\nweek12plan is on the board",
  ];
  for (const s of keep) {
    it(`keeps: ${s.slice(0, 60)}`, () => {
      const r = redact(s);
      expect(r.text).toBe(s);
      expect(r.counts).toEqual({});
    });
  }

  it("redacts a 40-hex string without commit context", () => {
    expect(redact(`token ${RANDOM_HEX}`).counts.secret).toBe(1);
  });
});

describe("findSensitive", () => {
  it("returns raw matches with their kind, nothing for clean text", () => {
    expect(findSensitive("nothing to see: 2026-10-05, 55 signups")).toEqual([]);
    expect(findSensitive("write to bob@example.org")).toEqual([{ kind: "email", match: "bob@example.org" }]);
  });
  it("ignores placeholders", () => {
    expect(findSensitive("[redacted:email] and FOO_TOKEN=[redacted:secret]")).toEqual([]);
  });
});

describe("redact: hostile input cannot stall ingestion", () => {
  // Before the rules were anchored and bounded these took minutes (quadratic backtracking).
  const hostile: Record<string, string> = {
    "one 100k word": "a".repeat(100_000),
    "100k path segments": "ab/".repeat(50_000),
    "100k tildes": "~/".repeat(50_000),
    "100k at signs": "a@".repeat(50_000),
    "100k key assignments": "A_KEY=".repeat(15_000),
    "long unterminated email domain": "user@" + "ab-".repeat(30_000),
    // a JWT prefix after every dash used to be quadratic (11 s at 200 KB): \b matches after "-" and the run class contains it
    "eyJ- repeated (200 KB)": "eyJ-".repeat(50_000),
    "eyJ_- repeated": "eyJ_-".repeat(40_000),
    "eyJ-- repeated": "eyJ--".repeat(40_000),
    "eyJ. repeated": "eyJabcdefgh.".repeat(16_000),
    "bearer repeated": "Bearer ".repeat(30_000),
    "bearer long token run": "Bearer " + "a1".repeat(100_000),
    "slack webhook prefix repeated": "https://hooks.slack.com/services/".repeat(6_000),
    "key colon repeated": "A_KEY: ".repeat(30_000),
    "quoted key colon repeated": '"k_key": '.repeat(25_000),
    "quoted key unterminated": '"k_key": "'.repeat(20_000),
    "percent-40 repeated": "a%40".repeat(50_000),
    "wrapped secret prefix repeated": "ghp_\n".repeat(40_000),
    "wrapped secret long lines": ("ghp_" + "a".repeat(300) + "\n").repeat(600),
    "redacted secret then newline repeated": "[redacted:secret]\n".repeat(11_000) + "a1".repeat(1_000),
    "version-like numbers": "iOS 18.1.1.2 ".repeat(15_000),
    "labelled numbers": "order 9876543210 ".repeat(11_000),
  };
  for (const [label, input] of Object.entries(hostile)) {
    it(label, () => {
      const t0 = performance.now();
      redact(input);
      expect(performance.now() - t0).toBeLessThan(3000); // linear takes milliseconds; the quadratic cases took 10 s and more
    });
  }
});

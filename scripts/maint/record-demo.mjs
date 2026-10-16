// Records the answers the public read-only mode replays: runs four questions LIVE on the synthetic business (Shiftly,
// demo_growth) through a running server, marks the four turns as showcase, and writes the graph as
// src/demo/recorded/shiftly-hero.jsonl (a db:export file). Re-run it when the seed (src/demo/growth.ts and what the other
// departments add to it) changes: tests/demo/recorded.test.ts fails until the copy matches the seed again.
//
// It uses the Claude subscription (no API key) and spends no credits; point it at a THROWAWAY FalkorDB, never a real one:
//   export ALLEVIA_FALKORDB_URL=redis://127.0.0.1:<free port> ALLEVIA_ENV_FILE=/dev/null ALLEVIA_STUDIO_ENGINE=recorded
//   npm run cli -- seed-demo                      # the plain business, no recorded answers
//   npm run cli -- serve &                        # live mode, http://127.0.0.1:8787 (or set PORT)
//   node scripts/maint/record-demo.mjs [baseUrl]  # about 4 minutes; stops at the first answer whose checks fail
// Then take new screenshots (web/scripts/screenshots-demo.mjs) and update the thread link in README.md and in
// tests/demo/recorded.test.ts (the hero thread's id is printed at the end).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const TENANT = "demo_growth";
const OUT = fileURLToPath(new URL("../../src/demo/recorded/shiftly-hero.jsonl", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const QUESTIONS = [
  "Why did sign-ups drop this week, and what should we do?",
  "What else breaks if the sign-up screen keeps crashing?",
  "Did pausing the Meta ads cause the sign-up drop?",
  "What did people say about the new phone-number box in their store reviews?",
];
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(base + "/")) throw new Error(`refusing ${base}: record against a local server`);

const health = await (await fetch(`${base}/api/health`)).json();
if (health.publicMode) throw new Error("the server is in public mode; start it in live mode (npm run cli -- serve)");
const sessions = await (await fetch(`${base}/api/${TENANT}/sessions`)).json();
const asked = sessions.filter((x) => !x.id.startsWith("session:growth-")); // the seed's own earlier thread is part of the business
if (asked.length) throw new Error(`${TENANT} already has ${asked.length} thread(s) of its own: run \`npm run cli -- seed-demo\` first so the recording starts from the plain business`);

// Asks one question and returns its final event (the stream is read to its end).
async function ask(question) {
  const res = await fetch(`${base}/api/${TENANT}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
  if (!res.ok || !res.body) throw new Error(`ask failed: ${res.status}`);
  let buf = "", final = null, session = null, error = null;
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const e = JSON.parse(data.slice(6));
      if (e.type === "final") final = e;
      if (e.type === "session") session = e;
      if (e.type === "error") error = e.message;
    }
  }
  if (!final) throw new Error(`no answer for "${question}": ${error ?? "the stream ended"}`);
  return { final, session };
}

const cli = (args) => {
  const r = spawnSync("npx", ["tsx", "src/cli.ts", ...args], { cwd: ROOT, encoding: "utf8", env: process.env });
  if (r.status !== 0) throw new Error(`${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};

const turns = [];
let heroSession = "";
for (const q of QUESTIONS) {
  const t0 = Date.now();
  const { final, session } = await ask(q);
  const c = final.checks ?? {};
  const bad = ["citationsValid", "numbersGrounded", "simulatedDisclosed", "freshnessDisclosed", "modeDisclosed"].filter((k) => c[k] === false);
  console.log(`${bad.length ? "FAIL" : "ok  "} ${((Date.now() - t0) / 1000).toFixed(0)} s  ${final.turnId}  ${q}${bad.length ? `  (checks failed: ${bad.join(", ")})` : ""}`);
  if (bad.length) throw new Error("an answer failed its checks: reseed (npm run cli -- seed-demo) and record again; nothing was written");
  turns.push(final.turnId);
  if (!heroSession) heroSession = session?.sessionId ?? "";
}
for (const id of turns) cli(["showcase", TENANT, id]);
console.log(cli(["db:export", TENANT, OUT]).trim().split("\n").pop());
console.log(`\nShowcase turns: ${turns.join(", ")}\nHero thread: ${heroSession}\n  README link: /ask/${encodeURIComponent(heroSession)}?tenant=${TENANT}\nNext: node web/scripts/screenshots-demo.mjs <public server> docs/demo-screens, then update the thread id in README.md and tests/demo/recorded.test.ts.`);

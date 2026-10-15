// Live check against a running server (npm run cli -- serve --model haiku): asks ONE real question on the Office page,
// screenshots the office mid-run and the Ask page at the end, and reports what streamed. It runs the model once, on
// the owner's subscription, so it is not part of any test suite.
// Usage: node scripts/live-check.mjs [baseUrl] [tenant] [outDir]   (default http://127.0.0.1:8787 demo_seed ../docs/screenshots)
// QUESTION="…" overrides the question.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const tenant = process.argv[3] ?? "demo_seed";
const out = resolve(process.argv[4] ?? "../docs/screenshots");
const question = process.env.QUESTION ?? "What breaks if the Instagram token expires, and who owns fixing it?";
await mkdir(out, { recursive: true });

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
// Tee the /ask stream: the page reads one branch, this counter the other, so the page sees the stream untouched.
await ctx.addInitScript(() => {
  const w = /** @type {any} */ (window);
  w.__sse = { events: [], t0: 0, done: false };
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await orig(input, init);
    const url = typeof input === "string" ? input : input.url;
    if (!/\/api\/[^/]+\/ask$/.test(new URL(url, location.href).pathname) || !res.body) return res;
    const [mine, theirs] = res.body.tee();
    w.__sse.t0 = performance.now();
    (async () => {
      const reader = mine.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) w.__sse.events.push({ type, at: Math.round(performance.now() - w.__sse.t0), e: JSON.parse(data) });
        }
      }
      w.__sse.done = true;
    })();
    return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
});

const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });

await page.goto(`${base}/?tenant=${encodeURIComponent(tenant)}`, { waitUntil: "networkidle" });
const mode = (await page.locator(".mode-pill").count()) ? "mock" : "live"; // the "Demo data" pill shows only in mock mode
if (mode !== "live") throw new Error("The app fell back to mock mode: is the server running and /api/health ok?");
await page.fill("#office-q", question);
await page.getByRole("button", { name: /^Ask/ }).click();

const sse = () => page.evaluate(() => /** @type {any} */ (window).__sse);
const waitFor = async (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred(await sse())) return true; await page.waitForTimeout(250); }
  return false;
};

// Mid-run: once a desk has results in hand and others are still working.
await waitFor((s) => s.events.filter((e) => e.type === "tool_result").length >= 2 || s.events.some((e) => e.type === "finding"), 240_000);
await page.waitForTimeout(900);
const midTypes = (await sse()).events.map((e) => e.type);
await page.screenshot({ path: `${out}/live-office-midrun.png` });

await waitFor((s) => s.done || s.events.some((e) => e.type === "final"), 600_000);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/live-office-answer.png` });

const s = await sse();
const session = s.events.find((e) => e.type === "session")?.e;
const final = s.events.find((e) => e.type === "final");
const path = s.events.find((e) => e.type === "path")?.e;

// Ask: the same run, followed in the app (client-side), with the work log and the lit path.
const follow = page.getByRole("button", { name: "Follow up in Ask" });
if (session && await follow.count()) await follow.first().click();
else await page.goto(`${base}/ask/${encodeURIComponent(session?.sessionId ?? "")}?tenant=${encodeURIComponent(tenant)}`, { waitUntil: "networkidle" });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/live-ask-final.png` });

const counts = {};
for (const e of s.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
console.log(JSON.stringify({
  base, tenant, mode, question, sessionId: session?.sessionId, turnId: session?.turnId,
  streamMs: final?.at, serverMs: final?.e.ms, events: s.events.length, counts,
  agents: final?.e.agents, checks: final?.e.checks, pathNodes: path?.nodes?.map((n) => n.id),
  midrunSaw: midTypes.length, answer: final?.e.answer?.slice(0, 600), problems,
}, null, 2));
await browser.close();

// The scroll-craft verification pass for the home page (the skill's verify.md and shoot.mjs, written for this page's marks):
// it walks every act at several scroll positions, waits for the scrubbed clip to settle, and reports
//   - dead scroll: neighbouring samples (0.25 viewport heights or more apart, pinned acts only) where nothing paints differently:
//     no cue moves, no scene state changes, no clip time advances, no rail travels, no wipe progresses;
//   - cues that never reach full opacity (peak under 0.8);
//   - contrast: for each visible cue the page is shot again with the text hidden and the composited background under the
//     line is sampled (dark ink against the darkest patch, light ink against the brightest); below 3:1 fails, 3 to 4.5 is thin;
//   - the scrubbed office clip against the run's clock (the clip must be at the second the picture beside it is drawing);
//   - console errors and failed requests.
// It writes NN.png per sample, report.json and a contact sheet (sheet.png, via ffmpeg). Run it against a built site:
//
//   (cd site && npm run build) && node site/scripts/lab.mjs --out docs/scrollcraft/builds/allevia-site/lab/desktop
//   node site/scripts/lab.mjs --out .../mobile --width 390 --height 844
//   node site/scripts/lab.mjs --out .../reduced --reduced-motion
//
// Serves dist/ itself with `vite preview` on port 4183 (never 8787). Uses the installed Chrome when there is one, because
// bundled Chromium has no H.264 decoder and the clip would silently stay on its poster.
import { chromium } from "playwright";
import { preview } from "vite";
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[i + 1]; };
const OUT = resolve(arg("out", join(SITE, "scripts", ".lab")));
const W = Number(arg("width", 1440));
const H = Number(arg("height", W < 600 ? 844 : 900));
const REDUCED = arg("reduced-motion", false) === true;
const PER = Number(arg("per-act", 6));
const PATH = arg("path", "/");
mkdirSync(OUT, { recursive: true });

// the policy the deploy notes recommend (docs/website-deploy.md): a violation shows up as a console error below
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const server = await preview({ root: SITE, preview: { port: 4183, strictPort: true, open: false, headers: { "Content-Security-Policy": CSP } } });
const base = "http://localhost:4183";
let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); console.error("note: installed Chrome not found; bundled Chromium cannot decode the clip"); }
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: W < 600 ? 2 : 1, reducedMotion: REDUCED ? "reduce" : "no-preference", locale: "en-US", timezoneId: "America/New_York" });
const page = await ctx.newPage();
const consoleErrors = [];
const failed = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e.message)));
page.on("requestfailed", (r) => { if (!r.url().startsWith("blob:")) failed.push(r.url()); });
page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
const first = await page.goto(base + PATH, { waitUntil: "load" });
const cspOn = Boolean(first?.headers()["content-security-policy"]);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(900);
const scrollMode = await page.evaluate(() => document.documentElement.classList.contains("is-scroll"));

const doc = await page.evaluate(() => ({
  height: document.documentElement.scrollHeight, vh: innerHeight,
  acts: [...document.querySelectorAll("[data-sc-act]")].map((a) => ({ id: a.id, kind: a.dataset.scAct, span: a.dataset.scSpan ?? null })),
}));

// where to stand: for each act, PER positions across its pinned travel (or, for a flow act, from a screen before to a screen after)
const positions = await page.evaluate(({ per }) => {
  const out = [];
  document.querySelectorAll("[data-sc-act]").forEach((a, ai) => {
    const r = a.getBoundingClientRect();
    const top = r.top + scrollY;
    const vh = innerHeight;
    const pinned = ["scrub", "pin", "pan"].includes(a.dataset.scAct) && document.documentElement.classList.contains("is-scroll");
    for (let i = 0; i < per; i++) {
      const f = 0.02 + (0.96 * i) / (per - 1);
      const y = pinned ? top + f * Math.max(0, r.height - vh) : top - vh * 0.85 + f * (r.height + vh * 0.85);
      out.push({ act: ai, id: a.id, f: Math.round(f * 100) / 100, y: Math.max(0, Math.round(y)) });
    }
  });
  out.push({ act: -1, id: "bottom", f: 1, y: 1e6 });
  return out;
}, { per: PER });

async function settle() {
  for (let i = 0; i < 80; i++) {
    const ok = await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !v.seeking));
    if (ok) break;
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(160);
}

const lum = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [hi, lo] = a > b ? [a, b] : [b, a]; return (hi + 0.05) / (lo + 0.05); };
const parseRgb = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);

const report = [];
for (const [n, pos] of positions.entries()) {
  await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), pos.y);
  await page.waitForTimeout(180);
  await settle();
  const state = await page.evaluate(() => {
    const vh = innerHeight;
    const cues = [...document.querySelectorAll("[data-sc-cue]")].map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { t: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 46), o: Math.round(Number(cs.opacity) * 100) / 100, on: r.bottom > 0 && r.top < vh && r.width > 0, color: cs.color };
    }).filter((c) => c.on && c.o > 0.02);
    const scenes = [...document.querySelectorAll("[data-scene]")].map((s) => ({ scene: s.dataset.scene, sig: s.dataset.scVerifyState ?? null, runT: s.dataset.runT ? Number(s.dataset.runT) : null, rect: (() => { const r = s.getBoundingClientRect(); return r.bottom > 0 && r.top < vh; })() }));
    const videos = [...document.querySelectorAll("video[data-clip-src]")].map((v) => ({ t: Math.round(v.currentTime * 100) / 100, dur: Math.round((v.duration || 0) * 10) / 10, live: v.classList.contains("is-live"), vis: (() => { const r = v.getBoundingClientRect(); return r.bottom > 0 && r.top < vh; })() }));
    const rails = [...document.querySelectorAll("[data-sc-pan]")].map((r) => new DOMMatrix(getComputedStyle(r).transform).m41);
    const wipes = [...document.querySelectorAll("[data-sc-reveal]")].map((w) => getComputedStyle(w).clipPath);
    const mid = document.elementFromPoint(innerWidth / 2, vh / 2)?.closest("[data-sc-act]");
    const goals = [...document.querySelectorAll(".goal__fill")].map((g) => Math.round(g.getBoundingClientRect().width));
    return { cues, scenes, videos, rails, wipes, goals, act: mid?.id ?? null, scroll: Math.round(scrollY) };
  });
  const file = `${String(n).padStart(2, "0")}.png`;
  await page.screenshot({ path: join(OUT, file) });

  // contrast: hide the cue text, shoot the same frame, sample the background under each line
  const rects = await page.evaluate(() => [...document.querySelectorAll("[data-sc-cue]")].flatMap((el) => {
    if (Number(getComputedStyle(el).opacity) < 0.85) return [];
    const out = [];
    el.querySelectorAll("h1, h2, p, li, .qcard").forEach((t) => {
      const r = t.getBoundingClientRect();
      if (r.width < 4 || r.bottom < 0 || r.top > innerHeight) return;
      const cs = getComputedStyle(t);
      out.push({ t: (t.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40), x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(innerWidth, r.right) - Math.max(0, r.left), h: Math.min(innerHeight, r.bottom) - Math.max(0, r.top), color: cs.color, size: parseFloat(cs.fontSize) });
    });
    return out;
  }));
  const contrast = [];
  if (rects.length) {
    await page.addStyleTag({ content: "[data-sc-cue] * { color: transparent !important; text-shadow: none !important; } [data-sc-cue] { color: transparent !important; }" });
    const buf = await page.screenshot({ type: "png" });
    await page.evaluate(() => { document.head.lastElementChild?.remove(); });
    const scale = W < 600 ? 2 : 1;
    for (const r of rects) {
      if (r.w < 4 || r.h < 4) continue;
      try {
        const { data, info } = await sharp(buf).extract({ left: Math.round(r.x * scale), top: Math.round(r.y * scale), width: Math.max(1, Math.round(r.w * scale)), height: Math.max(1, Math.round(r.h * scale)) }).raw().toBuffer({ resolveWithObject: true });
        let dark = 1, light = 0, sum = 0, k = 0;
        for (let i = 0; i < data.length; i += info.channels) { const L = lum(data[i], data[i + 1], data[i + 2]); dark = Math.min(dark, L); light = Math.max(light, L); sum += L; k++; }
        const [cr, cg, cb] = parseRgb(r.color);
        const L = lum(cr, cg, cb);
        const worst = L < 0.4 ? ratio(L, light) : ratio(L, dark);
        contrast.push({ t: r.t, size: Math.round(r.size), worst: Math.round(worst * 100) / 100, mean: Math.round(ratio(L, sum / k) * 100) / 100 });
      } catch { /* a rect outside the shot */ }
    }
  }
  report.push({ i: n, ...pos, file, ...state, contrast });
}

// ---------- keyboard: tab through the page; each focused control must be on screen and not inside a faded cue ----------
await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; scrollTo({ top: 0, behavior: "instant" }); document.body.focus(); });
await page.waitForTimeout(200);
const tabbed = [];
for (let i = 0; i < 60; i++) {
  await page.keyboard.press("Tab");
  await page.waitForTimeout(140);
  const f = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    let o = 1;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) o = Math.min(o, Number(getComputedStyle(n).opacity));
    return { tag: el.tagName.toLowerCase(), text: (el.textContent ?? el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim().slice(0, 40), inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth, opacity: Math.round(o * 100) / 100, href: el.getAttribute("href") };
  });
  if (!f) break;
  tabbed.push(f);
}

// ---------- findings ----------
const findings = [];
for (const f of tabbed) {
  if (!f.inView) findings.push({ kind: "focus off screen", text: f.text, href: f.href });
  else if (f.opacity < 0.85) findings.push({ kind: "focus inside a faded cue", text: f.text, opacity: f.opacity });
}
const sigOf = (s) => JSON.stringify([s.cues.map((c) => `${c.t}:${Math.round(c.o * 10)}`), s.scenes.map((x) => x.sig), s.videos.map((v) => Math.round(v.t)), s.rails.map(Math.round), s.wipes, s.goals]);
for (let i = 1; i < report.length; i++) {
  const a = report[i - 1], b = report[i];
  if (a.act !== b.act || a.act < 0) continue;
  const kind = doc.acts[a.act]?.kind;
  if (!scrollMode || !["scrub", "pin", "pan"].includes(kind)) continue;
  if ((b.y - a.y) / H < 0.25) continue;
  if (sigOf(a) === sigOf(b)) findings.push({ kind: "dead scroll", act: a.id, between: [a.y, b.y], note: `nothing paints differently across ${(((b.y - a.y) / H)).toFixed(2)} viewport heights` });
}
const peak = new Map();
for (const r of report) for (const c of r.cues) { const key = `${r.id}|${c.t}`; peak.set(key, Math.max(peak.get(key) ?? 0, c.o)); }
for (const [key, o] of peak) if (o < 0.8) findings.push({ kind: "cue never at full opacity", where: key, peak: o });
for (const r of report) for (const c of r.contrast) {
  if (c.worst < 3) findings.push({ kind: "contrast fails", at: r.file, text: c.t, worst: c.worst });
  else if (c.worst < 4.5 && c.size < 24) findings.push({ kind: "contrast thin on small text", at: r.file, text: c.t, size: c.size, worst: c.worst });
}
if (scrollMode) for (const r of report) {
  for (const v of r.videos) if (v.vis && !v.live && r.id === "ask" && r.f > 0.1 && r.f < 0.95) findings.push({ kind: "clip not painting", at: r.file, note: "the office clip is still on its poster" });
  const run = r.scenes.find((s) => s.scene === "ask");
  for (const v of r.videos) if (v.vis && v.live && run && run.runT !== null && Math.abs(v.t - run.runT) > 1.2) findings.push({ kind: "clip out of step with the run", at: r.file, clip: v.t, run: run.runT });
}
if (!cspOn) findings.push({ kind: "the policy header was not served, so the policy was not tested" });
for (const e of consoleErrors) findings.push({ kind: "console error", text: e });
for (const f of failed) findings.push({ kind: "failed request", url: f });

writeFileSync(join(OUT, "report.json"), JSON.stringify({ doc: { ...doc, scrollMode, width: W, height: H, reduced: REDUCED }, report, keyboard: tabbed, findings }, null, 1));
const files = readdirSync(OUT).filter((f) => /^\d\d\.png$/.test(f)).sort();
try {
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-framerate", "1", "-i", join(OUT, "%02d.png"), "-vf", `scale=${W < 600 ? 260 : 520}:-1,tile=${W < 600 ? 8 : 5}x${Math.ceil(files.length / (W < 600 ? 8 : 5))}:padding=6:color=0x888888`, "-frames:v", "1", join(OUT, "sheet.png")]);
} catch { console.error("no contact sheet (ffmpeg with glob input needed)"); }
console.log(`lab: ${report.length} samples at ${W}x${H}${REDUCED ? " (reduced motion)" : ""}, scroll mode: ${scrollMode}`);
console.log(findings.length ? findings.map((f) => `  - ${f.kind}: ${JSON.stringify(Object.fromEntries(Object.entries(f).filter(([k]) => k !== "kind")))}`).join("\n") : "  no findings");
await browser.close();
await new Promise((r) => server.httpServer.close(r));
void existsSync;

// DOM audit of the built pages on BASE (default http://127.0.0.1:8812, the preview of the built prototypes): (1) every distinct text and background colour in use that is blue, blue-grey, purple or
// pink (hue 170-345, saturation above 12 percent), with the elements that use it; (2) each top-level section's box, background, and the gap
// between its box and its first and last visible content (a large gap is an empty band); (3) page height. Usage (from site/): node proto/qa/audit.mjs <width> [pages...]
import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://127.0.0.1:8812";
const [, , widthArg = "1440", ...rest] = process.argv;
const width = Number(widthArg);
const pages = rest.length ? rest : ["a", "b", "product", "integrations", "pricing", "security", "faq", "team", "contact"];
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const phone = width < 700;
const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, reducedMotion: "reduce" });
for (const p of pages) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${p}/`, { waitUntil: "load", timeout: 60000 });
  await page.addStyleTag({ content: ".proto-switch { display: none !important; }" });
  await page.waitForTimeout(1500);
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < total; y += 700) { await page.evaluate((yy) => window.scrollTo(0, yy), y); await page.waitForTimeout(60); }
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);
  const res = await page.evaluate(() => {
    const parse = (c) => { const m = c.match(/rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
    const hsl = ({ r, g, b }) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; const d = mx - mn; let h = 0, s = 0; if (d) { s = d / (1 - Math.abs(2 * l - 1)); h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; } return { h, s, l }; };
    const odd = new Map();
    const note = (kind, c, el) => { const q = parse(c); if (!q || q.a < 0.4) return; const { h, s, l } = hsl(q); if (s > 0.12 && h >= 170 && h <= 345 && l > 0.04 && l < 0.97) { const key = `${kind} ${c}`; const cls = (el.className && el.className.baseVal === undefined ? el.className : el.getAttribute("class")) || el.tagName; const arr = odd.get(key) ?? []; if (arr.length < 3) arr.push(`${el.tagName.toLowerCase()}.${String(cls).split(" ")[0]}`); odd.set(key, arr); } };
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("svg") && el.tagName !== "svg") continue;
      const cs = getComputedStyle(el); if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
      note("bg", cs.backgroundColor, el);
      if (el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) note("text", cs.color, el);
      if (cs.borderTopWidth !== "0px" && cs.borderTopStyle !== "none") note("border", cs.borderTopColor, el);
    }
    const sections = [...document.querySelectorAll("main > section, main > div > section, footer, header.nav")].map((s) => {
      const r = s.getBoundingClientRect(); const top = r.top + scrollY, bottom = r.bottom + scrollY;
      const bg = getComputedStyle(s, "::before").backgroundColor; const own = getComputedStyle(s).backgroundColor;
      let first = Infinity, last = -Infinity;
      for (const el of s.querySelectorAll("*")) { if (el.closest("svg") && el.tagName !== "svg") continue; const cs = getComputedStyle(el); if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "absolute" && el.matches(".band::before")) continue; const b = el.getBoundingClientRect(); if (b.width < 2 || b.height < 2) continue; const visible = el.matches("img,video,canvas,svg,button,a,input") || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.boxShadow !== "none"; if (!visible) continue; first = Math.min(first, b.top + scrollY); last = Math.max(last, b.bottom + scrollY); }
      return { name: (s.className || s.tagName).toString().split(" ").slice(0, 3).join(" "), top: Math.round(top), h: Math.round(bottom - top), band: bg !== "rgba(0, 0, 0, 0)" ? bg : own, padTop: Math.round(first - top), padBottom: Math.round(bottom - last) };
    });
    return { odd: [...odd.entries()], sections, height: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
  });
  console.log(`\n=== ${p} @${width}  height ${res.height}  overflowX ${res.sw > res.cw + 1 ? "YES" : "no"}`);
  for (const s of res.sections) console.log(`  ${s.name.padEnd(34)} y=${String(s.top).padStart(5)} h=${String(s.h).padStart(5)} bg=${s.band.padEnd(22)} space above content ${String(s.padTop).padStart(4)}  below ${String(s.padBottom).padStart(4)}`);
  console.log("  off-palette (blue/purple/pink) colours in use:", res.odd.length ? "" : "none");
  for (const [k, v] of res.odd) console.log(`    ${k}  <- ${v.join(", ")}`);
  await page.close();
}
await browser.close();

// The only script on the site: fonts and styles, the currency toggle, and the hero and office loops. Everything else is plain HTML
// built at compile time, and the pages read fine with this script switched off (prices then show in US dollars).
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles/site.css";
import { CURRENCIES, isCurrency, type Currency } from "../../shared/plans.ts";
import { formatMoney } from "./money.ts";

// ---------- currency ----------

const KEY = "allevia.currency";

function guessCurrency(): Currency {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && isCurrency(stored)) return stored;
  } catch { /* storage blocked: fall through */ }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  if (tz === "Europe/London") return "GBP";
  if (tz === "Asia/Dubai") return "AED";
  if (tz.startsWith("Australia/")) return "AUD";
  const lang = navigator.language || "";
  if (/-GB$/i.test(lang)) return "GBP";
  if (/-AE$/i.test(lang)) return "AED";
  if (/-AU$/i.test(lang)) return "AUD";
  return "USD";
}

function applyCurrency(c: Currency, remember: boolean) {
  document.querySelectorAll<HTMLElement>("[data-usd]").forEach((el) => {
    const v = Number(el.dataset[c.toLowerCase()]);
    if (Number.isFinite(v)) el.textContent = formatMoney(v, c);
  });
  document.querySelectorAll<HTMLInputElement>("input[data-currency-input]").forEach((i) => { i.checked = i.value === c; });
  document.documentElement.dataset.currency = c;
  if (remember) {
    try { localStorage.setItem(KEY, c); } catch { /* not remembered; fine */ }
  }
}

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.matches("input[data-currency-input]") && isCurrency(t.value)) applyCurrency(t.value, true);
});
const initial = guessCurrency();
if (initial !== CURRENCIES[0]) applyCurrency(initial, false);

// ---------- hero loop ----------
// The drawing is the page's first paint. The 5-second loop fades in over it only when motion is welcome and the
// connection isn't on data saver, and it can be paused (it loops for longer than five seconds).

const art = document.querySelector<HTMLElement>("[data-hero-art]");
const video = art?.querySelector<HTMLVideoElement>("video");
const pause = art?.querySelector<HTMLButtonElement>("[data-hero-pause]");
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

function startLoop() {
  if (!art || !video || !pause || reduce.matches || saveData) return;
  const src = video.dataset.mp4;
  if (!src) return;
  const s = document.createElement("source");
  s.type = "video/mp4";
  s.src = src;
  video.append(s);
  video.addEventListener("playing", () => { art.classList.add("is-playing"); pause.hidden = false; }, { once: true });
  video.load();
  video.play().catch(() => { /* autoplay refused: the drawing stays */ });
  pause.addEventListener("click", () => {
    const paused = !video.paused;
    if (paused) video.pause(); else void video.play();
    pause.setAttribute("aria-pressed", String(paused));
    pause.textContent = paused ? "Play the drawing" : "Pause the drawing";
  });
}

// ---------- the office loop ----------
// A short loop of the real office. The poster picture is the first paint and the fallback; the loop starts only when it
// scrolls into view, motion is welcome and the connection isn't on data saver, and it can be paused.
function setupLoops() {
  document.querySelectorAll<HTMLElement>("[data-loop]").forEach((fig) => {
    const v = fig.querySelector<HTMLVideoElement>("video");
    const btn = fig.querySelector<HTMLButtonElement>("[data-loop-pause]");
    const src = v?.dataset.mp4;
    if (!v || !btn || !src || reduce.matches || saveData) return;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      const s = document.createElement("source");
      s.type = "video/mp4";
      s.src = src;
      v.append(s);
      v.addEventListener("playing", () => { fig.classList.add("is-playing"); btn.hidden = false; }, { once: true });
      v.load();
      v.play().catch(() => { /* autoplay refused: the poster stays */ });
    };
    btn.addEventListener("click", () => {
      const paused = !v.paused;
      if (paused) v.pause(); else void v.play();
      btn.setAttribute("aria-pressed", String(paused));
      btn.textContent = paused ? "Play the loop" : "Pause the loop";
    });
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { start(); if (btn.getAttribute("aria-pressed") !== "true") void v.play().catch(() => { /* refused */ }); }
          else if (started) v.pause();
        }
      }, { rootMargin: "100px" });
      io.observe(fig);
    } else start();
  });
}

// the table of contents on the legal pages starts open on a wide screen and closed on a phone
document.querySelectorAll<HTMLDetailsElement>("[data-toc]").forEach((d) => { d.open = window.matchMedia("(min-width: 64rem)").matches; });

const boot = () => { startLoop(); setupLoops(); };
if (document.readyState === "complete") boot();
else window.addEventListener("load", boot, { once: true });

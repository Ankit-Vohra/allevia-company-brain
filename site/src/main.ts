// The only script on the site: fonts and styles, the short loops (the office, the setup), and the contents list on the
// legal pages. Everything else is plain HTML built at compile time, and the pages read fine with this script switched off.
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles/site.css";

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
const narrow = window.matchMedia("(max-width: 860px)");
const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

// ---------- the loops ----------
// A short loop of the real app. The poster picture is the first paint and the fallback; the loop starts only when it
// scrolls into view, motion is welcome and the connection isn't on data saver, and it can be paused.
function setupLoops() {
  document.querySelectorAll<HTMLElement>("[data-loop]").forEach((fig) => {
    const v = fig.querySelector<HTMLVideoElement>("video");
    const btn = fig.querySelector<HTMLButtonElement>("[data-loop-pause]");
    const src = (narrow.matches && v?.dataset.mp4Phone) || v?.dataset.mp4;
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

if (document.readyState === "complete") setupLoops();
else window.addEventListener("load", setupLoops, { once: true });

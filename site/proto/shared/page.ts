// Script for the inner pages (Integrations, Product, Pricing, Security, Questions): reveals as sections arrive, the plan bars filling,
// and the OK demo (a tap, then the card changes, in the app and in Discord). Transform and opacity only; reduced motion shows the end states.
import "./entry.ts";
import "./home.css";
import "./pages.css";
import { reduceMotion } from "./chrome.ts";
import { initHome } from "./home-client.ts";

initHome(); // the growing brain, where the page has one
// the diagram of the brain, the tools and the team (Product page)
const diagram = document.querySelector<HTMLElement>("[data-bhero]");
if (diagram) { void import("../b/b.css"); void import("../b/hero2d.ts").then((m) => m.startBHero(diagram)); }

const html = document.documentElement;
html.classList.add("js");
const reduced = reduceMotion();
if (reduced) html.classList.add("no-motion");

// reveals
const reveals = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
if (reduced || !("IntersectionObserver" in window)) reveals.forEach((el) => el.classList.add("is-in"));
else {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { const el = e.target as HTMLElement; const sib = [...(el.parentElement?.querySelectorAll<HTMLElement>(":scope > [data-reveal]") ?? [])]; el.style.transitionDelay = `${Math.max(0, sib.indexOf(el)) * 70}ms`; el.classList.add("is-in"); io.unobserve(el); }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  reveals.forEach((el) => io.observe(el));
}

// the plan's bars
const plan = document.querySelector<HTMLElement>("[data-plan]");
if (plan) { if (reduced) plan.classList.add("is-in"); else new IntersectionObserver(([e], o) => { if (e?.isIntersecting) { plan.classList.add("is-in"); o.disconnect(); } }, { threshold: 0.3 }).observe(plan); }

// the OK
const ok = document.querySelector<HTMLElement>("[data-ok]");
if (ok) {
  const stack = ok.querySelector<HTMLElement>("[data-ok-stack]")!; const btn = ok.querySelector<HTMLElement>("[data-ok-dc]");
  if (reduced) stack.classList.add("is-after");
  else {
    let timers: number[] = [];
    const run = () => {
      timers.forEach(clearTimeout); timers = [];
      stack.classList.remove("is-after", "is-tap"); btn?.classList.remove("is-press");
      const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
      at(900, () => { stack.classList.add("is-tap"); });
      at(1350, () => { stack.classList.add("is-after"); btn?.classList.add("is-press"); });
      at(1550, () => btn?.classList.remove("is-press"));
      at(4800, () => { stack.classList.remove("is-tap"); });
      at(5200, run);
    };
    new IntersectionObserver(([e]) => { if (e?.isIntersecting) run(); else { timers.forEach(clearTimeout); timers = []; } }, { threshold: 0.35 }).observe(ok);
  }
}

// Script for the inner pages (Integrations, Product, Pricing, Security, Questions, Contact): reveals as sections arrive and the plan bars
// filling; the pinned steps, the growing brain and the OK demo come from home-client.ts. Transform and opacity only; reduced motion shows the end states.
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

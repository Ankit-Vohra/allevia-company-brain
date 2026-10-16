// The scroll story on the home page and the product tour. Two modes, chosen once at load:
//   - "scroll": a wide screen, motion welcome, not on data saver. The vendored scrollcraft engine is loaded (its own small
//     chunk) and mounted on the page's data-sc-* marks: pinned acts, scrubbed footage, cues, the rail.
//   - "flat": a phone, reduced motion, data saver, or the engine failing to load. The page is an ordinary page with every
//     line visible; on a phone the footage plays as short muted loops (recorded on a 390px phone) while on screen, each
//     with a pause button; with reduced motion or data saver the still posters stay.
// Without JavaScript the page is the flat page with posters. This file also runs the courier route and the paste field.
// The engine itself is never edited (site/vendor/scrollcraft/NOTICE.md); everything Allevia-specific is here.

const root = document.documentElement;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const narrow = matchMedia("(max-width: 860px)").matches;
const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

export function storyMode(): "scroll" | "flat" | null {
  if (!document.querySelector("[data-sc-act]")) return null;
  return !reduce && !narrow && !saveData ? "scroll" : "flat";
}

/** Run before the loop set-up in main.ts: in flat mode on a phone, the hero's scrub clip becomes a phone loop. */
export function prepareStory(): "scroll" | "flat" | null {
  const mode = storyMode();
  if (!mode) return null;
  root.classList.add(mode === "scroll" ? "is-scroll" : "is-flat");
  if (mode === "flat") {
    document.querySelectorAll<HTMLVideoElement>("video[data-sc-scrub]").forEach((v) => {
      const fig = v.closest<HTMLElement>("figure");
      v.removeAttribute("data-sc-scrub");
      v.classList.add("loop__video");
      const phone = v.dataset.flatMp4;
      if (!fig || !phone || !narrow) return;
      v.dataset.mp4 = phone;
      v.loop = true;
      fig.setAttribute("data-loop", "");
      fig.querySelector("[data-flat-pause]")?.setAttribute("data-loop-pause", "");
    });
    if (narrow) {
      document.querySelectorAll<HTMLVideoElement>("video[data-mp4-phone]").forEach((v) => { v.dataset.mp4 = v.dataset.mp4Phone; });
    }
  }
  return mode;
}

export async function mountStory(mode: "scroll" | "flat" | null): Promise<void> {
  if (!mode) return;
  pasteField();
  courierRoute();
  if (mode !== "scroll") return;
  try {
    await import("../vendor/scrollcraft/scrollcraft.js");
    window.ScrollCraft?.mount(document.body);
    keepFocusVisible();
    window.dispatchEvent(new Event("story:mounted"));
  } catch {
    // the engine did not load: fall back to the flat page, which is complete on its own
    root.classList.replace("is-scroll", "is-flat");
  }
}

// ---------- the paste field: what you type travels down the page, and never leaves it ----------

function domainOf(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/)[0] ?? "";
  return s.replace(/[^a-z0-9.-]/g, "").slice(0, 40);
}

function pasteField() {
  const form = document.querySelector<HTMLFormElement>("[data-paste]");
  if (!form) return;
  form.hidden = false;
  const input = form.querySelector<HTMLInputElement>("input")!;
  const paint = () => {
    const d = domainOf(input.value);
    document.querySelectorAll<HTMLElement>("[data-your-site]").forEach((el) => { el.textContent = d || "your website"; });
    document.querySelectorAll<HTMLElement>("[data-your-site-short]").forEach((el) => { el.textContent = d ? (d.length > 16 ? `${d.slice(0, 15)}…` : d) : "your website"; });
  };
  input.addEventListener("input", paint);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    paint();
    const next = document.getElementById("setup");
    next?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  });
}

// ---------- the courier route: Fluffy walks the stops as you scroll, and gets a treat at each one ----------

function courierRoute() {
  const nav = document.querySelector<HTMLElement>("[data-route]");
  const dog = nav?.querySelector<HTMLElement>("[data-route-dog]");
  if (!nav || !dog) return;
  const stops = [...nav.querySelectorAll<HTMLElement>(".route__stop")];
  const sections = stops.map((li) => document.getElementById(li.querySelector("a")!.hash.slice(1)));
  if (sections.some((s) => !s)) return;
  nav.classList.add("is-on");

  let tops: number[] = [];
  let xs: number[] = [];
  const measure = () => {
    tops = sections.map((s) => s!.getBoundingClientRect().top + scrollY);
    const track = nav.querySelector<HTMLElement>(".route__track")!.getBoundingClientRect();
    xs = stops.map((li) => { const r = li.querySelector(".route__dot")!.getBoundingClientRect(); return r.left + r.width / 2 - track.left; });
  };

  let lastY = scrollY;
  let walked = 0;
  let idle = 0;
  let current = -1;
  let ticking = false;
  const update = () => {
    ticking = false;
    const probe = scrollY + innerHeight * 0.45;
    let k = 0;
    for (let i = 0; i < tops.length; i++) if (tops[i]! <= probe) k = i;
    const nextTop = tops[k + 1];
    const f = nextTop === undefined ? 0 : Math.min(1, Math.max(0, (probe - tops[k]!) / (nextTop - tops[k]!)));
    const x = xs[k]! + ((xs[k + 1] ?? xs[k]!) - xs[k]!) * f;
    const dy = scrollY - lastY;
    lastY = scrollY;
    walked += Math.abs(dy);
    if (dy !== 0) dog.dataset.facing = dy < 0 ? "left" : "right";
    dog.style.transform = `translateX(${x.toFixed(1)}px)`;
    dog.dataset.pose = reduce ? "sit" : String(Math.floor(walked / 26) % 2 ? "b" : "a");
    clearTimeout(idle);
    idle = window.setTimeout(() => { dog.dataset.pose = "sit"; }, 380);
    if (k !== current) {
      current = k;
      stops.forEach((li, i) => {
        li.classList.toggle("is-delivered", i <= k);
        const a = li.querySelector("a")!;
        if (i === k) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current");
      });
    }
  };
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  const remeasure = () => { measure(); update(); };
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", remeasure);
  addEventListener("story:mounted", () => setTimeout(remeasure, 60));
  document.fonts?.ready.then(remeasure);
  setTimeout(remeasure, 800);
  remeasure();
  dog.dataset.pose = "sit";

  // step aside for the footer, so the last screen is the site's own
  const foot = document.querySelector(".foot");
  if (foot && "IntersectionObserver" in window) {
    new IntersectionObserver((es) => { for (const e of es) nav.classList.toggle("is-away", e.isIntersecting); }).observe(foot);
  }
}

// ---------- keyboard: a focused control inside a pinned act is scrolled to where its cue is open ----------
// The engine centres a focused element inside an act, but on a pinned act that lands at progress 0, where a later cue
// is still dark (scrollcraft verify.md, "Keyboard"). Our pinned acts put their links and fields in cues that are open
// from the act's start, so parking the act at its top is enough: scroll the act's top into view instead.
function keepFocusVisible() {
  document.addEventListener("focusin", (e) => {
    const el = e.target as HTMLElement;
    const act = el.closest<HTMLElement>('[data-sc-act="pin"], [data-sc-act="scrub"]');
    if (!act) return;
    const r = act.getBoundingClientRect();
    if (r.top > 1 || r.top < -innerHeight * 0.4) scrollTo({ top: scrollY + r.top, behavior: "instant" as ScrollBehavior });
  });
}

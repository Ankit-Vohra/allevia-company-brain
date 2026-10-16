// The home page's motion. Two modes, chosen once at load:
//   - "scroll": a wide screen, motion welcome, not on data saver. The vendored scrollcraft engine (its own small chunk) pins
//     the acts and cues the copy; this file drives the pictures from the reader's place in their act: the brain forming and
//     growing (act progress 0..1), the question's run through it (the seconds of a real recording, scrubbed with its video),
//     the office clip itself, and the courier route.
//   - "flat": a phone, reduced motion, data saver, or the engine failing. An ordinary page with every line visible. The
//     pictures that move play once when they scroll into view (no scrubbing on a phone); with reduced motion or data saver
//     they stay finished.
// Without JavaScript the page is the flat page with every picture finished. The engine itself is never edited
// (site/vendor/scrollcraft/NOTICE.md); everything Allevia-specific is here.

const root = document.documentElement;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const narrow = matchMedia("(max-width: 860px)").matches;
const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

export type HomeMode = "scroll" | "flat" | null;

export function homeMode(): HomeMode {
  if (!document.querySelector("[data-sc-act]")) return null;
  return !reduce && !narrow && !saveData ? "scroll" : "flat";
}

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (k: number) => 1 - Math.pow(1 - k, 3);
const back = (k: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
const q = <T extends Element>(sel: string, el: ParentNode = document) => [...el.querySelectorAll<T>(sel)];

/** Run before the loops are set up in main.ts: the class the CSS keys on, and the phone's version of the footage. */
export function prepareHome(): HomeMode {
  const mode = homeMode();
  if (!mode) return null;
  root.classList.add(mode === "scroll" ? "is-scroll" : "is-flat");
  if (mode === "flat") {
    // the scrubbed office clip becomes a short muted loop of the same run, played only while on screen
    q<HTMLVideoElement>("video[data-clip-src]").forEach((v) => {
      v.removeAttribute("data-clip-src");
      v.dataset.mp4 = "/media/office-loop.mp4";
      v.loop = true;
      v.classList.add("loop__video");
      const fig = v.closest("figure");
      fig?.setAttribute("data-loop", "");
      const img = fig?.querySelector<HTMLImageElement>("img");
      if (img) { img.classList.add("loop__poster"); img.src = "/media/office-loop-poster.webp"; img.width = 640; img.height = 308; }
      if (fig && !fig.querySelector("[data-loop-pause]")) {
        const b = document.createElement("button");
        b.type = "button"; b.hidden = true; b.className = "loop__pause"; b.textContent = "Pause the loop"; b.setAttribute("data-loop-pause", ""); b.setAttribute("aria-pressed", "false");
        fig.querySelector(".panel__media")?.append(b);
      }
    });
  }
  return mode;
}

export async function mountHome(mode: HomeMode): Promise<void> {
  if (!mode) return;
  courierRoute();
  const scenes = mode === "scroll" ? scrollScenes() : flatScenes();
  if (mode !== "scroll") return;
  try {
    await import("../vendor/scrollcraft/scrollcraft.js");
    window.ScrollCraft?.mount(document.body);
    keepFocusVisible();
    scenes.start();
    window.dispatchEvent(new Event("story:mounted"));
  } catch {
    // the engine did not load: fall back to the flat page, which is complete on its own
    root.classList.replace("is-scroll", "is-flat");
    scenes.stop();
    flatScenes();
  }
}

// ================= the brain forming (act progress 0..1) =================

interface FAnim { el: SVGElement | HTMLElement; kind: string; t0: number; dur: number; ring: boolean; last: number; dot?: Element | null; ringEl?: Element | null }

function parseForm(stage: HTMLElement): FAnim[] {
  return q<SVGElement | HTMLElement>("[data-f]", stage).map((el) => {
    const [kind = "fade", t0 = "0", dur = "0.03", extra] = (el.getAttribute("data-f") ?? "").split(" ");
    return { el, kind, t0: Number(t0), dur: Number(dur), ring: extra === "ring", last: -1, dot: el.querySelector(".bn__dot"), ringEl: el.querySelector(".bn__ring") };
  });
}

function formApply(stage: HTMLElement, anims: FAnim[], p: number, stats: { things: HTMLElement | null; links: HTMLElement | null }): string {
  let nodes = 0, links = 0, docked = 0;
  for (const a of anims) {
    const raw = clamp((p - a.t0) / a.dur);
    const k = Math.round(raw * 24) / 24; // 24 steps is as smooth as the eye needs and skips repaints
    if (a.kind === "pop" && raw > 0.5) nodes++;
    else if (a.kind === "draw" && raw > 0.5) links++;
    else if (a.kind === "dock" && raw >= 1) docked++;
    if (k === a.last) continue;
    a.last = k;
    const el = a.el as SVGElement & HTMLElement;
    if (a.kind === "pop") {
      el.style.opacity = String(Math.min(1, k * 2.4));
      (a.dot as SVGElement | null)?.style.setProperty("transform", `scale(${(0.35 + 0.65 * back(k)).toFixed(3)})`);
      if (a.ringEl) { (a.ringEl as SVGElement).style.opacity = String(k > 0 && k < 1 ? (1 - k) * 0.7 : 0); (a.ringEl as SVGElement).style.transform = `scale(${(1 + k * 1.9).toFixed(3)})`; }
    } else if (a.kind === "draw") {
      el.style.strokeDashoffset = String(1 - ease(k));
      el.style.opacity = k > 0 ? "1" : "0";
    } else if (a.kind === "fade") {
      el.style.opacity = String(k);
    } else if (a.kind === "dock") {
      const e = back(k);
      el.style.opacity = String(Math.min(1, k * 3));
      el.style.transform = `translateY(${((1 - e) * 46).toFixed(1)}px) scale(${(0.82 + 0.18 * e).toFixed(3)})`;
      el.classList.toggle("is-docked", raw >= 1);
    }
  }
  if (stats.things) stats.things.textContent = String(nodes);
  if (stats.links) stats.links.textContent = String(links);
  // the address bar types the website in the first stretch
  const url = stage.querySelector<HTMLElement>("[data-type]");
  if (url) {
    const full = url.dataset.type ?? "";
    const n = Math.round(clamp(p / 0.05) * full.length);
    if (url.dataset.n !== String(n)) { url.dataset.n = String(n); url.textContent = full.slice(0, n); url.classList.toggle("is-typing", n < full.length); }
  }
  const sig = `${nodes}:${links}:${docked}:${url?.dataset.n ?? ""}`;
  stage.dataset.scVerifyState = sig;
  return sig;
}

// ================= the question's run (seconds of a real recording) =================

interface Run { seconds: number; plan: number; path: number; end: number }
interface RAnim { el: SVGElement; kind: string; a: number[]; last: string }

function parseRun(svg: SVGElement): { run: Run; anims: RAnim[]; reads: Map<string, number> } {
  const [, plan = "13", , path = "74", , end = "98", , seconds = "100"] = (svg.getAttribute("data-run") ?? "").split(" ");
  const anims = q<SVGElement>("[data-r]", svg).map((el) => {
    const [kind = "fade", ...nums] = (el.getAttribute("data-r") ?? "").split(" ");
    return { el, kind, a: nums.map(Number), last: "" };
  });
  const reads = new Map<string, number>();
  for (const a of anims) if (a.kind === "route") { const id = a.el.getAttribute("data-id"); const t = a.a[0]!; if (id && (!reads.has(id) || t < reads.get(id)!)) reads.set(id, t); }
  return { run: { seconds: Number(seconds), plan: Number(plan), path: Number(path), end: Number(end) }, anims, reads };
}

function runApply(stage: HTMLElement, svg: SVGElement, parsed: ReturnType<typeof parseRun>, nodeEls: Map<string, Element[]>, T: number): string {
  let routes = 0, working = 0, segs = 0;
  for (const a of parsed.anims) {
    let key = "";
    const el = a.el;
    if (a.kind === "route") {
      const [t0 = 0, t1 = 0] = a.a;
      const k = clamp((T - t0) / 0.55);
      const state = T < t0 ? 0 : T < t1 ? 1 : 2;
      key = `${Math.round(k * 12)}:${state}`;
      if (state) routes++;
      if (key !== a.last) { el.style.strokeDashoffset = String(1 - ease(k)); el.style.opacity = state === 0 ? "0" : state === 1 ? "0.85" : "0.16"; }
    } else if (a.kind === "draw") {
      const [t0 = 0, t1 = 0] = a.a;
      const k = clamp((T - t0) / Math.max(0.1, t1 - t0));
      key = String(Math.round(k * 16));
      if (k > 0.5) segs++;
      if (key !== a.last) { el.style.strokeDashoffset = String(1 - ease(k)); el.style.opacity = k > 0 ? "1" : "0"; }
    } else if (a.kind === "fade") {
      const [t0 = 0, t1 = 0] = a.a;
      const k = clamp((T - t0) / Math.max(0.1, t1 - t0));
      key = String(Math.round(k * 12));
      if (key !== a.last) el.style.opacity = String(k);
    } else if (a.kind === "work") {
      let on = false;
      for (let i = 0; i + 1 < a.a.length; i += 2) if (T >= a.a[i]! && T < a.a[i + 1]!) on = true;
      key = on ? "1" : "0";
      if (on) working++;
      if (key !== a.last) el.classList.toggle("is-work", on);
    }
    a.last = key;
  }
  // the things that have been read so far, and the ones on the answer's path
  for (const [id, t] of parsed.reads) for (const el of nodeEls.get(id) ?? []) el.classList.toggle("is-read", T >= t);
  const pathIds = parsed.reads; void pathIds;
  const onPath = T >= parsed.run.path;
  svg.classList.toggle("is-answered", onPath);
  const step = T < parsed.run.plan ? 0 : T < parsed.run.path ? 1 : 2;
  q<HTMLElement>(".steps__li", stage).forEach((li, i) => li.classList.toggle("is-now", i === step));
  stage.dataset.step = String(step);
  stage.dataset.runT = T.toFixed(1);
  const sig = `${routes}:${working}:${segs}:${step}`;
  stage.dataset.scVerifyState = sig;
  return sig;
}

// ================= scroll mode =================

function actProgress(act: HTMLElement): number {
  const r = act.getBoundingClientRect();
  const total = r.height - innerHeight;
  return total <= 0 ? 0 : clamp(-r.top / total);
}
const nearView = (act: HTMLElement) => { const r = act.getBoundingClientRect(); return r.bottom > -innerHeight * 0.5 && r.top < innerHeight * 1.5; };

function scrollScenes() {
  const form = document.querySelector<HTMLElement>('[data-scene="form"]');
  const ask = document.querySelector<HTMLElement>('[data-scene="ask"]');
  const formAct = form?.closest<HTMLElement>("[data-sc-act]") ?? null;
  const askAct = ask?.closest<HTMLElement>("[data-sc-act]") ?? null;
  const fAnims = form ? parseForm(form) : [];
  const stats = { things: form?.querySelector<HTMLElement>('[data-stat="things"]') ?? null, links: form?.querySelector<HTMLElement>('[data-stat="links"]') ?? null };
  const svg = ask?.querySelector<SVGElement>("svg[data-run]") ?? null;
  const parsed = svg ? parseRun(svg) : null;
  const nodeEls = new Map<string, Element[]>();
  if (svg) q("[data-id]", svg).forEach((e) => { const id = e.getAttribute("data-id")!; if (!e.classList.contains("br")) (nodeEls.get(id) ?? nodeEls.set(id, []).get(id)!).push(e); });
  const video = ask?.querySelector<HTMLVideoElement>("video[data-clip-src]") ?? null;
  const scrubber = video ? new Scrubber(video, ask!) : null;

  let raf = 0;
  let running = false;
  let lastSig = "";
  const frame = () => {
    raf = 0;
    if (formAct && form && nearView(formAct)) {
      const p = actProgress(formAct);
      formApply(form, fAnims, p, stats);
    }
    if (askAct && ask && svg && parsed && nearView(askAct)) {
      const p = actProgress(askAct);
      const T = p * parsed.run.seconds;
      const sig = runApply(ask, svg, parsed, nodeEls, T);
      scrubber?.target(T);
      if (sig !== lastSig) lastSig = sig;
    }
    if (scrubber?.busy()) schedule();
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };
  const onScroll = () => schedule();
  return {
    start() {
      if (running) return;
      running = true;
      addEventListener("scroll", onScroll, { passive: true });
      addEventListener("resize", onScroll);
      scrubber?.arm();
      schedule();
    },
    stop() {
      running = false;
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
    },
  };
}

/**
 * Plays a clip to a target time that scroll sets. The clip is fetched whole as a blob just before the act (so seeking needs
 * no range support), written to a video that was encoded with a keyframe every second, and walked toward the target a
 * fraction per frame, so a trackpad flick does not stutter. The poster shows until the first frame has painted.
 */
class Scrubber {
  private cur = 0;
  private want = 0;
  private ready = false;
  private seeking = false;
  private started = false;
  constructor(private v: HTMLVideoElement, private stage: HTMLElement) {
    v.addEventListener("seeking", () => { this.seeking = true; });
    v.addEventListener("seeked", () => { this.seeking = false; });
  }
  arm() {
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting) && !this.started) { this.started = true; void this.load(); io.disconnect(); }
    }, { rootMargin: "160% 0px" });
    io.observe(this.stage);
  }
  private async load() {
    const src = this.v.dataset.clipSrc;
    if (!src) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      this.v.src = url;
      this.v.load();
      await new Promise<void>((ok) => { this.v.addEventListener("loadeddata", () => ok(), { once: true }); });
      this.ready = true;
      this.v.classList.add("is-live");
      this.stage.classList.add("has-clip");
      window.dispatchEvent(new Event("scroll"));
    } catch { /* the poster stays */ }
  }
  target(T: number) { this.want = Math.max(0, Math.min(T, (this.v.duration || T) - 0.05)); }
  busy(): boolean {
    if (!this.ready) return false;
    const d = this.want - this.cur;
    if (Math.abs(d) < 0.03) return false;
    this.cur += d * 0.28;
    if (!this.seeking) this.v.currentTime = this.cur;
    return true;
  }
}

// ================= flat mode =================

function flatScenes() {
  const form = document.querySelector<HTMLElement>('[data-scene="form"]');
  const ask = document.querySelector<HTMLElement>('[data-scene="ask"]');
  const plan = document.querySelector<HTMLElement>(".act--plan");
  if (plan) { const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { plan.style.setProperty("--sc-p", "1"); io.disconnect(); } }); io.observe(plan); }
  const stats = (s: HTMLElement) => ({ things: s.querySelector<HTMLElement>('[data-stat="things"]'), links: s.querySelector<HTMLElement>('[data-stat="links"]') });
  if (form) {
    const anims = parseForm(form);
    playWhenSeen(form, reduce || saveData ? 0 : 11000, (u) => formApply(form, anims, u, stats(form)), 1, true);
  }
  if (ask) {
    const svg = ask.querySelector<SVGElement>("svg[data-run]");
    if (svg) {
      const parsed = parseRun(svg);
      const nodeEls = new Map<string, Element[]>();
      q("[data-id]", svg).forEach((e) => { const id = e.getAttribute("data-id")!; if (!e.classList.contains("br")) (nodeEls.get(id) ?? nodeEls.set(id, []).get(id)!).push(e); });
      // 100 real seconds are played in 16: the run, sped up
      playWhenSeen(ask, reduce || saveData ? 0 : 16000, (u) => runApply(ask, svg, parsed, nodeEls, u * parsed.run.seconds), 1, true);
    }
  }
  return { start() { /* nothing to start: flat scenes play when seen */ }, stop() { /* nothing to stop */ } };
}

/** Plays a picture once when it is mostly on screen: `apply(u)` for u from 0 to `to` over `ms`. ms = 0 shows it finished. */
function playWhenSeen(el: HTMLElement, ms: number, apply: (u: number) => unknown, to: number, withReplay: boolean) {
  if (ms === 0) { apply(to); return; }
  apply(0);
  let t0 = 0;
  let raf = 0;
  let played = false;
  const step = (now: number) => {
    if (!t0) t0 = now;
    const u = clamp((now - t0) / ms) * to;
    apply(u);
    if (u < to) raf = requestAnimationFrame(step); else raf = 0;
  };
  const play = () => { cancelAnimationFrame(raf); t0 = 0; raf = requestAnimationFrame(step); };
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting && !played) { played = true; play(); } }, { threshold: 0.35 });
    io.observe(el);
  } else apply(to);
  if (withReplay) {
    const cap = el.querySelector(".panel__cap, .panel__stat");
    if (cap) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "replay"; b.textContent = "Replay";
      b.addEventListener("click", play);
      cap.append(" ", b);
    }
  }
}

// ================= the courier route: Fluffy walks the stops as you scroll =================

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

// ---------- keyboard: a focused control inside a pinned act is scrolled to where it is shown ----------
function keepFocusVisible() {
  document.addEventListener("focusin", (e) => {
    const el = e.target as HTMLElement;
    const act = el.closest<HTMLElement>('[data-sc-act="pin"], [data-sc-act="scrub"]');
    if (!act) return;
    const r = act.getBoundingClientRect();
    if (r.top > 1 || r.top < -innerHeight * 0.4) scrollTo({ top: scrollY + r.top, behavior: "instant" as ScrollBehavior });
  });
}

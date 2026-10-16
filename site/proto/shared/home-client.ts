// Behaviour of the home page's story sections (shared by prototypes A and B).
//   problem: on a wide screen with motion welcome the section becomes a pinned story driven by one number, --p (0 to 1), from Motion's
//            scroll(); everything else is CSS reading that number (shared/home.css). Elsewhere it stays static.
//   flow:    problems on the left flow through the app to finished work on the right: lines and light pulses on a canvas, cards in HTML.
// Only transform, opacity and canvas drawing change per frame; both pause off-screen and in a hidden tab.
import { scroll } from "motion";
import { reduceMotion, saveData } from "./chrome.ts";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const sm = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const wideQuery = window.matchMedia("(min-width: 52.01rem)");

// ---------- the problem scene ----------
function initProblem(): void {
  const el = document.querySelector<HTMLElement>("[data-problem]");
  if (!el) return;
  const stage = el.querySelector<HTMLElement>("[data-pstage]")!;
  const beats = [...el.querySelectorAll<HTMLElement>(".beat")];
  const scrub = () => wideQuery.matches && !reduceMotion();
  const sizeStage = () => { stage.style.setProperty("--sw", `${stage.clientWidth}px`); stage.style.setProperty("--sh", `${stage.clientHeight}px`); };
  const setMode = () => { el.classList.toggle("is-scrub", scrub()); if (scrub()) sizeStage(); };
  setMode(); wideQuery.addEventListener("change", setMode);
  new ResizeObserver(() => { if (scrub()) sizeStage(); }).observe(stage);

  const win = (a: number, b: number, p: number) => sm(a - 0.02, a, p) - sm(b, b + 0.02, p);
  const apply = (p: number) => {
    if (!scrub()) return;
    el.style.setProperty("--p", p.toFixed(4));
    const dim = sm(0.06, 0.09, p) * (1 - sm(0.5, 0.54, p));
    const g = (a: number, b: number) => (1 - 0.74 * dim * (1 - win(a, b, p))).toFixed(3);
    stage.style.setProperty("--g-people", g(0.08, 0.2));
    stage.style.setProperty("--g-tools", g(0.2, 0.34));
    stage.style.setProperty("--g-memory", g(0.34, 0.48));
    stage.style.setProperty("--g-alerts", g(0.34, 0.48));
    stage.style.setProperty("--links", (sm(0.5, 0.56, p) * (1 - sm(0.62, 0.66, p))).toFixed(3));
    stage.style.setProperty("--pull-all", sm(0.64, 0.74, p).toFixed(3));
    stage.style.setProperty("--stress", (sm(0.54, 0.64, p) * (1 - sm(0.66, 0.7, p))).toFixed(3));
    stage.style.setProperty("--calm", sm(0.7, 0.82, p).toFixed(3));
    stage.style.setProperty("--brain", sm(0.62, 0.78, p).toFixed(3));
    el.style.setProperty("--head", sm(0.8, 0.87, p).toFixed(3));
    const active = p < 0.08 ? -1 : p < 0.2 ? 0 : p < 0.34 ? 1 : p < 0.48 ? 2 : p < 0.6 ? 3 : p < 0.72 ? 4 : -1;
    beats.forEach((b, i) => b.classList.toggle("is-on", i === active));
  };
  scroll((p: number) => apply(p), { target: el, offset: ["start 68px", "end end"] });
  apply(0);
}

// ---------- the flow ----------
function initFlow(): void {
  const root = document.querySelector<HTMLElement>("[data-flow]");
  if (!root) return;
  const stage = root.querySelector<HTMLElement>("[data-fstage]")!;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-fcanvas]")!;
  const app = root.querySelector<HTMLElement>("[data-fapp]")!;
  const ring = root.querySelector<HTMLElement>(".flow__ring")!;
  const ins = [...root.querySelectorAll<HTMLElement>(".fcard--in")];
  const outs = [...root.querySelectorAll<HTMLElement>(".fcard--out")];
  const N = Math.min(ins.length, outs.length);
  const GAP = 2.6, PERIOD = GAP * N;
  const pulseRing = () => { ring.classList.remove("is-pulse"); void ring.offsetWidth; ring.classList.add("is-pulse"); };

  if (reduceMotion() || saveData()) { outs.forEach((o) => o.classList.add("is-lit")); return; }

  type Pt = { x: number; y: number };
  let W = 0, H = 0; let dpr = 1;
  let inAnch: Pt[] = [], outAnch: Pt[] = [], appIn: Pt[] = [], appOut: Pt[] = [];
  let base: HTMLCanvasElement | null = null;
  const g2 = canvas.getContext("2d")!;
  const rel = (r: DOMRect, s: DOMRect) => ({ left: r.left - s.left, right: r.right - s.left, top: r.top - s.top, bottom: r.bottom - s.top });
  const bez = (a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt => { const u = 1 - t; return { x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x, y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y }; };
  const ctrl = (a: Pt, d: Pt): [Pt, Pt] => { const k = (d.x - a.x) * 0.5; return [{ x: a.x + k, y: a.y }, { x: d.x - k, y: d.y }]; };
  const layout = () => {
    const s = stage.getBoundingClientRect(); W = s.width; H = s.height; dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const a = rel(app.getBoundingClientRect(), s);
    inAnch = ins.map((c) => { const r = rel(c.getBoundingClientRect(), s); return { x: r.right, y: (r.top + r.bottom) / 2 }; });
    outAnch = outs.map((c) => { const r = rel(c.getBoundingClientRect(), s); return { x: r.left, y: (r.top + r.bottom) / 2 }; });
    const spread = (n: number) => Array.from({ length: n }, (_, i) => a.top + (a.bottom - a.top) * (0.2 + (0.6 * i) / Math.max(1, n - 1)));
    appIn = spread(N).map((y) => ({ x: a.left, y })); appOut = spread(N).map((y) => ({ x: a.right, y }));
    base = document.createElement("canvas"); base.width = canvas.width; base.height = canvas.height;
    const b = base.getContext("2d")!; b.scale(dpr, dpr); b.lineWidth = 1; b.strokeStyle = "rgba(70,61,51,0.2)";
    for (let i = 0; i < N; i++) for (const [p0, p3] of [[inAnch[i]!, appIn[i]!], [appOut[i]!, outAnch[i]!]] as [Pt, Pt][]) { const [c1, c2] = ctrl(p0, p3); b.beginPath(); b.moveTo(p0.x, p0.y); b.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p3.x, p3.y); b.stroke(); }
  };
  new ResizeObserver(layout).observe(stage); layout();

  const wide = () => wideQuery.matches;
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const state = { on: new Array<boolean>(N).fill(false), lit: new Array<boolean>(N).fill(false), ringAt: new Array<boolean>(N).fill(false) };
  const dot = (p: Pt, r: number, a: number) => { const gr = g2.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.4); gr.addColorStop(0, `rgba(255,236,170,${a})`); gr.addColorStop(0.3, `rgba(224,150,40,${a * 0.7})`); gr.addColorStop(1, "rgba(224,150,40,0)"); g2.fillStyle = gr; g2.beginPath(); g2.arc(p.x, p.y, r * 3.4, 0, Math.PI * 2); g2.fill(); };
  const comet = (p0: Pt, p3: Pt, t: number, a: number) => {
    const [c1, c2] = ctrl(p0, p3);
    for (let k = 10; k >= 0; k--) { const tt = Math.max(0, t - k * 0.018); const q = bez(p0, c1, c2, p3, ease(tt)); dot(q, 2.1 - k * 0.12, a * (1 - k / 11)); }
  };
  let t0 = performance.now(), raf = 0, running = false, visible = false;
  const frame = (ts: number) => {
    if (!running) return;
    const t = (ts - t0) / 1000;
    if (wide()) {
      g2.setTransform(dpr, 0, 0, dpr, 0, 0); g2.clearRect(0, 0, W, H);
      if (base) g2.drawImage(base, 0, 0, W, H);
      for (let i = 0; i < N; i++) {
        const tt = (((t - i * GAP) % PERIOD) + PERIOD) % PERIOD;
        // two quiet drifters per line, always
        for (const [p0, p3, ph] of [[inAnch[i]!, appIn[i]!, 0.0], [appOut[i]!, outAnch[i]!, 0.5]] as [Pt, Pt, number][]) { const [c1, c2] = ctrl(p0, p3); const u = (t * 0.09 + i * 0.17 + ph) % 1; dot(bez(p0, c1, c2, p3, u), 1.3, 0.35); }
        if (tt > 0.2 && tt < 1.2) comet(inAnch[i]!, appIn[i]!, (tt - 0.2) / 1.0, 1);
        if (tt > 1.45 && tt < 2.45) comet(appOut[i]!, outAnch[i]!, (tt - 1.45) / 1.0, 1);
        const on = tt < GAP, lit = tt > 2.45 && tt < 11.5, rg = tt > 1.2 && tt < 1.3;
        if (on !== state.on[i]) { state.on[i] = on; ins[i]!.classList.toggle("is-on", on); }
        if (lit !== state.lit[i]) { state.lit[i] = lit; outs[i]!.classList.toggle("is-lit", lit); }
        if (rg && !state.ringAt[i]) { state.ringAt[i] = true; pulseRing(); } else if (!rg) state.ringAt[i] = false;
      }
    } else {
      // phones: no canvas; one pair at a time
      for (let i = 0; i < N; i++) {
        const tt = (((t - i * GAP) % PERIOD) + PERIOD) % PERIOD; const on = tt < GAP;
        if (on !== state.on[i]) { state.on[i] = on; ins[i]!.classList.toggle("is-on", on); if (on) pulseRing(); }
      }
    }
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (running || !visible || document.hidden) return; running = true; t0 = performance.now() - 0; raf = requestAnimationFrame(frame); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; visible ? start() : stop(); }, { rootMargin: "80px" }).observe(root);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
}

export function initHome(): void {
  initProblem();
  initFlow();
}

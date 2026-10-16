// Behaviour of the home page's story sections (shared by prototypes A and B).
//   problem: on a wide screen with motion welcome the section becomes a pinned story driven by one number, --p (0 to 1), from Motion's
//            scroll(); everything else is CSS reading that number (shared/home.css). Elsewhere it stays static.
//   flow:    problems on the left flow into the company brain, shown as the living graph of the sample business (47 things, 60 links),
//            which lights up the nodes each problem runs through and rearranges them into a short chain, and finished work comes out on the
//            right. Lines and light pulses on a canvas, cards in HTML.
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
interface GraphData { nodes: [number, number, number, string][]; edges: [number, number][]; stories: number[][] }
type Pt = { x: number; y: number };

function initFlow(): void {
  const root = document.querySelector<HTMLElement>("[data-flow]");
  if (!root) return;
  const stage = root.querySelector<HTMLElement>("[data-fstage]")!;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-fcanvas]")!;
  const app = root.querySelector<HTMLElement>("[data-fapp]")!;
  const panel = root.querySelector<HTMLElement>(".gpanel")!;
  const gcanvas = root.querySelector<HTMLCanvasElement>("[data-gcanvas]")!;
  const glabels = root.querySelector<HTMLElement>("[data-glabels]")!;
  const ring = root.querySelector<HTMLElement>(".flow__ring")!;
  const ins = [...root.querySelectorAll<HTMLElement>(".fcard--in")];
  const outs = [...root.querySelectorAll<HTMLElement>(".fcard--out")];
  const graph = JSON.parse(root.querySelector("#graph-data")!.textContent!) as GraphData;
  const N = Math.min(ins.length, outs.length);
  const GAP = 3.9, PERIOD = GAP * N;
  const pulseRing = () => { ring.classList.remove("is-pulse"); void ring.offsetWidth; ring.classList.add("is-pulse"); };
  const still = reduceMotion() || saveData();

  // ----- the living graph -----
  const gc = gcanvas.getContext("2d")!;
  let GW = 1, GH = 1, gdpr = 1;
  const nn = graph.nodes.length;
  const deg = new Array<number>(nn).fill(0);
  graph.edges.forEach(([a, b]) => { deg[a]!++; deg[b]!++; });
  const baseX = new Float32Array(nn), baseY = new Float32Array(nn);
  const labs = Array.from({ length: 6 }, () => { const e = document.createElement("span"); e.className = "gpanel__lab"; glabels.append(e); return e; });
  const COLOURS = ["#c48a2c", "#d1a43a", "#a5651b", "#b87a3a", "#8d7a3d"];
  const layoutGraph = () => {
    const r = panel.getBoundingClientRect(); GW = r.width; GH = r.height; gdpr = Math.min(window.devicePixelRatio || 1, 2);
    gcanvas.width = Math.round(GW * gdpr); gcanvas.height = Math.round(GH * gdpr);
    graph.nodes.forEach((n, i) => { baseX[i] = GW * (0.12 + 0.76 * n[0]); baseY[i] = GH * (0.14 + 0.66 * n[1]); });
  };
  const px = new Float32Array(nn), py = new Float32Array(nn);
  let labStory = -1;
  /** Draw the graph at time t (seconds); `act` is the active story and `local` the seconds since it began. Idle when act < 0. */
  const drawGraph = (t: number, act: number, local: number) => {
    gc.setTransform(gdpr, 0, 0, gdpr, 0, 0); gc.clearRect(0, 0, GW, GH);
    const story = act >= 0 ? graph.stories[act % graph.stories.length]! : [];
    const m = story.length;
    const fadeOut = 1 - sm(3.05, 3.6, local);
    const focus = act >= 0 ? sm(1.0, 1.5, local) * fadeOut : 0;
    const arr = act >= 0 ? sm(1.35, 2.0, local) * fadeOut : 0;
    const inStory = new Int8Array(nn).fill(-1); story.forEach((ni, k) => (inStory[ni] = k));
    const lit = (k: number) => sm(0, 0.3, local - (1.25 + k * 0.24)) * fadeOut;
    for (let i = 0; i < nn; i++) {
      let x = baseX[i]! + Math.sin(t * 0.5 + i * 1.7) * 3.2, y = baseY[i]! + Math.cos(t * 0.42 + i * 1.1) * 3.2;
      const k = inStory[i]!;
      if (k >= 0 && m > 0) { const tx = GW * (0.17 + 0.66 * (m === 1 ? 0.5 : k / (m - 1))), ty = GH * (0.44 + 0.075 * Math.sin(k * 1.5 + 0.4)); x += (tx - x) * arr; y += (ty - y) * arr; }
      px[i] = x; py[i] = y;
    }
    gc.lineWidth = 1;
    for (const [a, b] of graph.edges) {
      const both = inStory[a]! >= 0 && inStory[b]! >= 0;
      gc.strokeStyle = `rgba(80,66,46,${(both ? 0.2 : 0.14) * (1 - 0.72 * focus)})`;
      gc.beginPath(); gc.moveTo(px[a]!, py[a]!); gc.lineTo(px[b]!, py[b]!); gc.stroke();
    }
    // the chain the answer runs through
    for (let k = 0; k + 1 < m; k++) {
      const a = story[k]!, b = story[k + 1]!, l = Math.min(lit(k), lit(k + 1)); if (l <= 0.01) continue;
      gc.strokeStyle = `rgba(224,150,40,${0.95 * l})`; gc.lineWidth = 2.2; gc.beginPath(); gc.moveTo(px[a]!, py[a]!); gc.lineTo(px[b]!, py[b]!); gc.stroke();
    }
    for (let i = 0; i < nn; i++) {
      const k = inStory[i]!; const l = k >= 0 ? lit(k) : 0;
      const dim = 1 - 0.78 * focus * (k >= 0 ? 0 : 1);
      const r = 2.5 + Math.min(4, deg[i]! * 0.35) + l * 3.2;
      if (l > 0.02) { const g = gc.createRadialGradient(px[i]!, py[i]!, 0, px[i]!, py[i]!, r * 3.6); g.addColorStop(0, `rgba(255,226,150,${0.8 * l})`); g.addColorStop(1, "rgba(224,150,40,0)"); gc.fillStyle = g; gc.beginPath(); gc.arc(px[i]!, py[i]!, r * 3.6, 0, 6.2832); gc.fill(); }
      gc.fillStyle = k >= 0 && l > 0.3 ? "#e0961e" : COLOURS[graph.nodes[i]![2]! % COLOURS.length]!; gc.globalAlpha = (0.55 + 0.4 * l) * dim; gc.beginPath(); gc.arc(px[i]!, py[i]!, r, 0, 6.2832); gc.fill(); gc.globalAlpha = 1;
    }
    // short labels on the lit nodes
    if (act !== labStory) { labStory = act; labs.forEach((e, k) => { const ni = story[k]; e.textContent = ni === undefined ? "" : graph.nodes[ni]![3]; }); }
    labs.forEach((e, k) => { const ni = story[k]; if (ni === undefined) { e.style.opacity = "0"; return; } const l = lit(k); e.style.opacity = l.toFixed(2); e.style.transform = `translate3d(${px[ni]!.toFixed(1)}px, ${(py[ni]! - 12).toFixed(1)}px, 0) translate(-50%, -100%)`; });
  };
  const resizeG = new ResizeObserver(() => { layoutGraph(); drawGraph(performance.now() / 1000, -1, 0); });
  resizeG.observe(panel); layoutGraph();

  if (still) { outs.forEach((o) => o.classList.add("is-lit")); drawGraph(0, -1, 0); return; }

  // ----- the lines and pulses between the cards and the graph (wide screens) -----
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
    appIn = spread(N).map((y) => ({ x: a.left + 10, y })); appOut = spread(N).map((y) => ({ x: a.right - 10, y }));
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
    const cyc = t % PERIOD; const act = Math.floor(cyc / GAP); const local = cyc - act * GAP; // story `act` is the one being worked on now
    drawGraph(t, act, local);
    if (wide()) {
      g2.setTransform(dpr, 0, 0, dpr, 0, 0); g2.clearRect(0, 0, W, H);
      if (base) g2.drawImage(base, 0, 0, W, H);
      for (let i = 0; i < N; i++) {
        const tt = t < PERIOD ? t - i * GAP : (((t - i * GAP) % PERIOD) + PERIOD) % PERIOD; // the first round starts at the first problem
        for (const [p0, p3, ph] of [[inAnch[i]!, appIn[i]!, 0.0], [appOut[i]!, outAnch[i]!, 0.5]] as [Pt, Pt, number][]) { const [c1, c2] = ctrl(p0, p3); const u = (t * 0.09 + i * 0.17 + ph) % 1; dot(bez(p0, c1, c2, p3, u), 1.3, 0.3); }
        if (tt > 0.2 && tt < 1.2) comet(inAnch[i]!, appIn[i]!, (tt - 0.2) / 1.0, 1);
        if (tt > 2.6 && tt < 3.6) comet(appOut[i]!, outAnch[i]!, (tt - 2.6) / 1.0, 1);
        const on = tt >= 0 && tt < GAP, lit = tt > 3.6 && tt < 14, rg = tt > 1.2 && tt < 1.3;
        if (on !== state.on[i]) { state.on[i] = on; ins[i]!.classList.toggle("is-on", on); }
        if (lit !== state.lit[i]) { state.lit[i] = lit; outs[i]!.classList.toggle("is-lit", lit); }
        if (rg && !state.ringAt[i]) { state.ringAt[i] = true; pulseRing(); } else if (!rg) state.ringAt[i] = false;
      }
    } else {
      for (let i = 0; i < N; i++) {
        const tt = t < PERIOD ? t - i * GAP : (((t - i * GAP) % PERIOD) + PERIOD) % PERIOD; const on = tt >= 0 && tt < GAP, lit = tt > 3.6 && tt < 14;
        if (on !== state.on[i]) { state.on[i] = on; ins[i]!.classList.toggle("is-on", on); if (on) pulseRing(); }
        if (lit !== state.lit[i]) { state.lit[i] = lit; outs[i]!.classList.toggle("is-lit", lit); }
      }
    }
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (running || !visible || document.hidden) return; running = true; t0 = performance.now(); raf = requestAnimationFrame(frame); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; visible ? start() : stop(); }, { rootMargin: "80px" }).observe(root);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
}

// ---------- the brain that keeps growing ----------
interface GrowData { nodes: [number, number, number, number][]; edges: [number, number, number][]; path: number[]; labels: string[] }

function initGrow(): void {
  const root = document.querySelector<HTMLElement>("[data-grow]");
  if (!root) return;
  const panel = root.querySelector<HTMLElement>(".gpanel")!;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-grow-canvas]")!;
  const labelsEl = root.querySelector<HTMLElement>("[data-grow-labels]")!;
  const cap = root.querySelector<HTMLElement>("[data-grow-cap]")!;
  const btns = [...root.querySelectorAll<HTMLButtonElement>("[data-grow-stage]")];
  const data = JSON.parse(root.querySelector("#grow-data")!.textContent!) as GrowData;
  const g = canvas.getContext("2d")!;
  const NAMES = ["Week 1", "Month 3", "Year 1"];
  const COLOURS = ["#c48a2c", "#d1a43a", "#a5651b", "#b87a3a", "#8d7a3d"];
  const nn = data.nodes.length;
  const labs = data.labels.map((t) => { const e = document.createElement("span"); e.className = "gpanel__lab"; e.textContent = t; labelsEl.append(e); return e; });
  let W = 1, H = 1, dpr = 1;
  const X = new Float32Array(nn), Y = new Float32Array(nn);
  const appear = new Float32Array(nn);
  const layout = () => { const r = panel.getBoundingClientRect(); W = r.width; H = r.height; dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); data.nodes.forEach((n, i) => { X[i] = W * (0.1 + 0.8 * n[0]); Y[i] = H * (0.1 + 0.72 * n[1]); }); };
  new ResizeObserver(() => { layout(); draw(0, 0); }).observe(panel);
  let stage = 0, since = 0; // seconds since the stage or the question last changed
  const inPath = new Int8Array(nn).fill(-1); data.path.forEach((ni, k) => (inPath[ni] = k));
  const setStage = (s: number) => { stage = s; since = 0; btns.forEach((b, i) => b.setAttribute("aria-pressed", String(i === s))); cap.textContent = NAMES[s]!; };

  /** Draw: `dt` seconds since the last frame (0 for a static picture). The path lights 0.9 s after a stage appears, holds, then relaxes. */
  const draw = (t: number, dt: number) => {
    since += dt;
    const k = since - 0.9; const lit = (i: number) => clamp01((k - i * 0.26) / 0.3) * (1 - sm(3.6, 4.2, k));
    const focus = sm(0, 0.5, k) * (1 - sm(3.6, 4.2, k));
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    for (let i = 0; i < nn; i++) { const target = data.nodes[i]![3] <= stage ? 1 : 0; appear[i] = dt === 0 ? target : appear[i]! + (target - appear[i]!) * (1 - Math.exp(-dt * 3.2)); }
    g.lineWidth = 1;
    for (const [a, b, st] of data.edges) {
      const al = Math.min(appear[a]!, appear[b]!); if (al < 0.02 || st > stage + 0) continue;
      const onPath = inPath[a]! >= 0 && inPath[b]! >= 0 && Math.abs(inPath[a]! - inPath[b]!) === 1;
      g.strokeStyle = `rgba(80,66,46,${(0.15 * al) * (1 - 0.8 * focus)})`; g.beginPath(); g.moveTo(X[a]!, Y[a]!); g.lineTo(X[b]!, Y[b]!); g.stroke();
      if (onPath) { const l = Math.min(lit(inPath[a]!), lit(inPath[b]!)); if (l > 0.02) { g.strokeStyle = `rgba(224,150,40,${0.95 * l})`; g.lineWidth = 2.4; g.beginPath(); g.moveTo(X[a]!, Y[a]!); g.lineTo(X[b]!, Y[b]!); g.stroke(); g.lineWidth = 1; } }
    }
    for (let i = 0; i < nn; i++) {
      const al = appear[i]!; if (al < 0.02) continue;
      const pk = inPath[i]!; const l = pk >= 0 ? lit(pk) : 0;
      const dim = 1 - 0.78 * focus * (pk >= 0 ? 0 : 1);
      const base = i < 47 ? 3.4 : 2.8; const r = (base + l * 3) * (0.4 + 0.6 * al);
      if (l > 0.02) { const gr = g.createRadialGradient(X[i]!, Y[i]!, 0, X[i]!, Y[i]!, r * 3.4); gr.addColorStop(0, `rgba(255,226,150,${0.8 * l})`); gr.addColorStop(1, "rgba(224,150,40,0)"); g.fillStyle = gr; g.beginPath(); g.arc(X[i]!, Y[i]!, r * 3.4, 0, 6.2832); g.fill(); }
      g.globalAlpha = al * (0.6 + 0.35 * l) * dim; g.fillStyle = pk >= 0 && l > 0.3 ? "#e0961e" : COLOURS[data.nodes[i]![2]! % COLOURS.length]!;
      g.beginPath(); g.arc(X[i]!, Y[i]!, r, 0, 6.2832); g.fill(); g.globalAlpha = 1;
    }
    labs.forEach((e, j) => { const ni = data.path[j]!; const l = lit(j); e.style.opacity = l.toFixed(2); e.style.transform = `translate3d(${X[ni]!.toFixed(1)}px, ${(Y[ni]! - 12).toFixed(1)}px, 0) translate(-50%, -100%)`; });
    void t;
  };
  layout();
  const reduced = reduceMotion();
  let pausedUntil = 0, last = 0, raf = 0, running = false, visible = false, autoAt = 0;
  btns.forEach((b, i) => b.addEventListener("click", () => { setStage(i); pausedUntil = performance.now() + 14000; if (reduced) { since = 2; draw(0, 0); } }));
  if (reduced) { setStage(0); since = 2.5; draw(0, 0); return; }
  const frame = (ts: number) => {
    if (!running) return;
    const dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    if (ts > pausedUntil && since > 7.2 && ts > autoAt) { setStage((stage + 1) % 3); autoAt = ts + 500; }
    draw(ts / 1000, dt);
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (running || !visible || document.hidden) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; visible ? start() : stop(); }, { rootMargin: "60px" }).observe(root);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  draw(0, 0);
}

export function initHome(): void {
  initProblem();
  initGrow();
  initFlow();
}

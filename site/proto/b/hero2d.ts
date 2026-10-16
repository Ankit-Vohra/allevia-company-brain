// Prototype B's hero: the same idea as A, drawn as a calm diagram. The workspace panel assembles itself (tools slide in, the brain and
// its five clusters appear as cards, lines are drawn with a spring), then the brain answers real founder questions one at a time: a
// question is typed, the asker lights up, a small light travels along the real line into the brain, the clusters the answer lives in
// and the tools it reads light up in turn, and a short answer arrives. Reduced motion shows one finished frame and a button for the next.
import { animate } from "motion";
import { isPhone, reduceMotion } from "../shared/chrome.ts";

interface Q { id: string; agent: string; agentName: string; q: string; tools: string[]; toolNames: string[]; regions: string[]; path: string[]; answer: string; waits: boolean }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SVGNS = "http://www.w3.org/2000/svg";

export function startBHero(root: HTMLElement): void {
  const ws = root.querySelector<HTMLElement>("[data-ws]")!;
  const svg = root.querySelector<SVGSVGElement>("[data-lines]")!;
  const nuc = root.querySelector<HTMLElement>("[data-nuc]")!;
  const typed = root.querySelector<HTMLElement>("[data-typed]")!;
  const ph = root.querySelector<HTMLElement>("[data-ph]")!;
  const ans = root.querySelector<HTMLElement>("[data-wanswer]")!;
  const aFace = root.querySelector<HTMLElement>("[data-wface]")!, aWho = root.querySelector<HTMLElement>("[data-wwho]")!, aOk = root.querySelector<HTMLElement>("[data-wok]")!;
  const aText = root.querySelector<HTMLElement>("[data-wtext]")!, aHow = root.querySelector<HTMLElement>("[data-whow]")!;
  const nextBtn = root.querySelector<HTMLButtonElement>("[data-next]");
  const video = root.querySelector<HTMLVideoElement>("[data-office] video");
  const data = JSON.parse(root.querySelector("#hero-data")!.textContent!) as { questions: Q[] };
  const reduced = reduceMotion();
  const wide = () => !isPhone() && ws.clientWidth > 760;

  const tools = new Map([...root.querySelectorAll<HTMLElement>("[data-tool]")].map((e) => [e.dataset.tool!, e]));
  const agents = new Map([...root.querySelectorAll<HTMLElement>("[data-agent]")].map((e) => [e.dataset.agent!, e]));
  const clusters = new Map([...root.querySelectorAll<HTMLElement>("[data-cluster]")].map((e) => [e.dataset.cluster!, e]));

  // ---------- the lines ----------
  const lines = new Map<string, SVGPathElement>(); // "tool:gmail", "agent:data-analyst", "cluster:app"
  const rel = (e: HTMLElement) => { const r = e.getBoundingClientRect(), s = ws.getBoundingClientRect(); return { l: r.left - s.left, r: r.right - s.left, t: r.top - s.top, b: r.bottom - s.top, cx: (r.left + r.right) / 2 - s.left, cy: (r.top + r.bottom) / 2 - s.top }; };
  const drawLines = () => {
    svg.replaceChildren(); lines.clear();
    if (!wide()) return;
    const s = ws.getBoundingClientRect(); svg.setAttribute("viewBox", `0 0 ${s.width} ${s.height}`);
    const n = rel(nuc);
    const add = (key: string, d: string) => { const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", d); p.setAttribute("pathLength", "1"); p.setAttribute("class", "ws__line"); p.style.strokeDasharray = "1"; p.style.strokeDashoffset = started ? "0" : "1"; svg.append(p); lines.set(key, p); };
    const curve = (ax: number, ay: number, bx: number, by: number) => { const k = (bx - ax) * 0.5; return `M${ax} ${ay} C${ax + k} ${ay} ${bx - k} ${by} ${bx} ${by}`; };
    tools.forEach((el, id) => { const r = rel(el); add(`tool:${id}`, curve(r.r, r.cy, n.l + 6, n.cy)); });
    agents.forEach((el, id) => { const r = rel(el); add(`agent:${id}`, curve(n.r - 6, n.cy, r.l, r.cy)); });
    clusters.forEach((el, id) => {
      const r = rel(el); const horiz = Math.abs(r.cx - n.cx) > Math.abs(r.cy - n.cy) * 0.9;
      add(`cluster:${id}`, horiz ? curve(r.cx < n.cx ? n.l + 10 : n.r - 10, n.cy, r.cx < n.cx ? r.r : r.l, r.cy) : `M${n.cx} ${r.cy > n.cy ? n.b - 10 : n.t + 10} C${n.cx} ${(r.cy + n.cy) / 2} ${r.cx} ${(r.cy + n.cy) / 2} ${r.cx} ${r.cy > n.cy ? r.t : r.b}`);
    });
  };

  // ---------- pulses: a light travelling along a drawn line ----------
  const dot = document.createElementNS(SVGNS, "g"); dot.setAttribute("class", "ws__dot");
  dot.innerHTML = `<circle r="11" fill="rgba(224,150,40,0.22)"/><circle r="4.2" fill="#d1a43a"/><circle r="1.8" fill="#fff6dc"/>`;
  const pulse = async (key: string, reverse = false, ms = 900) => {
    const p = lines.get(key); if (!p || !wide()) { await sleep(Math.min(ms, 500)); return; }
    svg.append(dot); dot.style.opacity = "1"; const len = p.getTotalLength();
    await new Promise<void>((res) => { animate(0, 1, { duration: ms / 1000, ease: [0.45, 0, 0.2, 1], onUpdate: (v: number) => { const pt = p.getPointAtLength((reverse ? 1 - v : v) * len); dot.setAttribute("transform", `translate(${pt.x} ${pt.y})`); }, onComplete: () => res() }); });
    dot.style.opacity = "0";
  };
  const ping = () => { nuc.classList.remove("is-ping"); void nuc.offsetWidth; nuc.classList.add("is-ping"); };

  // ---------- the questions ----------
  let qi = 0, started = false, alive = true;
  const clearOn = () => { root.querySelectorAll(".is-on").forEach((e) => e.classList.remove("is-on")); ans.classList.remove("is-on"); aText.classList.remove("is-in"); };
  const showAnswer = (q: Q, instant: boolean) => {
    aFace.innerHTML = agents.get(q.agent)?.querySelector(".face")?.innerHTML ?? ""; aWho.textContent = `${q.agentName} answers`; aOk.hidden = !q.waits;
    aHow.innerHTML = `<span class="how__lab">How we know</span>${q.path.map((p) => `<span class="how__pill">${p}</span>`).join('<span class="how__arrow" aria-hidden="true"></span>')}`;
    aText.textContent = "";
    q.answer.split(" ").forEach((w, i) => { const s = document.createElement("span"); s.className = "w"; s.textContent = w + " "; s.style.transitionDelay = instant ? "0ms" : `${i * 26}ms`; aText.append(s); });
    ans.classList.add("is-on"); void aText.offsetWidth; aText.classList.add("is-in");
  };
  const typeIn = async (text: string) => { ph.style.opacity = "0"; typed.textContent = ""; for (const ch of text) { typed.textContent += ch; await sleep(34); if (!alive) return; } };
  const runOne = async (q: Q) => {
    clearOn(); typed.textContent = ""; ph.style.opacity = "1";
    await sleep(500); await typeIn(q.q); await sleep(450);
    typed.textContent = ""; ph.style.opacity = "1"; ph.textContent = q.q; ph.classList.add("is-sent");
    const who = agents.get(q.agent); who?.classList.add("is-on");
    await pulse(`agent:${q.agent}`, true, 800); ping();
    for (const r of q.regions.slice(0, 3)) { const c = clusters.get(r); await pulse(`cluster:${r}`, false, 700); c?.classList.add("is-on"); }
    for (const t of q.tools) { tools.get(t)?.classList.add("is-on"); await pulse(`tool:${t}`, false, 800); ping(); }
    showAnswer(q, false); await sleep(5600);
    ph.classList.remove("is-sent"); ph.textContent = "Ask your team anything";
  };
  let visible = true;
  const loop = async () => { while (alive) { if (!visible || document.hidden) { await sleep(300); continue; } await runOne(data.questions[qi % data.questions.length]!); qi++; } };

  // ---------- the assembly ----------
  const assemble = async () => {
    root.classList.add("is-prep");
    const spring = { type: "spring" as const, stiffness: 210, damping: 24 };
    const els = (list: Iterable<HTMLElement>, from: string, delay = 0, step = 0.06) => [...list].forEach((e, i) => animate(e, { opacity: [0, 1], transform: [from, "translate(0,0) scale(1)"] }, { ...spring, delay: delay + i * step }));
    els(tools.values(), "translateX(-14px) scale(0.98)", 0.05);
    animate(nuc, { opacity: [0, 1], transform: ["translate(-50%,-50%) scale(0.86)", "translate(-50%,-50%) scale(1)"] }, { type: "spring", stiffness: 160, damping: 20, delay: 0.25 });
    els(clusters.values(), "translateY(8px) scale(0.97)", 0.5, 0.07);
    els(agents.values(), "translateX(14px) scale(0.98)", 0.45);
    animate(root.querySelector(".ws__ask")!, { opacity: [0, 1] }, { duration: 0.5, delay: 1.0 });
    started = true; drawLines();
    let d = 0.7;
    for (const p of lines.values()) { animate(p, { strokeDashoffset: [1, 0] }, { type: "spring", stiffness: 55, damping: 20, delay: d, restDelta: 0.001 }); d += 0.04; }
    await sleep(2600);
  };

  const finishedFrame = (i: number) => {
    const q = data.questions[i % data.questions.length]!;
    clearOn(); ph.textContent = q.q; ph.classList.add("is-sent"); agents.get(q.agent)?.classList.add("is-on");
    q.regions.forEach((r) => clusters.get(r)?.classList.add("is-on")); q.tools.forEach((t) => tools.get(t)?.classList.add("is-on"));
    showAnswer(q, true);
  };

  new ResizeObserver(() => drawLines()).observe(ws);
  new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; if (video) { if (visible && !reduced) { if (!video.src) video.src = video.dataset.src!; void video.play().catch(() => {}); } else video.pause(); } }, { threshold: 0.2 }).observe(root);

  if (reduced) {
    started = true; drawLines(); lines.forEach((p) => (p.style.strokeDashoffset = "0"));
    finishedFrame(qi);
    if (nextBtn) { nextBtn.hidden = false; nextBtn.addEventListener("click", () => { qi++; finishedFrame(qi); }); }
    return;
  }
  void assemble().then(() => loop());
}

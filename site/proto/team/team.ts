// "Meet your team": the motion of the page. Two modes, chosen once (the inline script in index.html already set html.is-scroll):
//   scroll  wide screen, motion welcome. The page is an ordinary scrolling page. The vendored scrollcraft engine publishes the reader's
//           place in the walk as --sc-p on the act; this file reads that through a MutationObserver (no scroll listener, no loop of its
//           own) and moves Fluffy down the thin trail between the cards, so she is always beside the person you are reading. She
//           walks from card to card, sits by each, gets a treat or a pat, and trots on. The person she sits by looks up and waves.
//           Only her transform changes while you scroll; her frames, the treat and the heart are CSS.
//   cards   a phone, a tablet, reduced motion, data saver, or the engine failing. The same cards stacked, the dog between them.
//           On a phone the cards and the dog come in once as you reach them; with reduced motion nothing moves.
// The engine is never edited (site/vendor/scrollcraft/NOTICE.md).
//
// The engine's stylesheet is imported before the shared base so the site's own body, focus and type rules win over its defaults;
// team.css then sets its colour roles from the site's tokens.
import "../../vendor/scrollcraft/scrollcraft.css";
import "../shared/entry.ts";
import "./team.css";

const root = document.documentElement;
const mq = (q: string) => matchMedia(q);
const reduce = mq("(prefers-reduced-motion: reduce)").matches;
const narrow = mq("(max-width: 860px)").matches;
const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
const wantScroll = !reduce && !narrow && !saveData;

// the page decides its version once; a change of window size or motion setting across the line reloads it into the right one
for (const q of ["(prefers-reduced-motion: reduce)", "(max-width: 860px)"]) mq(q).addEventListener("change", () => location.reload());

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (x: number) => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const all = <T extends Element>(sel: string, el: ParentNode = document) => [...el.querySelectorAll<T>(sel)];

revealCards(wantScroll);
if (wantScroll) void mountTrail();
else root.classList.remove("is-scroll");

// ================================================================== the cards ==========================================

/** Cards come in once as you reach them (never with reduced motion); the person waves and their tools hop once on a phone. */
function revealCards(trail: boolean) {
  const cards = all<HTMLElement>(".card");
  const hops = all<HTMLElement>(".hop");
  if (!("IntersectionObserver" in window)) return;
  // typing only where someone can see it
  const typing = new IntersectionObserver((es) => { for (const e of es) (e.target as HTMLElement).classList.toggle("in-view", e.isIntersecting); }, { rootMargin: "60px 0px" });
  cards.forEach((c) => typing.observe(c));
  if (reduce) return;
  root.classList.add("can-animate");
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      el.classList.add("is-seen");
      io.unobserve(el);
    }
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.1 });
  cards.forEach((c) => io.observe(c));
  hops.forEach((h) => io.observe(h));
  if (trail) return;                                   // on wide screens the walking dog decides who waves
  const wave = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { (e.target as HTMLElement).classList.add("is-on"); wave.unobserve(e.target); }
  }, { threshold: 0.6 });
  cards.forEach((c) => wave.observe(c));
}

// ================================================================== the trail ==========================================

async function mountTrail() {
  const act = document.querySelector<HTMLElement>(".trail");
  if (!act) return;
  try {
    await import("../../vendor/scrollcraft/scrollcraft.js");
    if (!window.ScrollCraft) throw new Error("scrollcraft did not start");
    window.ScrollCraft.mount(document.body);
  } catch {
    root.classList.remove("is-scroll");                // the cards are complete on their own
    return;
  }
  new Trail(act).start();
}

interface Stop { el: HTMLElement; card: HTMLElement | null; side: -1 | 0 | 1; a: number; x: number; y: number; reward: "treat" | "pat" }

class Trail {
  private dog: HTMLElement;
  private line: SVGPathElement;
  private signal: HTMLElement;
  private stops: Stop[] = [];             // the cards in order, then the end of the walk
  private startPt = { x: 0, y: 0 };
  private top = 0;
  private vh = 0;
  private dw = 1;
  private dogW = 0;
  private dogH = 0;
  private dpx = 5;
  private p = -1;
  private x = NaN;
  private y = NaN;
  private dist = 0;
  private pose = "";
  private facing = "";
  private reward = "";
  private happy = "";
  private active = -2;
  private idle = 0;

  constructor(private act: HTMLElement) {
    this.dog = act.querySelector<HTMLElement>("[data-dog]")!;
    this.line = act.querySelector<SVGPathElement>("[data-line] path")!;
    this.signal = act.querySelector<HTMLElement>("[data-sc-act]")!;
  }

  start() {
    this.measure();
    // the engine writes --sc-p on the act whenever the reader's place changes; that is the whole trigger
    new MutationObserver(() => this.read()).observe(this.signal, { attributes: true, attributeFilter: ["style"] });
    new ResizeObserver(() => { this.measure(); this.apply(true); }).observe(this.act);
    void document.fonts?.ready.then(() => { this.measure(); this.apply(true); });
    this.dog.classList.add("is-ready");
    this.apply(true);
  }

  private read() {
    const p = clamp(parseFloat(this.signal.style.getPropertyValue("--sc-p")) || 0);
    if (p !== this.p) this.apply(false);
  }

  /** Where each card is (page position of its middle), where the dog sits beside it, and the trail that joins them. */
  private measure() {
    const box = this.act.getBoundingClientRect();
    this.top = box.top + scrollY;
    this.vh = innerHeight;
    this.dogW = this.dog.offsetWidth;
    this.dogH = this.dog.offsetHeight;
    this.dpx = this.dogW / 23 || 5;
    const cards = all<HTMLElement>(".stop[data-stop]", this.act);
    const left = cards.find((c) => c.dataset.side === "left")?.querySelector<HTMLElement>(".card");
    const right = cards.find((c) => c.dataset.side === "right")?.querySelector<HTMLElement>(".card");
    const l = left?.getBoundingClientRect(), r = right?.getBoundingClientRect();
    const cx = l && r ? (l.right + r.left) / 2 - box.left : box.width / 2;
    const gutter = l && r ? r.left - l.right : 120;
    const amp = clamp(gutter / 2 - this.dogW / 2 - 6, 4, 44);
    this.stops = cards.map((el, i) => {
      const card = el.querySelector<HTMLElement>(".card")!;
      const cr = card.getBoundingClientRect();
      const side = el.dataset.side === "left" ? -1 : 1;
      const a = cr.top + cr.height / 2 + scrollY - this.top;
      return { el, card, side, a, x: cx + side * amp, y: a + cr.height * 0.14, reward: i % 2 === 0 ? "treat" : "pat" } as Stop;
    });
    const gang = this.act.querySelector<HTMLElement>("[data-gang]");
    const slot = this.act.querySelector<HTMLElement>("[data-slot]");
    if (gang && slot) {
      const sr = slot.getBoundingClientRect();
      const gr = gang.getBoundingClientRect();
      this.stops.push({ el: gang, card: null, side: 0, a: gr.top + gr.height / 2 + scrollY - this.top, x: sr.left + sr.width / 2 - box.left, y: sr.bottom + scrollY - this.top, reward: "treat" });
    }
    const first = this.stops[0];
    this.startPt = { x: cx, y: first ? Math.max(30, first.y - 0.55 * this.vh) : 30 };
    // the dwell: how much scroll the dog stays put beside each card
    const gaps = this.stops.slice(1).map((s, i) => s.a - this.stops[i]!.a);
    this.dw = clamp(this.vh * 0.1, 30, 0.3 * Math.min(...gaps, 1e6));
    // the trail, drawn through the same points the dog walks
    const pts = [this.startPt, ...this.stops];
    let d = `M${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
    for (let j = 0; j < pts.length - 1; j++) {
      const a = pts[j]!, b = pts[j + 1]!;
      const h = (b.y - a.y) * 0.5;
      d += `C${a.x.toFixed(1)} ${(a.y + h).toFixed(1)} ${b.x.toFixed(1)} ${(b.y - h).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
    }
    this.line.setAttribute("d", d);
  }

  private bez(a: { x: number; y: number }, b: { x: number; y: number }, s: number) {
    const h = (b.y - a.y) * 0.5, u = 1 - s;
    const x = u * u * u * a.x + 3 * u * u * s * a.x + 3 * u * s * s * b.x + s * s * s * b.x;
    const y = u * u * u * a.y + 3 * u * u * s * (a.y + h) + 3 * u * s * s * (b.y - h) + s * s * s * b.y;
    return { x, y };
  }

  private apply(force: boolean) {
    this.p = clamp(parseFloat(this.signal.style.getPropertyValue("--sc-p")) || 0);
    if (!this.stops.length) return;
    // where the reader is looking: the middle of the window, in the act's own coordinates
    const a = scrollY + this.vh * 0.5 - this.top;
    const pts = [{ a: this.startPt.y - 1e6, ...this.startPt, dw: 0 }, ...this.stops.map((s) => ({ a: s.a, x: s.x, y: s.y, dw: this.dw }))];
    pts[0]!.a = this.startPt.y;                         // she waits at the start until the reader is level with it
    let pos = { x: pts[pts.length - 1]!.x, y: pts[pts.length - 1]!.y };
    let near = -1;
    for (let j = 0; j < pts.length - 1; j++) {
      const p0 = pts[j]!, p1 = pts[j + 1]!;
      const a0 = p0.a + p0.dw, a1 = p1.a - p1.dw;
      if (a < a0) { pos = { x: p0.x, y: p0.y }; break; }
      if (a <= a1) { pos = this.bez(p0, p1, ease((a - a0) / Math.max(1, a1 - a0))); break; }
    }
    // who she is sitting beside: the card the reader is level with (a little more room on the way out than the way in)
    let best = 1e9;
    this.stops.forEach((s, i) => { const dd = Math.abs(a - s.a); if (dd < best) { best = dd; near = i; } });
    const into = this.active === near ? 1.25 : 1;
    const beside = best < this.dw * into ? near : -1;

    if (force || pos.x !== this.x || pos.y !== this.y) this.dog.style.transform = `translate3d(${Math.round(pos.x - this.dogW / 2)}px,${Math.round(pos.y - this.dogH)}px,0)`;   // whole pixels keep the pixel art crisp
    const moved = (Number.isNaN(this.x) ? 0 : Math.hypot(pos.x - this.x, pos.y - this.y));
    const dx = Number.isNaN(this.x) ? 0 : pos.x - this.x;
    this.x = pos.x;
    this.y = pos.y;
    window.clearTimeout(this.idle);
    if (beside < 0 && moved > 0.05) {
      this.dist += moved;
      this.set("pose", Math.floor(this.dist / (5 * this.dpx)) % 2 ? "b" : "a");
      if (Math.abs(dx) > 0.05) this.set("facing", dx < 0 ? "left" : "right");
      this.idle = window.setTimeout(() => this.set("pose", "sit"), 220);
    } else {
      this.set("pose", "sit");
      if (beside >= 0) this.set("facing", this.stops[beside]!.side < 0 ? "left" : "right");
    }
    this.sit(beside, force);
  }

  /** The card the dog is beside wakes up (the person waves, the tools hop) and she gets a treat or a pat. */
  private sit(i: number, force: boolean) {
    if (!force && i === this.active) return;
    const was = this.stops[this.active];
    was?.el.classList.remove("is-on");
    was?.card?.classList.remove("is-on");
    this.active = i;
    const s = this.stops[i];
    this.setData("happy", s ? "1" : "0");
    if (!s) return;
    s.el.classList.add("is-on");
    s.card?.classList.add("is-on");
    this.setData("reward", s.reward);
    if (s.card) { this.dog.style.setProperty("--skin", s.card.style.getPropertyValue("--skin")); this.dog.style.setProperty("--shirt", s.card.style.getPropertyValue("--shirt")); }
  }

  private set(k: "pose" | "facing", v: string) { if (this[k] !== v) { this[k] = v; this.dog.dataset[k] = v; } }
  private setData(k: "reward" | "happy", v: string) { if (this[k] !== v) { this[k] = v; this.dog.dataset[k] = v; } }
}

// "Meet your team": the motion of the page. Two modes, chosen once (the inline script in index.html already set html.is-scroll):
//   scroll  wide screen, motion welcome. The vendored scrollcraft engine pins the walk and publishes the reader's place in it as
//           --sc-p (0..1) on the act. This file reads that one number (through a MutationObserver on the act: no scroll listener,
//           no loop of its own) and sets the camera, the dog, and which person is speaking. Pinning and scrubbing are the
//           engine's sticky stage; the page scrolls natively and nothing here touches the scroll.
//   cards   a phone, a tablet, reduced motion, data saver, or the engine failing. An ordinary page; the cards and the dog between
//           them come in once as you reach them (never with reduced motion), and the page is complete without JavaScript.
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
const smooth = (x: number) => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const all = <T extends Element>(sel: string, el: ParentNode = document) => [...el.querySelectorAll<T>(sel)];

if (wantScroll) void mountWalk();
else mountCards();

// ================================================================== cards ==============================================

function mountCards() {
  root.classList.remove("is-scroll");
  if (reduce) return;                                  // static: every card and the dog are simply there
  root.classList.add("can-animate");
  const targets = all<HTMLElement>(".card, .hop");
  if (!("IntersectionObserver" in window)) { targets.forEach((t) => t.classList.add("is-seen")); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { (e.target as HTMLElement).classList.add("is-seen"); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 });
  targets.forEach((t) => io.observe(t));
}

// ================================================================== the walk ===========================================

// where in each person's stretch of the walk (0..1) each thing happens
const WALK = 0.34;       // the camera moves to the desk (the first person: the dog comes in at the door)
const BUBBLE = 0.40;     // the person turns, waves and speaks
const TOOLS = 0.50;      // their tools pop in
const TREAT = 0.74;      // the treat is thrown
const LEAVE = 0.95;      // the bubble closes, the dog is ready to go on
const FINALE = 1.15;     // the game room: the other two dogs, the last word
// where things sit on screen, as a fraction of the stage's width: the person being introduced, and the dog
const AGENT_AT = 0.6;
const DOG_AT = 0.34;
// in office pixels (the same numbers as team.css): the top of the dog's box, where the treat starts and where her mouth is
const DOG_TOP = 109, TREAT_Y = 60, MOUTH_Y = 109 + 9;

interface Beat { id: string; agent: HTMLElement; who: HTMLElement[]; cx: number }

async function mountWalk() {
  const act = document.querySelector<HTMLElement>(".walk");
  if (!act) return;
  try {
    await import("../../vendor/scrollcraft/scrollcraft.js");
    if (!window.ScrollCraft) throw new Error("scrollcraft did not start");
    window.ScrollCraft.mount(document.body);
  } catch {
    mountCards();                                      // the cards are complete on their own
    return;
  }
  new Walk(act).start();
}

class Walk {
  private cam: HTMLElement;
  private rail: HTMLElement;
  private dog: HTMLElement;
  private bar: HTMLElement;
  private beats: Beat[] = [];
  private pets: HTMLElement[];
  private pieces: HTMLElement[];
  private T: number[] = [];            // the camera's place (rail pixels) for each person, then the game room
  private W = 0;
  private px = 5;
  private dogW = 0;
  private startLeft = 0;
  private baseLeft = 0;
  private p = -1;
  private camX = NaN;
  private dogX = NaN;
  private dist = 0;
  private pose = "";
  private facing = "";
  private shown = { i: -2, mask: -1 };
  private idle = 0;

  constructor(private act: HTMLElement) {
    this.cam = act.querySelector<HTMLElement>("[data-cam]")!;
    this.rail = act.querySelector<HTMLElement>("[data-rail]")!;
    this.dog = act.querySelector<HTMLElement>("[data-dog]")!;
    this.bar = act.querySelector<HTMLElement>("[data-bar]")!;
    this.pets = all<HTMLElement>(".pet", act);
    this.pieces = all<HTMLElement>(".piece", act);
    this.beats = all<HTMLElement>(".agent", act).map((agent) => {
      const id = agent.dataset.agent!;
      return { id, agent, who: all<HTMLElement>(`.who[data-for="${id}"]`, act), cx: 0 };
    });
  }

  start() {
    this.measure();
    // the engine writes --sc-p on the act whenever the reader's place changes; that is the whole input
    new MutationObserver(() => this.read()).observe(this.act, { attributes: true, attributeFilter: ["style"] });
    new ResizeObserver(() => { this.measure(); this.apply(this.p < 0 ? 0 : this.p, true); }).observe(this.cam);
    void document.fonts?.ready.then(() => { this.measure(); this.apply(this.p < 0 ? 0 : this.p, true); });
    // typing only where someone can see it
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => { for (const e of es) (e.target as HTMLElement).classList.toggle("is-seen", e.isIntersecting); }, { rootMargin: "0px 120px" });
      this.pieces.forEach((pc) => io.observe(pc));
    }
    this.read(true);
  }

  private read(force = false) {
    const p = clamp(parseFloat(this.act.style.getPropertyValue("--sc-p")) || 0);
    if (force || p !== this.p) this.apply(p);
  }

  /** Where everything stands: the camera for each person, the dog's places, the treat's flight. In pixels of this window. */
  private measure() {
    this.W = this.cam.clientWidth;
    const railLeft = this.rail.getBoundingClientRect().left;
    const centre = (el: Element) => { const r = el.getBoundingClientRect(); return r.left - railLeft + r.width / 2; };
    this.beats.forEach((b) => { b.cx = centre(b.who[0]!); });
    const first = this.beats[0]?.who[0];
    this.px = first ? first.offsetWidth / 16 || 5 : 5;
    this.dogW = this.dog.offsetWidth;
    this.T = this.beats.map((b) => b.cx - this.W * AGENT_AT);
    const jj = this.act.querySelector(".pet--jj");
    this.T.push(jj ? centre(jj) - this.W * 0.66 : (this.T[this.T.length - 1] ?? 0));
    this.baseLeft = this.W * DOG_AT - this.dogW / 2;
    const door = this.act.querySelector(".piece--entrance");
    const doorX = door ? centre(door) - (door as HTMLElement).offsetWidth / 2 + 6 * this.px : 0;
    this.startLeft = Math.max(-this.dogW, doorX - (this.T[0] ?? 0) - this.dogW / 2);
    // the treat's flight from the desk to the dog's mouth (the same for every person, because every desk stops in the same place)
    const gx = this.baseLeft + this.dogW * 0.9 - this.W * AGENT_AT;
    const gy = MOUTH_Y * this.px - TREAT_Y * this.px;
    this.act.style.setProperty("--gx", `${gx.toFixed(1)}px`);
    this.act.style.setProperty("--gy", `${gy.toFixed(1)}px`);
    void DOG_TOP;
  }

  private apply(p: number, force = false) {
    const N = this.beats.length;
    const total = N + FINALE;
    const pos = clamp(p, 0, 1) * total;
    const i = Math.min(Math.floor(pos), N);
    const u = pos - i;
    const dir = p - this.p;
    this.p = p;

    // the camera: it settles on each desk, and moves between them in the first third of each person's stretch
    const k = i === 0 ? 1 : smooth(u / WALK);
    const camX = i === 0 ? (this.T[0] ?? 0) : lerp(this.T[i - 1] ?? 0, this.T[i] ?? 0, k);
    // the dog: she comes in through the door for the first person, stands where she is for the rest, and moves up for the finale
    const dogX = i === 0 ? lerp(this.startLeft, this.baseLeft, smooth(u / (WALK * 0.9)))
      : i === N ? lerp(this.baseLeft, this.W * 0.47 - this.dogW / 2, smooth(u / WALK)) : this.baseLeft;

    if (force || camX !== this.camX) this.rail.style.transform = `translate3d(${(-camX).toFixed(1)}px,0,0)`;
    if (force || dogX !== this.dogX) this.dog.style.transform = `translate3d(${dogX.toFixed(1)}px,0,0)`;
    this.bar.style.transform = `scaleX(${clamp(p).toFixed(4)})`;

    // walking: her frame follows the distance the office has slid, and she sits when it stops
    const moved = (Number.isNaN(this.camX) ? 0 : Math.abs(camX - this.camX)) + (Number.isNaN(this.dogX) ? 0 : Math.abs(dogX - this.dogX));
    this.camX = camX;
    this.dogX = dogX;
    window.clearTimeout(this.idle);
    if (moved > 0.01) {
      this.dist += moved;
      this.setPose(Math.floor(this.dist / (7 * this.px)) % 2 ? "b" : "a");
      if (Math.abs(dir) > 1e-5) this.setFacing(dir < 0 ? "left" : "right");
      this.idle = window.setTimeout(() => this.setPose("sit"), 220);
    } else this.setPose("sit");

    this.speak(i, u, force);
  }

  private setPose(v: string) { if (v !== this.pose) { this.pose = v; this.dog.dataset.pose = v; } }
  private setFacing(v: string) { if (v !== this.facing) { this.facing = v; this.dog.dataset.facing = v; } }

  /** Who is speaking, and how far along they are (bubble, tools, treat). Touches the page only when something changes. */
  private speak(i: number, u: number, force: boolean) {
    const N = this.beats.length;
    let mask = 0;
    if (i < N) {
      if (u >= BUBBLE && u < LEAVE) mask |= 1;
      if (u >= TOOLS && u < LEAVE) mask |= 2;
      if (u >= TREAT && u < LEAVE) mask |= 4;
    } else {
      if (u >= 0.4) mask |= 8;       // JJ and Zoe sit up
      if (u >= 0.55) mask |= 16;     // hearts all round
      if (u >= 0.7) mask |= 32;      // Fluffy has the last word
    }
    if (!force && this.shown.i === i && this.shown.mask === mask) return;
    const before = this.shown.i;
    this.shown = { i, mask };
    if (before !== i) this.beats.forEach((b, n) => { if (n !== i) this.set(b, 0); });
    if (i < N) this.set(this.beats[i]!, mask);
    for (const pet of this.pets) {
      pet.classList.toggle("is-up", (mask & 8) !== 0);
      pet.classList.toggle("is-happy", (mask & 16) !== 0);
      pet.setAttribute("aria-label", `${pet.dataset.pet === "jj" ? "JJ the chow chow" : "Zoe the poodle"}, ${(mask & 8) !== 0 ? "awake" : "asleep"}`);
    }
    this.dog.dataset.happy = mask & (4 | 16) ? "1" : "0";
    this.dog.dataset.says = mask & 32 ? "1" : "0";
  }

  private set(b: Beat, mask: number) {
    const on = (mask & 1) !== 0;
    b.agent.classList.toggle("is-on", on);
    b.agent.classList.toggle("is-tools", (mask & 2) !== 0);
    b.agent.classList.toggle("is-treat", (mask & 4) !== 0);
    b.who.forEach((w) => w.classList.toggle("is-on", on));
  }
}

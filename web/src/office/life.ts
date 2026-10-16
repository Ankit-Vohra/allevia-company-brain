// The office's idle life: a small client-side simulation, seeded per session, with no network and no model calls.
// Idle staff walk the open floor (grid pathfinding) to the cafeteria for coffee or tea, to the game room to play
// ping-pong or console together, chat in pairs, stretch, water a plant, or doze off. One person is always a little
// sleepy, and more of them are at night. When a request starts, the people in its plan walk briskly back to their desks
// while everyone else carries on. Dogs carry the documents between desks and get a treat for each delivery; the cats nap
// and wander. Nothing here draws; figures.ts reads the state.
import { AGENTS } from "@shared/roster";
import type { Lighting } from "../lib/daylight";
import type { Activity, Facing, OfficeLayout, Pt, Spot } from "./layout";
import { along, pathLength } from "./path";
import { PETS, type PetId } from "./pets";

export type Kind = Activity | "stretch";
export type Prop = "mug" | "tea" | "snack" | "paddle" | "pad" | "can" | "none";
export type Mode = "desk" | "rise" | "settle" | "walk" | "act";

export const IDLE_SPEED = 21;   // px/s
export const BRISK_SPEED = 42;

const DUR: Record<Kind, [number, number]> = {
  coffee: [18, 28], tea: [18, 28], fridge: [8, 14], table: [26, 44], pingpong: [32, 56], console: [32, 56], boardgame: [30, 50],
  nap: [40, 70], plant: [8, 12], window: [12, 20], chat: [20, 36], stretch: [5, 8],
};

const LINES: Partial<Record<Kind, string[]>> = {
  coffee: ["☕", "Need my coffee first", "Second cup today", "That smells good"],
  tea: ["🍵", "Chai time", "Just one biscuit", "Ginger today"],
  fridge: ["Anyone seen the yoghurt?", "🍎", "Just a snack"],
  table: ["😄", "How was your weekend?", "Lunch later?", "☀️"],
  chat: ["😄", "Did you hear that?", "Good morning!", "Coffee after this?", "👍"],
  pingpong: ["🏓", "Nice shot!", "Match point", "Again?", "Ha, got you"],
  console: ["🎮", "No way!", "One more round", "You're cheating", "🏁"],
  boardgame: ["🎲", "Your move", "Hmm, tricky", "I'll take that"],
  plant: ["🌱", "Grow, little one", "Thirsty plant"],
  window: ["🌤️", "Lovely light", "Look at that sky"],
  stretch: ["Ahh, that's better", "😌"],
};

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Act {
  kind: Kind;
  until: number;
  spot?: Spot;
  partner?: string;
  seated: boolean;
  face: Facing;
  prop: Prop;
  nextSay: number;
  chain?: Kind;
  started: number;
}

export interface Person {
  id: string;
  mode: Mode;
  x: number; y: number;            // feet
  dir: "front" | "back" | "left" | "right";
  frame: 0 | 1 | 2;
  path: Pt[]; d: number; len: number; speed: number;
  then?: () => void;
  act?: Act;
  nextAt: number;
  sleepy: boolean;
  blend: number;                   // 0..1 through a rise or a settle
  blendFrom: Pt; blendTo: Pt;
  blendStart: number;
  jumpAt: number;
  happyUntil: number;
  brisk: boolean;
  away: boolean;                   // not at the desk (walking or doing something elsewhere)
}

export interface Pet {
  id: PetId;
  kind: "dog" | "cat";
  x: number; y: number;
  facing: "left" | "right";
  mode: "sleep" | "idle" | "walk" | "sit" | "carry" | "treat";
  frame: number;
  path: Pt[]; d: number; len: number; speed: number;
  then?: () => void;
  nextAt: number;
  job?: Job;
  carrying: boolean;
  until: number;
  home: Pt;
  panting: boolean;
}

export interface Job { id: number; from: string; to: string; kind: "handoff" | "finding"; stage: "toFrom" | "pickup" | "toTo"; at: number }

export interface FxHeart { kind: "heart"; x: number; y: number; t0: number; dur: number }
export interface FxTreat { kind: "treat"; x: number; y: number; toX: number; toY: number; t0: number; dur: number }
export type Fx = FxHeart | FxTreat;

export interface Speech { agent: string; text: string; ms: number }

/** The morning stand-up: who is in it, where each stands, what is said, and who gets a document afterwards. */
export interface Meeting {
  attendees: string[];
  lines: Speech[];
  handoffs: string[];              // the people Meera hands a brief to (a dog carries each)
  phase: "gather" | "talk";
  t0: number;
  said: number;
  nextAt: number;
}

const CHIEF_ID = "chief-of-staff";

export interface LifeEnv {
  busy: ReadonlySet<string>;
  off: ReadonlySet<string>;
  lighting: Lighting;
}

const COUNTS: Record<string, number> = {};
const dayKey = () => new Date().toISOString().slice(0, 10);
export const deliveriesToday = (id: PetId) => COUNTS[`${dayKey()}|${id}`] ?? 0;
const bump = (id: PetId) => { const k = `${dayKey()}|${id}`; COUNTS[k] = (COUNTS[k] ?? 0) + 1; };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const dirOf = (dx: number, dy: number): Person["dir"] => (Math.abs(dx) > Math.abs(dy) * 0.8 ? (dx < 0 ? "left" : "right") : dy < 0 ? "back" : "front");
const FACE_DIR: Record<Facing, Person["dir"]> = { front: "front", back: "back", left: "left", right: "right" };

export class Life {
  t = 0;
  people = new Map<string, Person>();
  pets: Pet[] = [];
  fx: Fx[] = [];
  arrivals: Job[] = [];
  speech: Speech[] = [];
  private occupied = new Map<string, string>();
  private jobs: Job[] = [];
  private jobSeq = 1;
  private rng: () => number;
  private order: string[];
  private lastSleepyCheck = -1e9;
  private lastBusy = new Set<string>();
  private speaking = new Map<string, number>();
  meeting: Meeting | null = null;

  constructor(readonly L: OfficeLayout, seed: number, readonly reduced: boolean) {
    this.rng = mulberry32(seed);
    const ids = AGENTS.map((a) => a.id);
    // a seeded shuffle decides who is sleepiest first
    this.order = [...ids].sort(() => this.rng() - 0.5);
    for (const id of ids) {
      const d = L.desks[id];
      if (!d) continue;
      this.people.set(id, {
        id, mode: "desk", x: d.seat.x, y: d.seat.y, dir: "front", frame: 0, path: [], d: 0, len: 0, speed: IDLE_SPEED,
        nextAt: 4000 + this.rng() * 30000, sleepy: false, blend: 0, blendFrom: d.seat, blendTo: d.side, blendStart: 0,
        jumpAt: -1e9, happyUntil: 0, brisk: false, away: false,
      });
    }
    this.pets = PETS.map((def, i) => {
      const home = def.kind === "dog" ? L.petHomes.dogs[i % L.petHomes.dogs.length]! : L.petHomes.cats[(i - 3) % L.petHomes.cats.length]!;
      return {
        id: def.id, kind: def.kind, x: home.x, y: home.y, facing: this.rng() > 0.5 ? "left" : "right", mode: "sleep" as const, frame: 0,
        path: [], d: 0, len: 0, speed: 20, nextAt: 8000 + this.rng() * 40000, carrying: false, until: 0, home, panting: false,
      };
    });
  }

  private rand(a: number, b: number) { return a + this.rng() * (b - a); }
  private pick<T>(xs: T[]): T { return xs[Math.floor(this.rng() * xs.length)]!; }

  /** First frame: put some people into the cafeteria and the game room at once, so the office never opens empty. */
  warmUp(env: LifeEnv) {
    this.refreshSleepy(env, true);
    const idle = [...this.people.values()].filter((p) => !env.busy.has(p.id) && !env.off.has(p.id) && !p.sleepy);
    let n = Math.min(idle.length - 1, Math.max(4, Math.round(idle.length * 0.5)));
    const wants: Kind[] = ["pingpong", "coffee", "tea", "console", "chat", "plant", "table"];
    for (const kind of wants) {
      if (n <= 0 || !idle.length) break;
      const used = this.startKind(kind, idle[0]!, env, true);
      if (used) { n -= used.n; for (const u of used.people) { const i = idle.findIndex((q) => q.id === u); if (i >= 0) idle.splice(i, 1); } }
    }
    // pets settle in their usual places
    for (const p of this.pets) {
      const mode = p.kind === "dog" && this.rng() > 0.5 ? "sit" : "sleep";
      p.mode = mode;
      p.nextAt = this.rand(6000, 30000);
    }
    this.t = 0;
  }

  update(dt: number, env: LifeEnv) {
    dt = Math.min(dt, 100);
    this.t += dt;
    const t = this.t;
    this.fx = this.fx.filter((f) => t - f.t0 < f.dur);

    // who is busy: back to the desk, briskly; who stopped being busy: free again after a pause
    for (const p of this.people.values()) {
      const busy = env.busy.has(p.id) && !env.off.has(p.id);
      const was = this.lastBusy.has(p.id);
      if (busy && p.mode !== "desk" && !p.brisk) this.sendHome(p, true);
      if (!busy && was) p.nextAt = t + this.rand(8000, 20000);
    }
    this.lastBusy = new Set([...env.busy]);

    if (this.meeting) this.stepMeeting(env);
    if (!this.reduced) {
      if (t - this.lastSleepyCheck > 4000) { this.lastSleepyCheck = t; this.refreshSleepy(env); }
      for (const p of this.people.values()) this.stepPerson(p, dt, env);
      this.stepPets(dt, env);
      this.assignJobs();
    }
  }

  // ------------------------------------------------------------------ people

  private refreshSleepy(env: LifeEnv, first = false) {
    const free = this.order.filter((id) => !env.busy.has(id) && !env.off.has(id) && (id !== "chief-of-staff" || env.lighting.sleepy > 0.6));
    // one sleepy soul always (when there are enough people to spare), more as the evening goes on
    const want = free.length >= 3 ? Math.min(free.length - 1, Math.max(1, Math.round(env.lighting.sleepy * free.length * 0.55))) : 0;
    const set = new Set(free.slice(0, want));
    for (const p of this.people.values()) {
      const now = set.has(p.id);
      if (now === p.sleepy) continue;
      p.sleepy = now;
      if (now) {
        // some doze at their desk, some find a beanbag
        if (!first && p.mode === "desk" && this.rng() < 0.35) this.startKind("nap", p, env, false);
      } else if (p.mode === "desk" && !first) {
        p.nextAt = this.t + 500;
        this.startKind("stretch", p, env, false);
      } else if (p.act?.kind === "nap") p.act.until = this.t + 1500;
    }
  }

  private awayCount() { let n = 0; for (const p of this.people.values()) if (p.mode !== "desk") n++; return n; }

  private stepPerson(p: Person, dt: number, env: LifeEnv) {
    const t = this.t;
    const desk = this.L.desks[p.id]!;
    if (env.off.has(p.id)) {
      if (p.mode !== "desk") this.sendHome(p, true);
    }
    switch (p.mode) {
      case "desk": {
        p.x = desk.seat.x; p.y = desk.seat.y;
        if (env.busy.has(p.id) || env.off.has(p.id)) break;
        if (t >= p.nextAt) this.decide(p, env);
        break;
      }
      case "rise":
      case "settle": {
        const u = Math.min(1, (t - p.blendStart) / 320);
        p.x = p.blendFrom.x + (p.blendTo.x - p.blendFrom.x) * u;
        p.y = p.blendFrom.y + (p.blendTo.y - p.blendFrom.y) * u;
        p.dir = "front";
        if (u >= 1) {
          if (p.mode === "settle") {
            p.mode = "desk"; p.away = false; p.brisk = false;
            p.nextAt = t + this.rand(20000, 60000);
          } else {
            p.mode = "walk";
            p.x = p.path[0]!.x; p.y = p.path[0]!.y;
          }
        }
        break;
      }
      case "walk": {
        p.d += (p.speed * dt) / 1000;
        const pos = along(p.path, p.d);
        p.x = pos.x; p.y = pos.y;
        if (Math.hypot(pos.dx, pos.dy) > 0.01) p.dir = dirOf(pos.dx, pos.dy);
        p.frame = (Math.floor(t / (p.brisk ? 110 : 190)) % 2 === 0 ? 1 : 2) as 1 | 2;
        if (p.d >= p.len) { p.frame = 0; const f = p.then; p.then = undefined; f?.(); }
        break;
      }
      case "act": {
        const a = p.act!;
        // a partner who left cuts the game short
        if (a.partner) {
          const q = this.people.get(a.partner);
          if (!q || !q.act || q.act.partner !== p.id) a.until = Math.min(a.until, t + 1500);
        }
        if (t >= a.nextSay && a.nextSay > 0) {
          const lines = LINES[a.kind];
          if (lines && this.speech.length < 2 && !this.speaking.has(p.id)) {
            this.speech.push({ agent: p.id, text: this.pick(lines), ms: 3600 });
            this.speaking.set(p.id, t + 3600);
          }
          a.nextSay = t + this.rand(7000, 13000);
        }
        if (t >= a.until) this.endAct(p, env);
        break;
      }
    }
    // chatter expires
    const until = this.speaking.get(p.id);
    if (until !== undefined && t > until) this.speaking.delete(p.id);
  }

  /** Is anyone going to be at the table / spot already? */
  private free(spot: Spot) { return !this.occupied.has(spot.id); }

  private spotsOf(kind: Kind): Spot[] { return this.L.spots.filter((s) => s.activity === kind); }

  private groups(kind: Kind): Spot[][] {
    const spots = this.spotsOf(kind);
    const by = new Map<string, Spot[]>();
    for (const s of spots) { const k = s.group ?? s.id; by.set(k, [...(by.get(k) ?? []), s]); }
    return [...by.values()];
  }

  private decide(p: Person, env: LifeEnv) {
    const t = this.t;
    const idleCount = [...this.people.values()].filter((q) => !env.busy.has(q.id) && !env.off.has(q.id)).length;
    const limit = Math.max(2, Math.floor(idleCount * 0.45));
    p.nextAt = t + this.rand(20000, 60000);
    if (this.awayCount() >= limit) return;
    // the office is quieter late in the evening
    if (this.rng() < env.lighting.sleepy * 0.55) return;
    if (p.sleepy) return;
    const hour = env.lighting.lamps; // 0 by day .. 1 at night
    const w: [Kind, number][] = [
      ["coffee", 3 - hour], ["tea", 2], ["fridge", 1], ["plant", 1], ["stretch", 1.6], ["window", 1],
      ["pingpong", 2.4], ["console", 2], ["boardgame", 1.2], ["chat", 2.6], ["table", 1.5],
    ];
    const total = w.reduce((s, [, x]) => s + x, 0);
    let r = this.rng() * total;
    let kind: Kind = "coffee";
    for (const [k, x] of w) { r -= x; if (r <= 0) { kind = k; break; } }
    if (!this.startKind(kind, p, env, false)) this.startKind("stretch", p, env, false);
  }

  private partnerFor(p: Person, env: LifeEnv): Person | undefined {
    const options = [...this.people.values()].filter((q) => q.id !== p.id && q.mode === "desk" && !env.busy.has(q.id) && !env.off.has(q.id) && !q.sleepy);
    return options.length ? this.pick(options) : undefined;
  }

  /** Start an activity for p (and a partner for the ones that take two). `instant` skips the walk. Returns who took part. */
  private startKind(kind: Kind, p: Person, env: LifeEnv, instant: boolean): { n: number; people: string[] } | null {
    const pairKinds: Kind[] = ["pingpong", "console", "boardgame", "chat", "table"];
    const prop: Prop = kind === "coffee" ? "mug" : kind === "tea" ? "tea" : kind === "fridge" ? "snack" : kind === "pingpong" ? "paddle" : kind === "console" ? "pad" : kind === "plant" ? "can" : "none";
    const dur = this.rand(...DUR[kind]) * 1000;

    if (kind === "stretch") {
      const d = this.L.desks[p.id]!;
      this.beginWalk(p, p.mode === "desk" ? d.side : { x: p.x, y: p.y }, () => {
        this.setAct(p, { kind, until: this.t + dur, seated: false, face: "front", prop: "none", nextSay: this.t + 800, started: this.t, chain: undefined }, { x: d.side.x, y: d.side.y }, "front");
      }, IDLE_SPEED, instant, true);
      return { n: 1, people: [p.id] };
    }

    if (pairKinds.includes(kind) && kind !== "table") {
      const q = this.partnerFor(p, env);
      const groups = this.groups(kind).filter((g) => g.every((s) => this.free(s)) && g.length >= 2);
      if (!q || !groups.length) return null;
      const g = this.pick(groups);
      const [a, b] = this.rng() > 0.5 ? [g[0]!, g[1]!] : [g[1]!, g[0]!];
      const eta = Math.max(this.eta(p, a.at), this.eta(q, b.at));
      const until = this.t + eta + dur;
      this.occupied.set(a.id, p.id); this.occupied.set(b.id, q.id);
      const pa = prop;
      this.beginWalk(p, a.at, () => this.setAct(p, { kind, until, spot: a, partner: q.id, seated: a.pose === "sit", face: a.face, prop: pa, nextSay: this.t + this.rand(2000, 5000), started: this.t }, a.at, a.face), IDLE_SPEED, instant, false);
      this.beginWalk(q, b.at, () => this.setAct(q, { kind, until, spot: b, partner: p.id, seated: b.pose === "sit", face: b.face, prop: pa, nextSay: this.t + this.rand(6000, 9000), started: this.t }, b.at, b.face), IDLE_SPEED, instant, false);
      return { n: 2, people: [p.id, q.id] };
    }

    // solo (or the table, taken alone or with a friend)
    const spots = this.spotsOf(kind).filter((s) => this.free(s));
    if (!spots.length) return null;
    let spot = this.pick(spots);
    if (kind === "plant") spot = [...spots].sort((a, b) => dist(a.at, p.x ? { x: p.x, y: p.y } : this.L.desks[p.id]!.side) - dist(b.at, { x: p.x, y: p.y })).slice(0, 4)[Math.floor(this.rng() * Math.min(4, spots.length))]!;
    if (kind === "table") {
      const g = this.groups("table").filter((gg) => gg.every((s) => this.free(s)));
      const q = this.partnerFor(p, env);
      if (g.length && q && this.rng() < 0.6) {
        const grp = this.pick(g);
        const [a, b] = [grp[0]!, grp[1]!];
        const until = this.t + Math.max(this.eta(p, a.at), this.eta(q, b.at)) + dur;
        this.occupied.set(a.id, p.id); this.occupied.set(b.id, q.id);
        this.beginWalk(p, a.at, () => this.setAct(p, { kind, until, spot: a, partner: q.id, seated: true, face: a.face, prop: "mug", nextSay: this.t + this.rand(2000, 5000), started: this.t }, a.at, a.face), IDLE_SPEED, instant, false);
        this.beginWalk(q, b.at, () => this.setAct(q, { kind, until, spot: b, partner: p.id, seated: true, face: b.face, prop: "mug", nextSay: this.t + this.rand(6000, 9000), started: this.t }, b.at, b.face), IDLE_SPEED, instant, false);
        return { n: 2, people: [p.id, q.id] };
      }
    }
    this.occupied.set(spot.id, p.id);
    const chain: Kind | undefined = (kind === "coffee" || kind === "tea") && this.rng() < 0.4 ? "table" : undefined;
    this.beginWalk(p, spot.at, () => this.setAct(p, { kind, until: this.t + dur, spot, seated: spot.pose === "sit", face: spot.face, prop, nextSay: this.t + this.rand(5000, 9000), chain, started: this.t }, spot.at, spot.face), IDLE_SPEED, instant, false);
    return { n: 1, people: [p.id] };
  }

  private eta(p: Person, to: Pt) {
    const from = p.mode === "desk" ? this.L.desks[p.id]!.side : { x: p.x, y: p.y };
    return (pathLength(this.L.walk(from, to)) / IDLE_SPEED) * 1000 + (p.mode === "desk" ? 400 : 0);
  }

  private setAct(p: Person, a: Act, at: Pt, face: Facing) {
    p.mode = "act"; p.act = a; p.x = at.x; p.y = at.y; p.dir = FACE_DIR[face]; p.frame = 0; p.away = true;
  }

  /** Walk from wherever p is (rising from the chair first when at the desk) to `to`, then run `then`. */
  private beginWalk(p: Person, to: Pt, then: () => void, speed: number, instant: boolean, _stay: boolean) {
    void _stay;
    p.away = true;
    if (instant) {
      p.mode = "walk"; p.path = [to, to]; p.d = 0; p.len = 0; p.x = to.x; p.y = to.y;
      p.then = then; p.speed = speed;
      then();
      return;
    }
    const desk = this.L.desks[p.id]!;
    const from = p.mode === "desk" ? desk.side : { x: p.x, y: p.y };
    p.path = this.L.walk(from, to);
    p.len = pathLength(p.path); p.d = 0; p.speed = speed; p.then = then;
    if (p.mode === "desk") {
      p.mode = "rise"; p.blendFrom = { ...desk.seat }; p.blendTo = { ...desk.side }; p.blendStart = this.t;
    } else p.mode = "walk";
  }

  private endAct(p: Person, env: LifeEnv) {
    const a = p.act!;
    if (a.spot) this.occupied.delete(a.spot.id);
    p.act = undefined;
    if (a.chain && !env.busy.has(p.id)) {
      const tables = this.spotsOf(a.chain).filter((s) => this.free(s));
      if (tables.length) {
        const s = this.pick(tables);
        this.occupied.set(s.id, p.id);
        this.beginWalk(p, s.at, () => this.setAct(p, { kind: "table", until: this.t + this.rand(18000, 30000), spot: s, seated: true, face: s.face, prop: "mug", nextSay: this.t + this.rand(4000, 8000), started: this.t }, s.at, s.face), IDLE_SPEED, false, false);
        return;
      }
    }
    this.sendHome(p, false);
  }

  private sendHome(p: Person, brisk: boolean) {
    if (p.act?.spot) this.occupied.delete(p.act.spot.id);
    p.act = undefined;
    const desk = this.L.desks[p.id]!;
    p.brisk = brisk;
    const from = { x: p.x, y: p.y };
    p.path = this.L.walk(p.mode === "desk" ? desk.side : from, desk.side);
    p.len = pathLength(p.path); p.d = 0; p.speed = brisk ? BRISK_SPEED : IDLE_SPEED;
    p.mode = "walk";
    p.then = () => {
      p.mode = "settle"; p.blendFrom = { ...desk.side }; p.blendTo = { ...desk.seat }; p.blendStart = this.t; p.x = desk.side.x; p.y = desk.side.y;
    };
  }

  // ------------------------------------------------------------------ the morning stand-up

  /**
   * The team stand-up: Meera and the people who got work walk to the board table in the game room (or the nearest free
   * seats), Meera says what the team noticed, each person says what they will draft, then everyone goes back to their desk
   * and a dog carries Meera's brief to each of them. With reduced motion nobody walks: the briefs are only counted.
   */
  standup(attendees: string[], lines: Speech[], handoffs: string[]) {
    const who = attendees.filter((id) => this.people.has(id) && this.L.desks[id]);
    if (this.reduced || !who.length) {
      for (const h of handoffs) this.deliver(CHIEF_ID, h, "handoff", false);
      for (const l of lines.slice(0, 2)) this.speech.push(l);
      return;
    }
    if (this.meeting) this.endMeeting(false);
    const table = this.L.rooms.flatMap((r) => r.floor).find((f) => f.kind === "board-table")?.rect;
    const desk = this.L.desks[CHIEF_ID] ?? this.L.desks[who[0]!]!;
    const center: Pt = table ? { x: table.x + table.w / 2, y: table.y + table.h / 2 } : desk.side;
    const kinds: Activity[] = ["boardgame", "table", "chat", "coffee", "tea", "console", "window", "plant"];
    const free = this.L.spots.filter((sp) => kinds.includes(sp.activity) && this.free(sp)).sort((a, b) => dist(a.at, center) - dist(b.at, center) || a.id.localeCompare(b.id));
    who.forEach((id, i) => {
      const p = this.people.get(id)!;
      if (p.act?.spot) this.occupied.delete(p.act.spot.id);
      p.act = undefined;
      const spot = free[i];
      const to = spot?.at ?? { x: center.x + (i - who.length / 2) * 12, y: center.y + 14 };
      if (spot) this.occupied.set(spot.id, id);
      this.beginWalk(p, to, () => this.setAct(p, {
        kind: "chat", until: this.t + 120_000, ...(spot ? { spot } : {}), seated: spot?.pose === "sit", face: spot?.face ?? "back", prop: "none", nextSay: 0, started: this.t,
      }, to, spot?.face ?? "back"), BRISK_SPEED, false, false);
    });
    this.meeting = { attendees: who, lines, handoffs, phase: "gather", t0: this.t, said: 0, nextAt: 0 };
  }

  private stepMeeting(env: LifeEnv) {
    const m = this.meeting!;
    const t = this.t;
    if (m.phase === "gather") {
      const there = m.attendees.every((id) => { const p = this.people.get(id); return !p || env.off.has(id) || (p.mode === "act" && p.act?.kind === "chat"); });
      if (there || t - m.t0 > 25_000) { m.phase = "talk"; m.nextAt = t + 600; }
      return;
    }
    if (t < m.nextAt) return;
    const line = m.lines[m.said];
    if (line) {
      this.speech.push(line);
      this.speaking.set(line.agent, t + line.ms);
      m.said++;
      m.nextAt = t + Math.max(1800, line.ms * 0.85);
      return;
    }
    this.endMeeting(true);
  }

  private endMeeting(deliver: boolean) {
    const m = this.meeting!;
    this.meeting = null;
    for (const id of m.attendees) {
      const p = this.people.get(id);
      if (p && p.mode !== "desk") this.sendHome(p, true);
    }
    if (deliver) for (const h of m.handoffs) this.deliver(CHIEF_ID, h, "handoff", true);
  }

  // ------------------------------------------------------------------ pets and couriers

  /** A document goes from one desk to another: a dog takes it. With `animate` false it is only counted. */
  deliver(from: string, to: string, kind: "handoff" | "finding", animate: boolean) {
    const dogs = this.pets.filter((p) => p.kind === "dog");
    if (!animate || this.reduced || from === to || !this.L.desks[from] || !this.L.desks[to]) {
      bump(this.pick(dogs).id);
      return;
    }
    this.jobs.push({ id: this.jobSeq++, from, to, kind, stage: "toFrom", at: this.t });
  }

  private assignJobs() {
    if (!this.jobs.length) return;
    const free = this.pets.filter((p) => p.kind === "dog" && !p.job && p.mode !== "treat");
    for (const job of [...this.jobs]) {
      if (!free.length) break;
      const a = this.L.desks[job.from]!;
      free.sort((x, y) => dist(x, a.drop) - dist(y, a.drop));
      const dog = free.shift()!;
      this.jobs = this.jobs.filter((j) => j !== job);
      dog.job = job;
      dog.carrying = false;
      this.petWalk(dog, a.drop, 58, () => {
        // the sender hands the file over: a heartbeat, then off
        dog.mode = "sit";
        dog.until = this.t + 280;
        dog.then = () => {
          dog.carrying = true;
          job.stage = "toTo";
          const b = this.L.desks[job.to]!;
          this.petWalk(dog, b.drop, 62, () => this.arrive(dog, job));
        };
      });
    }
  }

  private arrive(dog: Pet, job: Job) {
    const to = this.people.get(job.to);
    const d = this.L.desks[job.to]!;
    dog.carrying = false;
    dog.mode = "treat";
    dog.until = this.t + 2100;
    dog.panting = true;
    dog.path = []; dog.d = 0; dog.len = 0;
    dog.facing = dog.x < d.center.x ? "right" : "left";
    // the receiver gives a treat: it arcs from their hand to the dog, they hop for joy, and there are hearts
    this.fx.push({ kind: "treat", x: d.seat.x + (dog.facing === "right" ? -4 : 6), y: d.seat.y - 12, toX: dog.x + (dog.facing === "right" ? 12 : -12), toY: dog.y - 7, t0: this.t, dur: 650 });
    this.fx.push({ kind: "heart", x: dog.x + 6, y: dog.y - 16, t0: this.t + 650, dur: 1500 });
    this.fx.push({ kind: "heart", x: d.seat.x, y: d.seat.y - 26, t0: this.t + 150, dur: 1500 });
    if (to) { to.jumpAt = this.t; to.happyUntil = this.t + 1800; }
    bump(dog.id);
    this.arrivals.push(job);
    dog.job = undefined;
    dog.then = undefined;
    dog.nextAt = this.t + this.rand(5000, 14000);
  }

  private petWalk(p: Pet, to: Pt, speed: number, then: () => void) {
    p.path = this.L.walk({ x: p.x, y: p.y }, to);
    p.len = pathLength(p.path); p.d = 0; p.speed = speed; p.mode = "walk"; p.then = then; p.panting = speed > 40;
  }

  private stepPets(dt: number, env: LifeEnv) {
    const t = this.t;
    for (const p of this.pets) {
      switch (p.mode) {
        case "walk": {
          p.d += (p.speed * dt) / 1000;
          const pos = along(p.path, p.d);
          if (Math.abs(pos.dx) > 0.2) p.facing = pos.dx < 0 ? "left" : "right";
          p.x = pos.x; p.y = pos.y;
          p.frame = Math.floor(t / (p.speed > 40 ? 90 : 170)) % 2;
          if (p.d >= p.len) { const f = p.then; p.then = undefined; p.mode = "idle"; f?.(); }
          break;
        }
        case "treat":
          if (t >= p.until) { p.mode = "sit"; p.until = t + 1500; p.panting = false; }
          break;
        case "sit":
          if (p.then && t >= p.until) { const f = p.then; p.then = undefined; f(); break; }
          if (p.job || p.then) break;
          if (t >= p.nextAt) this.petDecide(p, env);
          break;
        default:
          if (p.job) break;
          if (t >= p.nextAt) this.petDecide(p, env);
      }
    }
  }

  private petDecide(p: Pet, env: LifeEnv) {
    const t = this.t;
    p.nextAt = t + this.rand(20000, 60000);
    p.panting = false;
    const asleep = env.lighting.petsAsleep;
    if (asleep && p.mode !== "sleep") { this.petSleep(p); return; }
    if (asleep) return;
    const dogs = this.pets.filter((q) => q.kind === "dog");
    const r = this.rng();
    if (p.kind === "dog") {
      if (r < 0.3) this.petSleep(p);
      else if (r < 0.62) this.petWalk(p, this.L.randomFloor(this.rng(), this.rng()), 26, () => { p.mode = "sit"; p.until = t + 4000; });
      else if (r < 0.82) {
        // visit a desk and sit by it, hoping for a pat
        const ids = [...this.people.keys()];
        const d = this.L.desks[this.pick(ids)]!;
        this.petWalk(p, d.drop, 28, () => {
          p.mode = "sit"; p.until = this.t + 5000; p.panting = true;
          this.fx.push({ kind: "heart", x: p.x + 8, y: p.y - 16, t0: this.t + 800, dur: 1300 });
        });
      } else {
        // play: two dogs chase each other round the walkways
        const mate = dogs.find((q) => q !== p && !q.job && q.mode !== "walk");
        const a = this.L.randomFloor(this.rng(), this.rng()), b = this.L.randomFloor(this.rng(), this.rng());
        this.petWalk(p, a, 52, () => this.petWalk(p, b, 52, () => { p.mode = "sit"; p.until = this.t + 3000; p.panting = true; }));
        if (mate) {
          mate.nextAt = t + this.rand(20000, 60000);
          this.petWalk(mate, b, 50, () => this.petWalk(mate, a, 50, () => { mate.mode = "sit"; mate.until = this.t + 3000; mate.panting = true; }));
        }
      }
    } else {
      if (r < 0.55) this.petSleep(p);
      else if (r < 0.85) this.petWalk(p, this.L.randomFloor(this.rng(), this.rng()), 12, () => { p.mode = "sit"; p.until = this.t + 6000; });
      else { p.mode = "sit"; p.until = t + 8000; }
    }
  }

  private petSleep(p: Pet) {
    // the sunny spot, a bed, or a beanbag
    const spots = p.kind === "dog" ? [p.home, this.L.petHomes.sun] : [p.home, this.L.petHomes.sun, ...this.L.petHomes.cats];
    const to = this.pick(spots);
    this.petWalk(p, to, 20, () => { p.mode = "sleep"; });
  }

  // ------------------------------------------------------------------ pointing

  /** The walking person or pet under a point (logical px), if any. Seated people are the desk buttons' business. */
  hit(x: number, y: number): { type: "person"; id: string } | { type: "pet"; id: PetId } | null {
    let best: { d: number; r: { type: "person"; id: string } | { type: "pet"; id: PetId } } | null = null;
    for (const p of this.pets) {
      const h = p.kind === "dog" ? 14 : 8;
      if (x > p.x - 11 && x < p.x + 11 && y > p.y - h && y < p.y + 3) {
        const d = Math.hypot(x - p.x, y - (p.y - h / 2));
        if (!best || d < best.d) best = { d, r: { type: "pet", id: p.id } };
      }
    }
    for (const p of this.people.values()) {
      if (p.mode === "desk") continue;
      if (x > p.x - 8 && x < p.x + 8 && y > p.y - 26 && y < p.y + 2) {
        const d = Math.hypot(x - p.x, y - (p.y - 13)) - 3;
        if (!best || d < best.d) best = { d, r: { type: "person", id: p.id } };
      }
    }
    return best?.r ?? null;
  }
}


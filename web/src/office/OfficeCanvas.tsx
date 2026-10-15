// The pixel office: one open floor drawn on a canvas, with a DOM overlay for the zone signs, speech bubbles and one
// focusable button per desk. The canvas is scaled to fit any width from a phone to a wide monitor (crisp whole-pixel
// scaling when it fits, a smooth fit otherwise, never zero). Idle life, the pets and the lighting all run here, on the
// client only.
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AgentId } from "@shared/contracts";
import { AGENTS, DEPARTMENTS } from "@shared/roster";
import { lightingAt } from "../lib/daylight";
import { plain } from "../lib/words";
import { type LaneView, type RunView, laneOf } from "../state/derive";
import {
  drawBadge, drawChair, drawClock, drawDesk, drawDrawerOpen, drawFileStack, drawHands, drawLearnedShelf, drawNotes, drawPlan, drawScreen,
  drawServerLeds, drawSparkle, learnedSlots,
} from "./draw";
import { drawFx, drawPerson, drawPet, drawZzz } from "./figures";
import { Life, deliveriesToday } from "./life";
import { type LightLayer, drawLighting, makeLightLayer } from "./light";
import { type OfficeLayout, type Pt, buildLayout } from "./layout";
import { type PetId, petById, PETS } from "./pets";
import { officePalette } from "./palette";
import { drawStatic, drawStatus, drawTv, drawWindows } from "./scene";
import { type Eyes, shirtOf, skinOf, spriteCanvas } from "./sprites";
import "./office.css";

const CHIEF = "chief-of-staff";

/** One seed per page load: the office's idle life is the same for the whole session (and for a given ?seed=). */
const SESSION_SEED = (() => {
  try {
    const p = Number(new URLSearchParams(location.search).get("seed"));
    if (p) return p;
  } catch { /* no location */ }
  return Math.floor(Math.random() * 2 ** 31);
})();

interface Effect { kind: "badge-ok" | "badge-bad" | "sparkle"; x: number; y: number; t0: number; dur: number }
interface Transient { text: string; tone: "ok" | "bad" | "done" | "handoff"; until: number }
interface IdleBubble { text: string; x: number; y: number; until: number }

export interface OfficeCanvasProps {
  view?: RunView;
  events?: AgentEvent[];
  runKey?: string;
  /** An explicit dark theme: the office is dimmed a little more. */
  dark: boolean;
  reducedMotion: boolean;
  speed: number;
  /** Minutes since midnight on the business's clock (or the preview): decides the light. */
  minutes: number;
  compact?: boolean;
  maxHeight?: number;
  selected?: AgentId | null;
  onSelect: (agent: AgentId) => void;
  /** Desks the owner switched off (Team settings): the agent sits idle, dimmed, with an "off" sign. */
  off?: ReadonlySet<AgentId>;
  /** One book on Sara's shelf per learned rule, oldest first. */
  books?: ShelfBook[];
  onBook?: (ruleId: string) => void;
  /** Said to screen readers and shown in the page when something happens (a dog delivers). */
  onStatus?: (text: string) => void;
  /** Pinned to the bottom of the office (the quiet "Tara is drafting ideas…" line). */
  overlay?: ReactNode;
}

export interface ShelfBook { id: string; text: string; hue: number; confidence: number }

const agentName = (id: string) => AGENTS.find((a) => a.id === id)?.name ?? id;

// The Library's bookshelf, where every learned rule becomes a book.
const libraryShelf = (L: OfficeLayout) => L.rooms.find((r) => r.dept.id === "knowledge")?.floor.find((f) => f.kind === "bookshelf")?.rect;
// The picture frame in the Content Studio zone, where the Studio pins the newest photo.
const studioFrame = (L: OfficeLayout) => L.rooms.find((r) => r.dept.id === "content")?.wall.find((w) => w.kind === "frame")?.rect;

/** The people the current request has put to work: the plan's steps, whoever has started, and Meera while she writes. */
function busyOf(v: RunView | undefined): Set<string> {
  const s = new Set<string>();
  if (!v) return s;
  const live = !v.final && v.count > 0 && !v.error;
  for (const k of v.laneOrder) {
    const l = v.lanes[k];
    if (l && (l.phase === "working" || (live && l.phase === "planned"))) s.add(l.agent);
  }
  if (live && v.plan) for (const st of v.plan.steps) s.add(st.agent);
  if (live && v.plan) s.add(v.plan.by);
  if (live && v.answerStarted) s.add(CHIEF);
  return s;
}

const petLine = (id: PetId) => {
  const d = petById(id);
  const n = deliveriesToday(id);
  return d.kind === "dog" ? `${d.name} · ${d.breed} · ${n} ${n === 1 ? "delivery" : "deliveries"} today` : `${d.name} · ${d.breed} · office cat, off duty`;
};

export function OfficeCanvas({ view, events, runKey, dark, reducedMotion, speed, minutes, compact, maxHeight, selected, onSelect, off, books, onBook, onStatus, overlay }: OfficeCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const dpr = typeof window !== "undefined" ? Math.max(1, Math.round((window.devicePixelRatio || 1) * 100) / 100) : 1;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    setBox({ w: Math.floor(r0.width), h: Math.floor(r0.height) });
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      setBox({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const orientation = box.w > 0 && box.w < 560 ? "portrait" : "landscape";
  const layout = useMemo<OfficeLayout>(() => buildLayout(orientation), [orientation]);
  const pal = useMemo(() => officePalette(), []);

  // The scale: how many CSS px one art pixel gets. Whole device pixels per art pixel when it fits nearly exactly (crisp);
  // otherwise a smooth fit from a backing store of at least one device pixel per art pixel. Never zero, at any width.
  const availH = maxHeight ?? (box.h || 9999);
  const fit = Math.max(0.35, Math.min(box.w / layout.w, availH / layout.h));
  const sDev = fit * dpr;
  const whole = sDev >= 1 && sDev - Math.floor(sDev) < 0.12;
  const s = whole ? Math.floor(sDev) : Math.max(1, Math.ceil(sDev)); // device px per art px in the backing store
  const k = whole ? s / dpr : fit;                                      // CSS px per art px
  const cssW = layout.w * k, cssH = layout.h * k;

  const staticCanvas = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = layout.w;
    c.height = layout.h;
    drawStatic(c.getContext("2d")!, layout, pal);
    return c;
  }, [layout, pal]);
  const lightLayer = useMemo<LightLayer>(() => makeLightLayer(layout), [layout]);

  // the living office
  const life = useMemo(() => new Life(layout, SESSION_SEED, reducedMotion), [layout, reducedMotion]);
  const warmed = useRef<Life | null>(null);

  const [litBook, setLitBook] = useState<number | undefined>();
  const live = useRef({ view, reducedMotion, layout, pal, staticCanvas, lightLayer, s, selected, off, books, litBook, minutes, dark, life });
  live.current = { view, reducedMotion, layout, pal, staticCanvas, lightLayer, s, selected, off, books, litBook, minutes, dark, life };

  const effects = useRef<Effect[]>([]);
  const delivered = useRef(0);
  const doneAt = useRef<Record<string, number>>({});
  const celebrateAt = useRef(0);
  const processed = useRef({ key: "", n: 0 });
  const [transients, setTransients] = useState<Record<string, Transient>>({});
  const [chatter, setChatter] = useState<Record<string, IdleBubble>>({});
  const [wallPhoto, setWallPhoto] = useState<{ src: string; kind: string } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastHit = useRef<string>("");

  // turn new events into transient animations; documents ride with the dogs
  useEffect(() => {
    const key = runKey ?? "";
    const list = events ?? [];
    if (processed.current.key !== key) {
      processed.current = { key, n: 0 };
      effects.current = [];
      delivered.current = 0;
      doneAt.current = {};
      celebrateAt.current = 0;
      setTransients({});
      setWallPhoto(null);
    }
    const start = processed.current.n;
    const fresh = list.slice(start);
    processed.current.n = list.length;
    if (!fresh.length) return;
    const catchUp = fresh.length > 8;
    const now = performance.now();
    const L = live.current.layout;
    const lf = live.current.life;
    const sp = Math.sqrt(Math.max(1, speed));
    const nextTransients: Record<string, Transient> = {};
    let nextPhoto: { src: string; kind: string } | undefined;
    for (const e of fresh) {
      if (e.type === "handoff") {
        lf.deliver(e.from, e.to, "handoff", !catchUp);
        if (!catchUp) nextTransients[e.from] = { text: `Passing this to ${agentName(e.to)}`, tone: "handoff", until: Date.now() + 2200 / sp };
      } else if (e.type === "finding" && e.agent !== CHIEF) {
        lf.deliver(e.agent, CHIEF, "finding", !catchUp);
        if (catchUp || live.current.reducedMotion) delivered.current++;
      } else if (e.type === "review") {
        const finding = live.current.view?.findings[e.findingId];
        const author = finding?.agent;
        const d = author ? L.desks[author] : undefined;
        if (d && !catchUp) effects.current.push({ kind: e.verdict === "ok" ? "badge-ok" : "badge-bad", x: d.notes.x + 2, y: d.notes.y - 6, t0: now, dur: 2400 / sp });
        if (!catchUp) nextTransients[e.agent] = { text: `${e.verdict === "ok" ? "✓" : "✗"} ${author ? agentName(author) + ": " : ""}${e.note}`, tone: e.verdict === "ok" ? "ok" : "bad", until: Date.now() + 3200 / sp };
      } else if (e.type === "asset") {
        if (e.thumb) nextPhoto = { src: e.thumb.replace(/\?w=\d+$/, "?w=96"), kind: e.kind };
        const fr = studioFrame(L);
        if (fr && !catchUp && !live.current.reducedMotion) effects.current.push({ kind: "sparkle", x: fr.x + fr.w / 2, y: fr.y + fr.h / 2, t0: now, dur: 900 });
        if (!catchUp) nextTransients[e.agent] = { text: e.kind === "original" ? "New photo in: having a look" : "A version is ready for Nisha", tone: "done", until: Date.now() + 2600 / sp };
      } else if (e.type === "assessment") {
        if (!catchUp) nextTransients[e.agent] = { text: `${e.verdict[0]!.toUpperCase()}${e.verdict.slice(1)} it`, tone: "ok", until: Date.now() + 2600 / sp };
      } else if (e.type === "agent_done") {
        doneAt.current[e.agent] = now;
      } else if (e.type === "final") {
        celebrateAt.current = now;
        const chief = L.desks[CHIEF];
        if (chief && !live.current.reducedMotion) effects.current.push({ kind: "sparkle", x: chief.center.x, y: chief.sprite.y + 2, t0: now, dur: 900 });
      }
    }
    if (Object.keys(nextTransients).length) setTransients((t) => ({ ...t, ...nextTransients }));
    if (nextPhoto) setWallPhoto(nextPhoto);
  }, [events, runKey, speed]);

  // a new rule learned while the office is open: a sparkle over its book
  const bookCount = useRef<number | undefined>(undefined);
  useEffect(() => {
    const n = books?.length;
    const prev = bookCount.current;
    bookCount.current = n;
    if (n === undefined || prev === undefined || n <= prev || reducedMotion) return;
    const shelf = libraryShelf(live.current.layout);
    const slot = shelf ? learnedSlots(shelf, n).slots[n - 1] : undefined;
    if (slot) effects.current.push({ kind: "sparkle", x: slot.x + 1, y: slot.y + 2, t0: performance.now(), dur: 1100 });
  }, [books?.length, reducedMotion]);

  // expire transient bubbles
  useEffect(() => {
    const times = Object.values(transients).map((t) => t.until);
    if (!times.length) return;
    const next = Math.min(...times) - Date.now();
    const id = setTimeout(() => {
      setTransients((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v.until > Date.now())));
    }, Math.max(50, next));
    return () => clearTimeout(id);
  }, [transients]);
  useEffect(() => {
    const times = Object.values(chatter).map((t) => t.until);
    if (!times.length) return;
    const next = Math.min(...times) - Date.now();
    const id = setTimeout(() => {
      setChatter((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v.until > Date.now())));
    }, Math.max(50, next));
    return () => clearTimeout(id);
  }, [chatter]);

  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  // the frame loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = 0;
    const seeds = Object.fromEntries(AGENTS.map((a, i) => [a.id, i * 7919 + 13]));
    const emptyOff: ReadonlySet<string> = new Set();
    const frame = (tNow: number) => {
      const { view: v, reducedMotion: rm, layout: L, pal: p, staticCanvas: sc, s: scale, off: offSet, books: shelfBooks, litBook: lit, minutes: mins, dark: isDark, life: lf, lightLayer: ll } = live.current;
      const dt = last ? tNow - last : 16;
      last = tNow;
      const lighting = lightingAt(mins);
      const busy = busyOf(v);
      const offs = offSet ?? emptyOff;
      if (warmed.current !== lf) { lf.warmUp({ busy, off: offs, lighting }); warmed.current = lf; }
      lf.update(dt, { busy, off: offs, lighting });
      const lt = lf.t;

      // what the people said, and what the dogs delivered
      if (lf.speech.length) {
        const said = lf.speech.splice(0);
        setChatter((m) => {
          const next = { ...m };
          for (const sp of said) { const pe = lf.people.get(sp.agent); if (pe) next[sp.agent] = { text: sp.text, x: pe.x, y: pe.y - (pe.mode === "desk" ? 22 : 30), until: Date.now() + sp.ms }; }
          return next;
        });
      }
      if (lf.arrivals.length) {
        for (const j of lf.arrivals.splice(0)) {
          if (j.kind === "finding") delivered.current++;
          statusRef.current?.(`${agentName(j.to)} gave the dog a treat`);
        }
      }

      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sc, 0, 0);
      drawWindows(ctx, L, mins);

      const working = (a: AgentId) => laneOf(v ?? ({ lanes: {} } as RunView), a)?.phase === "working";
      const deptWorking = (dept: string) => AGENTS.some((a) => a.department === dept && working(a.id));
      const playing = [...lf.people.values()].some((pe) => pe.act?.kind === "console");

      // wall-hung and standing things that change
      for (const it of L.backWall) if (it.kind === "clock") drawClock(ctx, it.rect, p, new Date());
      for (const room of L.rooms) {
        const active = deptWorking(room.dept.id);
        for (const it of room.wall) {
          if (it.kind === "screen-dash" || it.kind === "screen-code") drawScreen(ctx, it, p, active || lighting.lamps > 0.5, lt);
          else if (it.kind === "status") drawStatus(ctx, it.rect, p, lt, active);
          else if (it.kind === "tv") drawTv(ctx, it.rect, p, playing, lt);
          else if (it.kind === "whiteboard") {
            const steps = (v?.plan?.steps ?? []).map((st) => {
              const lane = v?.lanes[st.agent];
              return {
                agent: st.agent, after: st.after ?? [], depth: lane?.depth ?? 1, phase: lane?.phase ?? "planned",
                hue: DEPARTMENTS.find((d) => d.id === AGENTS.find((a) => a.id === st.agent)?.department)?.hue ?? 270,
              };
            });
            drawPlan(ctx, it.rect, p, steps, tNow);
          }
        }
        for (const it of room.floor) {
          if (it.kind === "server") drawServerLeds(ctx, it.rect, p, active, tNow);
          if (it.kind === "cabinets" && active && !rm) drawDrawerOpen(ctx, it.rect, p, tNow);
        }
      }

      // Sara's shelf: one book per learned rule
      const shelf = libraryShelf(L);
      if (shelf && shelfBooks) drawLearnedShelf(ctx, shelf, shelfBooks, p, lit);

      // everything that stands on the floor, back to front
      const celebrating = celebrateAt.current && tNow - celebrateAt.current < 1400 && !rm;
      const items: { y: number; draw: () => void }[] = [];
      for (const d of Object.values(L.desks)) {
        items.push({ y: d.desk.y + d.desk.h, draw: () => {
          const person = lf.people.get(d.agent);
          const isOff = offs.has(d.agent);
          drawChair(ctx, d, p);
          const atDesk = isOff || !person || person.mode === "desk";
          if (isOff) {
            ctx.globalAlpha = 0.38;
            ctx.drawImage(spriteCanvas(d.agent, { bob: 0, eyes: "closed" }), d.sprite.x, d.sprite.y);
            ctx.globalAlpha = 1;
            drawDesk(ctx, d, p, { working: false, t: 0, lamp: true });
            return;
          }
          const lane: LaneView | undefined = v ? laneOf(v, d.agent) : undefined;
          const isWorking = lane?.phase === "working" && atDesk;
          const seed = seeds[d.agent] ?? 0;
          const justDone = doneAt.current[d.agent] && tNow - doneAt.current[d.agent]! < 1500;
          const inFinal = celebrating && v?.final?.agents.includes(d.agent);
          const sleepy = !!person?.sleepy && !busy.has(d.agent);
          if (atDesk) {
            let eyes: Eyes = "open";
            const happy = person && lt < person.happyUntil;
            if (inFinal || justDone || happy) eyes = "happy";
            else if (sleepy) eyes = "closed";
            else if (!rm && (lt + seed * 97) % 4300 < 140) eyes = "closed";
            else if (!rm && !isWorking) {
              const g = Math.floor((lt + seed * 131) / 2600) % 7;
              eyes = g === 0 ? "left" : g === 3 ? "right" : "open";
            }
            let bob: 0 | 1 | 2 | 3 = rm ? 0 : isWorking ? (Math.floor((lt + seed) / 280) % 5 === 0 ? 1 : 0) : (Math.floor((lt + seed * 3) / 1100) % 2 as 0 | 1);
            // someone nodding off: the head sinks and bobs back up
            if (sleepy) bob = rm ? 2 : ((2 + (Math.floor((lt + seed) / 1700) % 3 === 0 ? 1 : 0)) as 2 | 3);
            const hop = person && !rm && lt - person.jumpAt < 800 ? Math.round(Math.abs(Math.sin(((lt - person.jumpAt) / 800) * Math.PI * 2)) * 3) : 0;
            ctx.drawImage(spriteCanvas(d.agent, { bob, eyes, arms: inFinal || hop ? "up" : undefined }), d.sprite.x, d.sprite.y - hop);
            drawDesk(ctx, d, p, { working: isWorking, t: lt, lamp: true });
            if (isWorking && !inFinal) drawHands(ctx, d, skinOf(d.agent), shirtOf(d.agent), rm ? 0 : Math.floor((lt + seed) / 120));
            if (sleepy) drawZzz(ctx, d.sprite.x + 13, d.sprite.y + 1, lt + seed, rm);
          } else drawDesk(ctx, d, p, { working: false, t: lt, lamp: true });
          const notes = (lane && v ? [...(v.lanes[d.agent]?.findings ?? [])] : []).map((f) => ({
            verdict: f.reviews.length === 0 ? ("pending" as const) : f.reviews.some((r) => r.verdict !== "ok") ? ("fix" as const) : ("ok" as const),
          }));
          drawNotes(ctx, d, notes, p);
          if (d.agent === CHIEF && delivered.current > 0) drawFileStack(ctx, d, delivered.current, p);
        } });
      }
      for (const pe of lf.people.values()) if (pe.mode !== "desk" && !offs.has(pe.id)) items.push({ y: pe.y, draw: () => drawPerson(ctx, pe, lt, rm) });
      for (const pet of lf.pets) items.push({ y: pet.y, draw: () => drawPet(ctx, pet, lt, rm, p) });
      items.sort((a, b) => a.y - b.y);
      for (const it of items) it.draw();

      // the hour's light, over all of it
      drawLighting(ctx, ll, L, { lighting, lit: busy, tvPlaying: playing, dark: isDark });

      // badges, sparkles, hearts and treats sit above the lighting
      const now = performance.now();
      effects.current = effects.current.filter((e) => {
        const k0 = (now - e.t0) / e.dur;
        if (k0 >= 1) return false;
        if (e.kind === "sparkle") drawSparkle(ctx, Math.round(e.x), Math.round(e.y), k0, p);
        else drawBadge(ctx, e.x, e.y - Math.round(Math.min(1, k0 * 6) * 3), e.kind === "badge-ok" ? "ok" : "bad", p, k0 < 0.08 ? 0 : 1);
        return true;
      });
      if (!rm) for (const f of lf.fx) drawFx(ctx, f, lt);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [s, layout, life]);

  // bubbles: what each person is doing right now, and the odd line of office chat
  const bubbles = useMemo(() => {
    const out: { agent: string; text: string; tone: "work" | "speak" | "chat" | Transient["tone"]; x: number; y: number }[] = [];
    const now = Date.now();
    const desks = layout.desks;
    for (const a of AGENTS) {
      const d = desks[a.id];
      if (!d) continue;
      const tr = transients[a.id];
      if (tr && tr.until > now) { out.push({ agent: a.id, text: tr.text, tone: tr.tone, x: d.bubble.x, y: d.bubble.y }); continue; }
      const lane = view ? laneOf(view, a.id) : undefined;
      if (lane && lane.phase === "working") {
        const step = lane.steps[lane.steps.length - 1];
        const pending = step && !step.done ? step : undefined;
        if (a.id === CHIEF && view?.answerStarted && !view.final) out.push({ agent: a.id, text: "Writing your answer…", tone: "speak", x: d.bubble.x, y: d.bubble.y });
        else out.push({ agent: a.id, text: plain((pending ? lane.status ?? lane.task : lane.status ?? lane.task) ?? "Working"), tone: "work", x: d.bubble.x, y: d.bubble.y });
        continue;
      }
      const ch = chatter[a.id];
      if (ch && ch.until > now) out.push({ agent: a.id, text: ch.text, tone: "chat", x: ch.x, y: ch.y });
    }
    return out;
  }, [view, transients, chatter, layout]);

  // keep bubbles from overlapping: lift a bubble above any earlier one it collides with
  useLayoutEffect(() => {
    const root = overlayRef.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>(".bubble")];
    const relayout = () => {
      for (const el of els) el.style.setProperty("--lift", "0px");
      const placed: DOMRect[] = [];
      const sorted = els.map((el) => ({ el, r: el.getBoundingClientRect() })).sort((a, b) => b.r.top - a.r.top);
      for (const { el, r } of sorted) {
        let lift = 0;
        let rect = r;
        for (let guard = 0; guard < 4; guard++) {
          const hit = placed.find((p) => rect.left < p.right + 4 && rect.right > p.left - 4 && rect.top < p.bottom + 8 && rect.bottom > p.top - 8);
          if (!hit) break;
          lift += rect.bottom - hit.top + 10;
          rect = new DOMRect(r.left, r.top - lift, r.width, r.height);
        }
        el.style.setProperty("--lift", `${-lift}px`);
        placed.push(rect);
      }
    };
    relayout();
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(relayout); });
    els.forEach((el) => ro.observe(el));
    document.fonts?.ready.then(() => requestAnimationFrame(relayout));
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [bubbles, k, layout]);

  // pointing at the people and pets who are out and about
  const toLogical = useCallback((e: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * layout.w, y: ((e.clientY - r.top) / r.height) * layout.h };
  }, [layout]);
  const showTip = useCallback((id: PetId, pinned: boolean) => {
    const pet = life.pets.find((p) => p.id === id);
    if (!pet) return;
    clearTimeout(tipTimer.current);
    setTip({ x: pet.x, y: pet.y - (pet.kind === "dog" ? 15 : 9), text: petLine(id) });
    if (pinned) tipTimer.current = setTimeout(() => setTip(null), 2800);
  }, [life]);
  const onMove = (e: React.PointerEvent) => {
    const pt = toLogical(e);
    const h = life.hit(pt.x, pt.y);
    const key = h ? `${h.type}:${h.id}` : "";
    if (key === lastHit.current) return;
    lastHit.current = key;
    if (canvasRef.current) canvasRef.current.style.cursor = h ? "pointer" : "";
    if (h?.type === "pet") showTip(h.id, false);
    else { clearTimeout(tipTimer.current); setTip(null); }
  };
  const onClick = (e: React.MouseEvent) => {
    const pt = toLogical(e);
    const h = life.hit(pt.x, pt.y);
    if (!h) return;
    if (h.type === "person") onSelect(h.id as AgentId);
    else showTip(h.id, true);
  };

  const ready = box.w > 0;
  return (
    <div className={`office-wrap${compact ? " is-compact" : ""}`} ref={wrapRef}>
      {ready && (
        <div className="office-frame" style={{ width: cssW, height: cssH, ["--k" as string]: k }}>
          <canvas
            ref={canvasRef}
            className={`office-canvas${whole ? " is-whole" : ""}`}
            width={layout.w * s}
            height={layout.h * s}
            style={{ width: cssW, height: cssH }}
            onPointerMove={onMove}
            onPointerLeave={() => { lastHit.current = ""; clearTimeout(tipTimer.current); setTip(null); }}
            onClick={onClick}
            role="img"
            aria-label={`The office: ${AGENTS.length} people in ${DEPARTMENTS.length} teams, a cafeteria and a game room, and three dogs and two cats.${view?.activeAgents.length ? ` Working now: ${view.activeAgents.map(agentName).join(", ")}.` : ""}`}
          />
          <div className="office-overlay" ref={overlayRef}>
            {layout.rooms.map((room) => {
              const active = room.agents.some((a) => view && laneOf(view, a)?.phase === "working");
              return (
                <span key={room.dept.id} className={`zone-sign${active ? " is-active" : ""}`} style={{ left: room.sign.x * k, top: room.sign.y * k, ["--hue" as string]: room.dept.hue }}>
                  {room.dept.name}
                </span>
              );
            })}
            {AGENTS.map((a) => {
              const d = layout.desks[a.id];
              if (!d) return null;
              const lane = view ? laneOf(view, a.id) : undefined;
              const phase = lane?.phase;
              const isOff = off?.has(a.id) ?? false;
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`agent-hit${phase === "working" ? " is-working" : ""}${phase === "done" ? " is-done" : ""}${selected === a.id ? " is-selected" : ""}${isOff ? " is-off" : ""}`}
                  style={{ left: (d.desk.x - 3) * k, top: (d.sprite.y + 1) * k, width: (d.desk.w + 6) * k, height: (d.desk.y + d.desk.h - d.sprite.y + 1) * k }}
                  onClick={() => onSelect(a.id)}
                  aria-label={`${a.name}, ${a.title}${isOff ? ", switched off" : phase === "working" ? `, working: ${lane?.status ?? lane?.task ?? ""}` : phase === "done" ? ", finished" : ""}. Open profile.`}
                >
                  {isOff && <span className="desk-off" style={{ left: (d.desk.w / 2 + 3) * k, top: (d.desk.y - d.sprite.y + 10) * k }} aria-hidden="true">off</span>}
                  <span className="agent-name" style={{ top: (d.desk.h + d.desk.y - d.sprite.y + 2) * k }}>
                    <span className="agent-dot" aria-hidden="true" />
                    {a.name}
                  </span>
                </button>
              );
            })}
            {books && onBook && (() => {
              const shelf = libraryShelf(layout);
              if (!shelf) return null;
              const { slots, capacity } = learnedSlots(shelf, books.length);
              return (
                <div className="shelf-hits" role="group" aria-label={`Sara's shelf: ${books.length} ${books.length === 1 ? "thing" : "things"} learned from your edits`}>
                  {slots.map((sl, i) => (
                    <button
                      key={books[i]!.id}
                      type="button"
                      className="book-hit"
                      style={{ left: (sl.x - 0.5) * k, top: sl.y * k, width: 3 * k, height: sl.h * k }}
                      onClick={() => onBook(books[i]!.id)}
                      onMouseEnter={() => setLitBook(i)}
                      onMouseLeave={() => setLitBook(undefined)}
                      onFocus={() => setLitBook(i)}
                      onBlur={() => setLitBook(undefined)}
                      aria-label={`Learned from your edits: ${books[i]!.text} Show where it came from.`}
                    >
                      <span className="book-tip" aria-hidden="true">{books[i]!.text}</span>
                    </button>
                  ))}
                  {books.length > capacity && (
                    <span className="shelf-more" style={{ left: (shelf.x + shelf.w + 1) * k, top: shelf.y * k }}>+{books.length - capacity}</span>
                  )}
                </div>
              );
            })()}
            {wallPhoto && (() => {
              const fr = studioFrame(layout);
              if (!fr) return null;
              const w = 22, h = 17;
              return (
                <img
                  key={wallPhoto.src}
                  className={`wall-photo is-${wallPhoto.kind}`}
                  src={wallPhoto.src}
                  alt=""
                  aria-hidden="true"
                  style={{ left: (fr.x + fr.w / 2 - w / 2) * k, top: (fr.y - 3) * k, width: w * k, height: h * k }}
                />
              );
            })()}
            {!compact &&
              bubbles.map((b) => (
                <div key={b.agent} className={`bubble tone-${b.tone}${b.y * k < 44 ? " is-below" : ""}`} style={{ left: b.x * k, top: b.y * k < 44 ? (b.y + 34) * k : b.y * k }} aria-hidden="true">
                  <span className="bubble-text">{b.text}</span>
                </div>
              ))}
            {tip && <div className="pet-tip" role="status" style={{ left: tip.x * k, top: tip.y * k }}>{tip.text}</div>}
          </div>
          {overlay && <div className="office-slot">{overlay}</div>}
          <div className="visually-hidden" role="group" aria-label="The office pets">
            {PETS.map((p) => <button key={p.id} type="button" onClick={() => showTip(p.id, true)}>{petLine(p.id)}</button>)}
          </div>
        </div>
      )}
    </div>
  );
}

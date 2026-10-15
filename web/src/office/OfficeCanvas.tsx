// The pixel office: a canvas (integer-scaled in device pixels, so every logical pixel is a crisp square) with a DOM
// overlay for room labels, speech bubbles and one focusable button per agent.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AgentId } from "@shared/contracts";
import { AGENTS, DEPARTMENTS } from "@shared/roster";
import { type LaneView, type RunView, laneOf } from "../state/derive";
import {
  drawBadge, drawChair, drawClock, drawDesk, drawDrawerOpen, drawFile, drawFileStack, drawHands, drawLampGlow, drawNotes,
  drawPlan, drawScreen, drawServerLeds, drawSparkle, drawStatic,
} from "./draw";
import { drawCat } from "./cat";
import { type OfficeLayout, type Pt, buildLayout } from "./layout";
import { officePalette } from "./palette";
import { type Eyes, shirtOf, skinOf, spriteCanvas } from "./sprites";
import "./office.css";

const CHIEF = "chief-of-staff";

interface Flight { path: Pt[]; lengths: number[]; total: number; t0: number; dur: number; kind: "handoff" | "finding"; to: AgentId }
interface Effect { kind: "badge-ok" | "badge-bad" | "sparkle"; x: number; y: number; t0: number; dur: number }
interface Transient { text: string; tone: "ok" | "bad" | "done" | "handoff"; until: number }

export interface OfficeCanvasProps {
  view?: RunView;
  events?: AgentEvent[];
  runKey?: string;
  dark: boolean;
  reducedMotion: boolean;
  speed: number;
  compact?: boolean;
  maxHeight?: number;
  selected?: AgentId | null;
  onSelect: (agent: AgentId) => void;
}

const agentName = (id: string) => AGENTS.find((a) => a.id === id)?.name ?? id;

function polyline(path: Pt[]) {
  const lengths = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!;
    lengths.push(lengths[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return { lengths, total: lengths[lengths.length - 1]! };
}

function pointAt(f: Flight, k: number): Pt {
  const d = k * f.total;
  for (let i = 1; i < f.path.length; i++) {
    if (d <= f.lengths[i]! || i === f.path.length - 1) {
      const a = f.path[i - 1]!, b = f.path[i]!;
      const seg = f.lengths[i]! - f.lengths[i - 1]! || 1;
      const u = Math.min(1, Math.max(0, (d - f.lengths[i - 1]!) / seg));
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return f.path[f.path.length - 1]!;
}

const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export function OfficeCanvas({ view, events, runKey, dark, reducedMotion, speed, compact, maxHeight, selected, onSelect }: OfficeCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const dpr = typeof window !== "undefined" ? Math.max(1, Math.round((window.devicePixelRatio || 1) * 100) / 100) : 1;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      setBox({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const orientation = box.w > 0 && box.w < 560 ? "portrait" : "landscape";
  const layout = useMemo<OfficeLayout>(() => buildLayout(orientation), [orientation]);
  const pal = useMemo(() => officePalette(dark), [dark]);

  // device pixels per logical pixel: an integer, so the art stays crisp
  const availH = maxHeight ?? (box.h || 9999);
  const s = Math.max(1, Math.floor(Math.min((box.w * dpr) / layout.w, (availH * dpr) / layout.h)));
  const k = s / dpr; // CSS px per logical px
  const cssW = (layout.w * s) / dpr, cssH = (layout.h * s) / dpr;

  // static floor plan, redrawn only when the layout or theme changes
  const staticCanvas = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = layout.w;
    c.height = layout.h;
    drawStatic(c.getContext("2d")!, layout, pal);
    return c;
  }, [layout, pal]);

  // live state the frame loop reads
  const live = useRef({ view, reducedMotion, speed, layout, pal, staticCanvas, s, selected });
  live.current = { view, reducedMotion, speed, layout, pal, staticCanvas, s, selected };

  const flights = useRef<Flight[]>([]);
  const effects = useRef<Effect[]>([]);
  const delivered = useRef(0);
  const doneAt = useRef<Record<string, number>>({});
  const celebrateAt = useRef(0);
  const processed = useRef({ key: "", n: 0 });
  const [transients, setTransients] = useState<Record<string, Transient>>({});

  // turn new events into transient animations
  useEffect(() => {
    const key = runKey ?? "";
    const list = events ?? [];
    if (processed.current.key !== key) {
      processed.current = { key, n: 0 };
      flights.current = [];
      effects.current = [];
      delivered.current = 0;
      doneAt.current = {};
      celebrateAt.current = 0;
      setTransients({});
    }
    const start = processed.current.n;
    const fresh = list.slice(start);
    processed.current.n = list.length;
    if (!fresh.length) return;
    const catchUp = fresh.length > 8;
    const now = performance.now();
    const L = live.current.layout;
    const sp = Math.sqrt(Math.max(1, live.current.speed));
    const nextTransients: Record<string, Transient> = {};
    const fly = (from: AgentId, to: AgentId, kind: Flight["kind"]) => {
      if (catchUp || live.current.reducedMotion) { if (kind === "finding") delivered.current++; return; }
      const path = L.route(from, to);
      if (path.length < 2) return;
      const { lengths, total } = polyline(path);
      flights.current.push({ path, lengths, total, t0: now + flights.current.filter((f) => f.t0 > now - 50).length * 120, dur: Math.max(700, (total / 190) * 1000) / sp, kind, to });
    };
    for (const e of fresh) {
      if (e.type === "handoff") {
        fly(e.from, e.to, "handoff");
        if (!catchUp) nextTransients[e.from] = { text: `→ ${agentName(e.to)}: ${e.note}`, tone: "handoff", until: Date.now() + 2200 / sp };
      } else if (e.type === "finding" && e.agent !== CHIEF) {
        fly(e.agent, CHIEF, "finding");
      } else if (e.type === "review") {
        const finding = live.current.view?.findings[e.findingId];
        const author = finding?.agent;
        const d = author ? L.desks[author] : undefined;
        if (d && !catchUp) effects.current.push({ kind: e.verdict === "ok" ? "badge-ok" : "badge-bad", x: d.notes.x + 2, y: d.notes.y - 6, t0: now, dur: 2400 / sp });
        if (!catchUp) nextTransients[e.agent] = { text: `${e.verdict === "ok" ? "✓" : "✗"} ${author ? agentName(author) + ": " : ""}${e.note}`, tone: e.verdict === "ok" ? "ok" : "bad", until: Date.now() + 3200 / sp };
      } else if (e.type === "agent_done") {
        doneAt.current[e.agent] = now;
      } else if (e.type === "final") {
        celebrateAt.current = now;
        const chief = L.desks[CHIEF];
        if (chief && !live.current.reducedMotion) effects.current.push({ kind: "sparkle", x: chief.center.x, y: chief.sprite.y + 2, t0: now, dur: 900 });
      }
    }
    if (Object.keys(nextTransients).length) setTransients((t) => ({ ...t, ...nextTransients }));
  }, [events, runKey]);

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

  // the frame loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const seeds = Object.fromEntries(AGENTS.map((a, i) => [a.id, i * 7919 + 13]));
    const frame = (tNow: number) => {
      const { view: v, reducedMotion: rm, layout: L, pal: p, staticCanvas: sc, s: scale } = live.current;
      const t = rm ? 0 : tNow;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sc, 0, 0);

      const working = (a: AgentId) => laneOf(v ?? ({ lanes: {} } as RunView), a)?.phase === "working";
      const deptWorking = (dept: string) => AGENTS.some((a) => a.department === dept && working(a.id));

      // wall-hung things that change
      for (const room of L.rooms) {
        const active = deptWorking(room.dept.id);
        for (const it of room.wall) {
          if (it.kind === "screen-dash" || it.kind === "screen-code") drawScreen(ctx, it, p, active, tNow);
          else if (it.kind === "clock") drawClock(ctx, it.rect, p, new Date());
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

      // desks, back to front
      const desks = Object.values(L.desks).sort((a, b) => a.desk.y - b.desk.y);
      if (p.dark) for (const d of desks) if (working(d.agent)) drawLampGlow(ctx, d, p);
      const celebrating = celebrateAt.current && tNow - celebrateAt.current < 1400 && !rm;
      for (const d of desks) {
        const lane: LaneView | undefined = v ? laneOf(v, d.agent) : undefined;
        const isWorking = lane?.phase === "working";
        const seed = seeds[d.agent] ?? 0;
        const justDone = doneAt.current[d.agent] && tNow - doneAt.current[d.agent]! < 1500;
        const inFinal = celebrating && v?.final?.agents.includes(d.agent);
        let eyes: Eyes = "open";
        if (inFinal || justDone) eyes = "happy";
        else if (!rm && (t + seed * 97) % 4300 < 140) eyes = "closed";
        else if (!rm && !isWorking) {
          const g = Math.floor((t + seed * 131) / 2600) % 7;
          eyes = g === 0 ? "left" : g === 3 ? "right" : "open";
        }
        const bob = rm ? 0 : isWorking ? (Math.floor((t + seed) / 280) % 5 === 0 ? 1 : 0) : (Math.floor((t + seed * 3) / 1100) % 2 as 0 | 1);
        drawChair(ctx, d, p);
        ctx.drawImage(spriteCanvas(d.agent, { bob: bob as 0 | 1, eyes, arms: inFinal ? "up" : undefined }), d.sprite.x, d.sprite.y);
        drawDesk(ctx, d, p, { working: isWorking, t: tNow, lamp: true });
        if (isWorking && !inFinal) drawHands(ctx, d, skinOf(d.agent), shirtOf(d.agent), rm ? 0 : Math.floor((tNow + seed) / 120));
        const notes = (lane && v ? [...(v.lanes[d.agent]?.findings ?? [])] : []).map((f) => ({
          verdict: f.reviews.length === 0 ? ("pending" as const) : f.reviews.some((r) => r.verdict !== "ok") ? ("fix" as const) : ("ok" as const),
        }));
        drawNotes(ctx, d, notes, p);
        if (d.agent === CHIEF && delivered.current > 0) drawFileStack(ctx, d, delivered.current, p);
      }

      drawCat(ctx, L, tNow, p.dark, rm);

      // flying files
      const now = performance.now();
      flights.current = flights.current.filter((f) => {
        const k0 = (now - f.t0) / f.dur;
        if (k0 < 0) return true;
        if (k0 >= 1) {
          if (f.kind === "finding") delivered.current++;
          const end = f.path[f.path.length - 1]!;
          effects.current.push({ kind: "sparkle", x: end.x, y: end.y - 2, t0: now, dur: 420 });
          return false;
        }
        const kk = ease(k0);
        for (let i = 3; i >= 1; i--) {
          const q = pointAt(f, Math.max(0, kk - i * 0.025));
          ctx.fillStyle = p.goldLight;
          ctx.globalAlpha = 0.18 * (4 - i);
          ctx.fillRect(Math.round(q.x) - 1, Math.round(q.y) - 1, 2, 2);
        }
        ctx.globalAlpha = 1;
        const q = pointAt(f, kk);
        const lift = Math.round(Math.sin(kk * Math.PI) * 4);
        drawFile(ctx, q.x, q.y - lift, p, f.kind);
        return true;
      });

      // badges and sparkles
      effects.current = effects.current.filter((e) => {
        const k0 = (now - e.t0) / e.dur;
        if (k0 >= 1) return false;
        if (e.kind === "sparkle") drawSparkle(ctx, Math.round(e.x), Math.round(e.y), k0, p);
        else drawBadge(ctx, e.x, e.y - Math.round(Math.min(1, k0 * 6) * 3), e.kind === "badge-ok" ? "ok" : "bad", p, k0 < 0.08 ? 0 : 1);
        return true;
      });

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [s, layout]);

  // bubbles: what each agent is doing right now
  const bubbles = useMemo(() => {
    const out: { agent: AgentId; text: string; tool?: string; tone: "work" | "speak" | Transient["tone"] }[] = [];
    const now = Date.now();
    for (const a of AGENTS) {
      const tr = transients[a.id];
      if (tr && tr.until > now) { out.push({ agent: a.id, text: tr.text, tone: tr.tone }); continue; }
      const lane = view ? laneOf(view, a.id) : undefined;
      if (!lane || lane.phase !== "working") continue;
      const step = lane.steps[lane.steps.length - 1];
      const pending = step && !step.done ? step : undefined;
      if (a.id === CHIEF && view?.answerStarted && !view.final) out.push({ agent: a.id, text: "Writing your answer…", tone: "speak" });
      else if (pending) out.push({ agent: a.id, text: lane.status ?? lane.task ?? "", tool: pending.name, tone: "work" });
      else out.push({ agent: a.id, text: lane.status ?? lane.task ?? "Working", tone: "work" });
    }
    return out;
  }, [view, transients]);

  // keep bubbles from overlapping: lift a bubble above any earlier one it collides with. Re-run when a bubble changes
  // size too (web fonts arriving, text rewrapping), or the measurements go stale.
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

  const ready = box.w > 0;
  return (
    <div className={`office-wrap${compact ? " is-compact" : ""}`} ref={wrapRef}>
      {ready && (
        <div className="office-frame" style={{ width: cssW, height: cssH, ["--k" as string]: k }}>
          <canvas
            ref={canvasRef}
            className="office-canvas"
            width={layout.w * s}
            height={layout.h * s}
            style={{ width: cssW, height: cssH }}
            role="img"
            aria-label={`The office: ${DEPARTMENTS.length} departments, ${AGENTS.length} staff.${view?.activeAgents.length ? ` Working now: ${view.activeAgents.map(agentName).join(", ")}.` : " Everyone is at their desk."}`}
          />
          <div className="office-overlay" ref={overlayRef}>
            {layout.rooms.map((room) => {
              const active = room.agents.some((a) => view && laneOf(view, a)?.phase === "working");
              return (
                <span key={room.dept.id} className={`room-label${active ? " is-active" : ""}`} style={{ left: room.label.x * k, top: room.label.y * k, ["--hue" as string]: room.dept.hue }}>
                  {room.dept.name}
                </span>
              );
            })}
            {AGENTS.map((a) => {
              const d = layout.desks[a.id];
              if (!d) return null;
              const lane = view ? laneOf(view, a.id) : undefined;
              const phase = lane?.phase;
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`agent-hit${phase === "working" ? " is-working" : ""}${phase === "done" ? " is-done" : ""}${selected === a.id ? " is-selected" : ""}`}
                  style={{ left: (d.desk.x - 3) * k, top: (d.sprite.y + 1) * k, width: (d.desk.w + 6) * k, height: (d.desk.y + d.desk.h - d.sprite.y + 1) * k }}
                  onClick={() => onSelect(a.id)}
                  aria-label={`${a.name}, ${a.title}${phase === "working" ? `, working: ${lane?.status ?? lane?.task ?? ""}` : phase === "done" ? ", finished" : ""}. Open profile.`}
                >
                  <span className="agent-name" style={{ top: (d.desk.h + d.desk.y - d.sprite.y + 2) * k }}>
                    <span className="agent-dot" aria-hidden="true" />
                    {a.name}
                  </span>
                </button>
              );
            })}
            {!compact &&
              bubbles.map((b) => {
                const d = layout.desks[b.agent];
                if (!d) return null;
                return (
                  <div key={b.agent} className={`bubble tone-${b.tone}`} style={{ left: d.bubble.x * k, top: d.bubble.y * k }} aria-hidden="true">
                    {b.tool && <code className="bubble-tool">{b.tool}()</code>}
                    <span className="bubble-text">{b.text}</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

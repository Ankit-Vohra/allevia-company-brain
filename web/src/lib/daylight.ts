// The office's daylight: the business's own local time of day decides how the pixel office is lit. Morning sun through
// the windows, neutral midday, a golden late afternoon, dusk blue with the lamps on, then a deep indigo night. Every
// value is interpolated by the minute between keyframes, so the light never jumps. A preview override (the clock chip's
// slider) lets a demo show any hour.
import { useEffect, useSyncExternalStore } from "react";

export type DayPhase = "night" | "dawn" | "morning" | "midday" | "afternoon" | "golden" | "evening";

export const PHASE_LABEL: Record<DayPhase, string> = {
  night: "night", dawn: "dawn", morning: "morning", midday: "midday", afternoon: "afternoon", golden: "golden hour", evening: "evening",
};

type RGB = [number, number, number];

export interface Lighting {
  /** multiply layer: the ambient colour of the light (white = untouched) */
  ambient: RGB;
  /** a soft additive wash over everything (screen), e.g. warm morning light */
  wash: RGB;
  washA: number;
  /** sun patches through the windows: strength 0..1, colour, and how far they stretch (golden hour is long) */
  sun: number;
  sunColor: RGB;
  sunLen: number;
  /** -1 (morning, light falls to the right) .. 1 (evening, to the left) */
  sunSlant: number;
  /** desk lamps, cafeteria pendants and screens: 0 off .. 1 fully on */
  lamps: number;
  /** extra shadow under furniture, 0..1 (long late-afternoon shadows) */
  shadow: number;
  /** how many idle agents doze: 0 (one sleepy soul) .. 1 (night shift) */
  sleepy: number;
  /** pets curl up and sleep */
  petsAsleep: boolean;
}

interface Key { at: number; ambient: RGB; wash: RGB; washA: number; sun: number; sunColor: RGB; sunLen: number; lamps: number; shadow: number; sleepy: number }

const H = (h: number, m = 0) => h * 60 + m;
const NIGHT: RGB = [74, 84, 158];
const DEEP: RGB = [62, 70, 142];

// keyframes over a day, minutes since local midnight
const KEYS: Key[] = [
  { at: H(0), ambient: DEEP, wash: [40, 50, 120], washA: 0.05, sun: 0, sunColor: [255, 240, 210], sunLen: 1, lamps: 0.85, shadow: 0, sleepy: 1 },
  { at: H(5, 15), ambient: DEEP, wash: [40, 50, 120], washA: 0.05, sun: 0, sunColor: [255, 240, 210], sunLen: 1, lamps: 0.8, shadow: 0, sleepy: 1 },
  { at: H(6, 30), ambient: [176, 160, 196], wash: [255, 170, 150], washA: 0.08, sun: 0.25, sunColor: [255, 196, 160], sunLen: 1.5, lamps: 0.55, shadow: 0.2, sleepy: 0.7 },
  { at: H(7, 45), ambient: [252, 244, 232], wash: [255, 214, 160], washA: 0.1, sun: 0.85, sunColor: [255, 236, 190], sunLen: 1.25, lamps: 0, shadow: 0.25, sleepy: 0.2 },
  { at: H(10, 30), ambient: [255, 252, 246], wash: [255, 232, 190], washA: 0.06, sun: 0.75, sunColor: [255, 246, 214], sunLen: 1, lamps: 0, shadow: 0.15, sleepy: 0 },
  { at: H(12, 30), ambient: [255, 255, 255], wash: [255, 255, 255], washA: 0, sun: 0.5, sunColor: [255, 250, 232], sunLen: 0.7, lamps: 0, shadow: 0.08, sleepy: 0.05 },
  { at: H(15, 0), ambient: [255, 253, 248], wash: [255, 236, 200], washA: 0.03, sun: 0.6, sunColor: [255, 240, 205], sunLen: 1, lamps: 0, shadow: 0.15, sleepy: 0.15 },
  { at: H(16, 45), ambient: [255, 232, 204], wash: [255, 178, 96], washA: 0.11, sun: 1, sunColor: [255, 196, 110], sunLen: 1.8, lamps: 0, shadow: 0.45, sleepy: 0.2 },
  { at: H(17, 50), ambient: [236, 196, 186], wash: [255, 150, 110], washA: 0.1, sun: 0.75, sunColor: [255, 162, 104], sunLen: 2.2, lamps: 0.35, shadow: 0.55, sleepy: 0.25 },
  { at: H(18, 45), ambient: [148, 150, 206], wash: [120, 120, 220], washA: 0.06, sun: 0.1, sunColor: [255, 150, 120], sunLen: 2.2, lamps: 0.9, shadow: 0.2, sleepy: 0.35 },
  { at: H(20, 30), ambient: [112, 118, 186], wash: [80, 90, 190], washA: 0.05, sun: 0, sunColor: [255, 150, 120], sunLen: 1, lamps: 1, shadow: 0, sleepy: 0.55 },
  { at: H(22, 0), ambient: NIGHT, wash: [50, 60, 140], washA: 0.05, sun: 0, sunColor: [255, 240, 210], sunLen: 1, lamps: 0.9, shadow: 0, sleepy: 0.9 },
  { at: H(24), ambient: DEEP, wash: [40, 50, 120], washA: 0.05, sun: 0, sunColor: [255, 240, 210], sunLen: 1, lamps: 0.85, shadow: 0, sleepy: 1 },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smooth = (t: number) => t * t * (3 - 2 * t);

export function phaseOf(min: number): DayPhase {
  const m = ((min % 1440) + 1440) % 1440;
  if (m < H(5, 30)) return "night";
  if (m < H(7)) return "dawn";
  if (m < H(11, 30)) return "morning";
  if (m < H(14)) return "midday";
  if (m < H(16, 30)) return "afternoon";
  if (m < H(18, 15)) return "golden";
  if (m < H(21, 30)) return "evening";
  return "night";
}

export function lightingAt(min: number): Lighting {
  const m = ((min % 1440) + 1440) % 1440;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1]!.at <= m) i++;
  const a = KEYS[i]!, b = KEYS[i + 1]!;
  const t = smooth(Math.min(1, Math.max(0, (m - a.at) / Math.max(1, b.at - a.at))));
  // the sun moves across the sky: from the east in the morning to the west in the evening
  const slant = Math.max(-1, Math.min(1, (m - H(13)) / H(5)));
  const lamps = lerp(a.lamps, b.lamps, t);
  return {
    ambient: lerp3(a.ambient, b.ambient, t),
    wash: lerp3(a.wash, b.wash, t),
    washA: lerp(a.washA, b.washA, t),
    sun: lerp(a.sun, b.sun, t),
    sunColor: lerp3(a.sunColor, b.sunColor, t),
    sunLen: lerp(a.sunLen, b.sunLen, t),
    sunSlant: slant,
    lamps,
    shadow: lerp(a.shadow, b.shadow, t),
    sleepy: lerp(a.sleepy, b.sleepy, t),
    petsAsleep: m >= H(21, 30) || m < H(6, 15),
  };
}

/** Minutes since local midnight in the business's time zone. */
export function officeMinutes(timeZone?: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || undefined, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return (h % 24) * 60 + mm + now.getSeconds() / 60;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

export const fmtClock = (min: number) => {
  const m = ((Math.floor(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** The place shown on the clock chip: the business's city, else the time zone's city. */
export const placeOf = (city?: string, timeZone?: string) => city || timeZone?.split("/").pop()?.replace(/_/g, " ") || "Office";

/** The chrome's mood when the owner picked "follows the office clock". */
export const chromeMood = (min: number): "day" | "dusk" | "night" => {
  const m = ((min % 1440) + 1440) % 1440;
  if (m >= H(21) || m < H(6, 30)) return "night";
  if (m >= H(17, 30)) return "dusk";
  return "day";
};

// ---- the preview override, shared by the clock chip, the canvas and the chrome

let preview: number | null = null;
const subs = new Set<() => void>();
export function setPreviewMinutes(m: number | null) {
  preview = m === null ? null : ((m % 1440) + 1440) % 1440;
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

// a minute tick for everyone reading the real clock
let tick = 0;
const tickSubs = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | undefined;
const subscribeTick = (f: () => void) => {
  tickSubs.add(f);
  if (!tickTimer) tickTimer = setInterval(() => { tick++; tickSubs.forEach((g) => g()); }, 20_000);
  return () => {
    tickSubs.delete(f);
    if (!tickSubs.size && tickTimer) { clearInterval(tickTimer); tickTimer = undefined; }
  };
};

/** The office clock: real local minutes in the business's zone, or the preview when one is set. */
export function useOfficeClock(timeZone?: string): { minutes: number; real: number; previewing: boolean; phase: DayPhase } {
  const pv = useSyncExternalStore(subscribe, () => preview, () => null);
  useSyncExternalStore(subscribeTick, () => tick, () => 0);
  const real = officeMinutes(timeZone);
  const minutes = pv ?? real;
  return { minutes, real, previewing: pv !== null, phase: phaseOf(minutes) };
}

/** ?clock=19:30 in the URL starts the preview there (screenshots, demos). */
export function usePreviewFromUrl() {
  useEffect(() => {
    const v = new URLSearchParams(location.search).get("clock");
    const m = v?.match(/^(\d{1,2}):?(\d{2})$/);
    if (m) setPreviewMinutes(Number(m[1]) * 60 + Number(m[2]));
  }, []);
}

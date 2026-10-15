// A reel PLAN: the scenes of a short vertical reel, before anything is rendered or spent. It is the hand-off point between a
// per-company reel skill (which may write the plan) and the renderer here, so it is plain data with strict limits.
// Adapted from the founder's own reel pipeline (aamdani-social-automation: reel-scenes, reel-screens, reel-repair,
// make-reel-t0): scenes, each with what is SEEN and the few words SHOWN; the words are never drawn by a model (they are set
// by code, so they are never garbled); the hook words are on screen from the first frame; the frame is 9:16; and the plan is
// priced and stopped at a card before any credit is spent.
export type SceneVisual =
  | { kind: "asset"; assetId: string }          // a picture the owner sent or approved: free
  | { kind: "generate"; prompt: string }        // a new still from the image engine: priced, quoted first
  | { kind: "card" };                           // a plain card in the brand's colours: free

export type Motion = "in" | "out" | "up" | "down" | "still";

export interface ReelScene {
  seconds: number;              // on screen, 1.5 to 6
  onScreen: string;             // the words shown (a few, set by code)
  voiceOver?: string;           // what is said, for the script (no voice is generated)
  film?: string;                // a direction for the owner if they film it themselves
  visual: SceneVisual;
  motion?: Motion;
  clip?: boolean;               // animate this scene's still with the engine (priced) instead of a slow push
}

export interface ReelPlan {
  title: string;
  hook: string;                 // 2 to 6 words on screen from the first frame
  scenes: ReelScene[];
  caption: string;
  endCard: { logo: boolean; line?: string };
  source: "writer" | "skill";   // who wrote it: Tara's writer, or a per-company reel skill
}

export const REEL_LIMITS = { minScenes: 2, maxScenes: 6, minSeconds: 1.5, maxSeconds: 6, maxTotal: 30, endCardSeconds: 2, maxOnScreenWords: 12, maxHookWords: 6 } as const;

export class ReelPlanRejected extends Error {
  override name = "ReelPlanRejected";
}

const words = (s: string): number => (s.trim().match(/\S+/g) ?? []).length;
const str = (v: unknown, n: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

// A plan from anywhere (a skill's JSON, the writer's answer) made safe: known fields only, limits enforced, the reason
// said plainly when it cannot be used.
export function normaliseReelPlan(raw: unknown, source: ReelPlan["source"]): ReelPlan {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawScenes = Array.isArray(o.scenes) ? o.scenes : [];
  if (rawScenes.length < REEL_LIMITS.minScenes) throw new ReelPlanRejected(`a reel needs at least ${REEL_LIMITS.minScenes} scenes`);
  const scenes: ReelScene[] = rawScenes.slice(0, REEL_LIMITS.maxScenes).map((x, i) => {
    const s = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const onScreen = str(s.onScreen, 120);
    if (words(onScreen) > REEL_LIMITS.maxOnScreenWords) throw new ReelPlanRejected(`scene ${i + 1} has too many words on screen (${words(onScreen)}); keep it to ${REEL_LIMITS.maxOnScreenWords}`);
    const v = (s.visual && typeof s.visual === "object" ? s.visual : { kind: "card" }) as Record<string, unknown>;
    const visual: SceneVisual = v.kind === "asset" && typeof v.assetId === "string" && /^asset:/.test(v.assetId) ? { kind: "asset", assetId: v.assetId }
      : v.kind === "generate" && typeof v.prompt === "string" && v.prompt.trim() ? { kind: "generate", prompt: str(v.prompt, 500) } : { kind: "card" };
    const motion = (["in", "out", "up", "down", "still"] as const).find((m) => m === s.motion) ?? (["in", "up", "out", "down"] as const)[i % 4];
    const seconds = Math.max(REEL_LIMITS.minSeconds, Math.min(REEL_LIMITS.maxSeconds, Number(s.seconds) || 3));
    return {
      seconds: Math.round(seconds * 10) / 10, onScreen, visual, motion,
      ...(str(s.voiceOver, 300) ? { voiceOver: str(s.voiceOver, 300) } : {}), ...(str(s.film, 300) ? { film: str(s.film, 300) } : {}), ...(s.clip === true ? { clip: true } : {}),
    };
  });
  const total = scenes.reduce((n, s) => n + s.seconds, 0) + REEL_LIMITS.endCardSeconds;
  if (total > REEL_LIMITS.maxTotal) throw new ReelPlanRejected(`the reel would run ${Math.round(total)} seconds; keep it to ${REEL_LIMITS.maxTotal}`);
  const hook = str(o.hook, 80) || scenes[0]!.onScreen.split(/\s+/).slice(0, REEL_LIMITS.maxHookWords).join(" ");
  if (words(hook) > REEL_LIMITS.maxHookWords) throw new ReelPlanRejected(`the hook is ${words(hook)} words; keep it to ${REEL_LIMITS.maxHookWords}`);
  const end = (o.endCard && typeof o.endCard === "object" ? o.endCard : {}) as Record<string, unknown>;
  return {
    title: str(o.title, 80) || "Reel", hook, scenes, caption: str(o.caption, 1500),
    endCard: { logo: end.logo !== false, ...(str(end.line, 80) ? { line: str(end.line, 80) } : {}) }, source,
  };
}

export const planSeconds = (p: ReelPlan): number => Math.round((p.scenes.reduce((n, s) => n + s.seconds, 0) + REEL_LIMITS.endCardSeconds) * 10) / 10;

// Every word the reel shows, for the claims check before rendering.
export const planWords = (p: ReelPlan): Array<{ role: string; text: string }> => [
  { role: "hook", text: p.hook }, ...p.scenes.map((s, i) => ({ role: `scene ${i + 1}`, text: s.onScreen })),
  ...(p.endCard.line ? [{ role: "end card", text: p.endCard.line }] : []),
];

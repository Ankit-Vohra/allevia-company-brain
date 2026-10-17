// Where the hero's brain sits, worked out in one place so the still picture (main.ts, at first paint) and the 3D scene (hero3d.ts, once it
// has loaded) agree to the pixel: the brain never jumps when the scene starts, and the orbits never run over the words.
// Units: W and H are the hero stage's size in px; `copyRight` is how far the words reach from the stage's left edge.

/** The widest orbit line from the brain's centre, in stage heights, at scale 1 (measured from the scene's orbits and camera). */
const REACH = 0.4248;
/** The brain's radius in stage heights at scale 1. */
const RADIUS = 0.2038;

export interface HeroLayout {
  /** Words on the left, brain on the right (the stacked phone layout has the brain under the words and centred). */
  wide: boolean;
  /** Centre of the brain in stage px. */
  cx: number;
  cy: number;
  /** World scale for the 3D scene: 1 where the orbits fit beside the words, less where they would run over them. */
  scale: number;
  /** The brain's radius in px divided by 100 (what the stage's `--k` holds). */
  k: number;
}

export function heroLayout(W: number, H: number, copyRight: number, phone: boolean): HeroLayout {
  const wide = W / H > 1.25 && W > 820;
  if (!wide) {
    const scale = Math.max(0.5, Math.min(1, (W / H) * 0.95) * (phone ? 0.92 : 1));
    return { wide, cx: W / 2, cy: H / 2, scale, k: (RADIUS * H * scale) / 100 };
  }
  const left = copyRight + 18, right = W - 14;
  const half1 = REACH * H + 26; // the orbit lines plus half a chip
  const avail = right - left;
  const scale = 2 * half1 > avail ? Math.max(0.6, avail / (2 * half1)) : 1;
  const half = half1 * scale;
  // the brain likes to sit two thirds of the way across; it moves only as far as it must to keep clear of the words and inside the page
  const cx = Math.min(Math.max(W * 0.67, left + half), right - half);
  return { wide, cx, cy: H / 2, scale, k: (RADIUS * H * scale) / 100 };
}

/** How far right the hero's words reach, measured on the text itself (not its box), from the stage's left edge. */
export function copyExtent(root: HTMLElement, stageLeft: number): number {
  let right = 0;
  const range = document.createRange();
  for (const el of root.querySelectorAll<HTMLElement>(".hero__h1, .hero__sub")) {
    range.selectNodeContents(el);
    for (const rc of range.getClientRects()) right = Math.max(right, rc.right);
  }
  return Math.max(0, right - stageLeft);
}

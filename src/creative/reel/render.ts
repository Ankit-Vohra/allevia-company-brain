// Rendering a reel plan into a short vertical reel DRAFT (1080x1920, 30 fps, MP4), the founder's tier-0 approach adapted to
// Allevia: every scene is a still (a picture the owner approved, a new still from the engine, or a card in the brand's
// colours) given a slow push with ffmpeg, or (priced, agreed) a short clip the engine animated from that still. The words are
// set by code on a shade inside the story-safe band, the hook words are on screen from the first frame, and the reel ends on a
// card with the owner's real logo. Then it is CHECKED and, when something is wrong, REPAIRED the cheapest way first:
//   check  - the file is probed (size, length, frame rate), one frame per scene is read back by Fact Checker (vision) against the
//            words that were set, and the end card must show the logo;
//   repair - a scene whose generated picture came back with lettering or a defect is swapped for a brand card (free) and the
//            reel is assembled again (ffmpeg, free); it is checked once more. Nothing is regenerated without a new OK.
// There is no sound: the script's spoken lines are for the owner to record, or to add music in Instagram (said on the card).
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { BrandForCompose, PosterManifest } from "../compose/compose.js";
import { checkPosters, type OptionVerdict } from "../compose/check.js";
import { contrast, readableOn } from "../compose/palette.js";
import { coversText, drawText, fitText, type LoadedFont } from "../compose/type.js";
import type { VisionRunner } from "../../studio/vision.js";
import { REEL_LIMITS, type Motion, type ReelPlan } from "./plan.js";

export const REEL_W = 1080;
export const REEL_H = 1920;
export const REEL_FPS = 30;
export const SAFE_TOP = 250;      // Instagram draws the profile bar above this
export const SAFE_BOTTOM = 400;   // ... and the caption and buttons below REEL_H - this

export interface ReelVideo {
  available(): Promise<boolean>;
  run(args: string[], timeoutMs?: number): Promise<void>;
}

export function realReelVideo(bin = process.env.ALLEVIA_FFMPEG || "ffmpeg"): ReelVideo {
  let has: Promise<boolean> | undefined;
  const run = (args: string[], timeoutMs = 240_000) => new Promise<void>((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 << 20, shell: false }, (e, _o, err) => (e ? reject(new Error(`ffmpeg: ${String(err).slice(-300)}`)) : resolve()));
  });
  return { available: () => (has ??= run(["-version"], 10_000).then(() => true, () => false)), run };
}

// What each scene is drawn from, once resolved: a still (bytes) and, optionally, a clip the engine made from it.
export interface ResolvedScene { still: Buffer; clip?: Buffer; generated: boolean; focus?: { x: number; y: number } } // focus: push in to this point (0..1)

const pick = (b: BrandForCompose, which: "heading" | "body", bold: boolean): LoadedFont => {
  const p = b[which];
  const f = bold ? p.bold ?? p.regular : p.regular ?? p.bold;
  if (!f) throw new Error("no font for the reel");
  return f;
};

// A picture fitted to the full width of a 9:16 frame over a blurred copy of itself: nothing cropped, nothing stretched.
export async function fitVertical(img: Buffer): Promise<Buffer> {
  const fill = await sharp(img).resize(REEL_W, REEL_H, { fit: "cover" }).blur(40).modulate({ brightness: 0.7 }).png().toBuffer();
  const fg = await sharp(img).resize({ width: REEL_W, height: REEL_H, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
  return sharp(fill).composite([{ input: fg.data, left: Math.round((REEL_W - fg.info.width) / 2), top: Math.round((REEL_H - fg.info.height) / 2) }]).png().toBuffer();
}

// A photo filling the whole 9:16 frame, cropped around what sharp's attention finder keeps (a reel is full-bleed; a letterbox
// over a blur reads as a slideshow).
export async function fillVertical(img: Buffer): Promise<Buffer> {
  return sharp(img).rotate().resize(REEL_W, REEL_H, { fit: "cover", position: sharp.strategy.attention }).png().toBuffer();
}

export async function brandCard(b: BrandForCompose): Promise<Buffer> {
  const p = b.palette;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${REEL_W}" height="${REEL_H}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.dark}"/><stop offset="1" stop-color="${p.accent}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export interface Overlay { png: Buffer; texts: PosterManifest["texts"]; timed?: Array<{ png: Buffer; from: number; to: number }> } // timed: words revealed group by group

// The words of one scene: a block on a soft shade in the lower part of the safe band, and on the first scene the hook in a
// box near the top (the founder's "boxes" style: readable muted on any picture).
export async function sceneOverlay(b: BrandForCompose, o: { onScreen: string; hook?: string }): Promise<Overlay> {
  const p = b.palette;
  let svg = "";
  const texts: PosterManifest["texts"] = [];
  const m = 76, w = REEL_W - 2 * m;
  if (o.onScreen.trim()) {
    const f = pick(b, "heading", true);
    if (!coversText(f, o.onScreen)) throw new Error(`the font ${f.family} has no letters for "${o.onScreen.slice(0, 30)}"`);
    const fit = fitText(o.onScreen, { font: f, lineHeight: 1.08 }, { w, h: 420 }, { max: 96, min: 48, maxLines: 4 });
    if (!fit.ok) throw new Error(`the words "${o.onScreen.slice(0, 40)}" don't fit on the screen; shorten them`);
    const y = REEL_H - SAFE_BOTTOM - fit.layout.height - 60;
    svg += `<rect x="0" y="${y - 70}" width="${REEL_W}" height="${fit.layout.height + 150}" fill="${p.dark}" fill-opacity="0.55"/>`;
    const d = drawText(fit.layout, { font: f, size: fit.size, color: p.light, lineHeight: 1.08 }, m, y, w);
    svg += d.svg;
    texts.push({ role: "on screen", text: o.onScreen, shown: d.lines.join(" "), box: d.box, size: fit.size, font: f.family, color: p.light, lines: d.lines });
  }
  if (o.hook?.trim()) {
    const f = pick(b, "body", true);
    const fit = fitText(o.hook, { font: f }, { w: w - 60, h: 180 }, { max: 64, min: 36, maxLines: 2 });
    if (!fit.ok) throw new Error(`the hook "${o.hook}" doesn't fit; shorten it`);
    const boxW = fit.layout.width + 60, boxH = fit.layout.height + 50, y = SAFE_TOP + 40;
    const fill = contrast(p.light, p.dark) > 4.5 ? p.light : "#ffffff";
    svg += `<rect x="${m}" y="${y}" width="${boxW}" height="${boxH}" rx="14" fill="${fill}"/>`;
    const ink = readableOn(fill, p.dark, "#000000");
    const d = drawText(fit.layout, { font: f, size: fit.size, color: ink }, m + 30, y + 25, fit.layout.width);
    svg += d.svg;
    texts.push({ role: "hook", text: o.hook, shown: d.lines.join(" "), box: { x: m, y, w: boxW, h: boxH }, size: fit.size, font: f.family, color: ink, lines: d.lines });
  }
  const png = await sharp({ create: { width: REEL_W, height: REEL_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${REEL_W}" height="${REEL_H}">${svg}</svg>`), left: 0, top: 0 }]).png().toBuffer();
  return { png, texts };
}

// The last card: the paper colour, the owner's real logo (or the name in the brand font, said so), and an optional line.
export async function endCard(b: BrandForCompose, line?: string): Promise<{ png: Buffer; texts: PosterManifest["texts"]; logo: "file" | "wordmark" }> {
  const p = b.palette;
  const layers: OverlayOptions[] = [];
  const texts: PosterManifest["texts"] = [];
  let svg = "";
  let logo: "file" | "wordmark" = "wordmark";
  if (b.logo) {
    const t = await sharp(b.logo.bytes).trim({ threshold: 8 }).png().toBuffer().catch(() => b.logo!.bytes);
    const lg = await sharp(t).resize({ width: 640, height: 300, fit: "inside", withoutEnlargement: false }).png().toBuffer({ resolveWithObject: true });
    layers.push({ input: lg.data, left: Math.round((REEL_W - lg.info.width) / 2), top: Math.round(REEL_H * 0.42 - lg.info.height / 2) });
    logo = "file";
  } else {
    const f = pick(b, "heading", true);
    const fit = fitText(b.businessName, { font: f, align: "center" }, { w: 900, h: 220 }, { max: 120, min: 48, maxLines: 2 });
    const d = drawText(fit.layout, { font: f, size: fit.size, color: p.dark, align: "center" }, 90, REEL_H * 0.42 - fit.layout.height / 2, 900);
    svg += d.svg;
  }
  if (line?.trim()) {
    const f = pick(b, "body", false);
    const fit = fitText(line, { font: f, align: "center" }, { w: 900, h: 200 }, { max: 52, min: 30, maxLines: 3 });
    if (fit.ok) {
      const d = drawText(fit.layout, { font: f, size: fit.size, color: p.dark, align: "center" }, 90, REEL_H * 0.42 + 220, 900);
      svg += d.svg;
      texts.push({ role: "end card", text: line, shown: d.lines.join(" "), box: d.box, size: fit.size, font: f.family, color: p.dark, lines: d.lines });
    }
  }
  if (svg) layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${REEL_W}" height="${REEL_H}">${svg}</svg>`), left: 0, top: 0 });
  const png = await sharp({ create: { width: REEL_W, height: REEL_H, channels: 3, background: p.paper } }).composite(layers).png().toBuffer();
  return { png, texts, logo };
}

// The slow push for one scene (zoompan counts output frames, so the travel spans the whole scene). With a focus point the
// camera pushes in on it (a real app screen: towards the part the line is about), eased, to 1.45x.
export function zoompan(motion: Motion, seconds: number, focus?: { x: number; y: number }): string {
  const frames = Math.max(1, Math.round(seconds * REEL_FPS)), t = 0.08, s = `${REEL_W}x${REEL_H}`;
  if (focus) {
    const p = `(1-cos(PI*min(1,on/${frames})))/2`;
    return `zoompan=z='1+0.45*${p}':x='max(0,min(iw-iw/zoom,${focus.x.toFixed(3)}*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${focus.y.toFixed(3)}*ih-ih/zoom/2))':d=1:s=${s}:fps=${REEL_FPS}`;
  }
  switch (motion) {
    case "in": return `zoompan=z='1+${t}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${s}:fps=${REEL_FPS}`;
    case "out": return `zoompan=z='${1 + t}-${t}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${s}:fps=${REEL_FPS}`;
    case "up": return `zoompan=z='${1 + t}':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/${frames})':d=1:s=${s}:fps=${REEL_FPS}`;
    case "down": return `zoompan=z='${1 + t}':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(on/${frames})':d=1:s=${s}:fps=${REEL_FPS}`;
    default: return `scale=${s},fps=${REEL_FPS}`;
  }
}

export interface AssembleInput { plan: ReelPlan; scenes: ResolvedScene[]; overlays: Overlay[]; end: Buffer; music?: Buffer }

// One ffmpeg pass: every scene (still with its push, or the engine's clip cut to length) under its words, then the end card.
export async function assemble(video: ReelVideo, a: AssembleInput): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "allevia-reel-"));
  try {
    const args: string[] = ["-v", "error", "-y"];
    const filters: string[] = [];
    let input = 0;
    const labels: string[] = [];
    a.plan.scenes.forEach((s, i) => {
      const r = a.scenes[i]!;
      const ov = join(dir, `over-${i}.png`);
      writeFileSync(ov, a.overlays[i]!.png);
      let base: string;
      if (r.clip) {
        const clip = join(dir, `clip-${i}.mp4`);
        writeFileSync(clip, r.clip);
        args.push("-i", clip);
        base = `[${input}:v]scale=${REEL_W}:${REEL_H}:force_original_aspect_ratio=increase,crop=${REEL_W}:${REEL_H},fps=${REEL_FPS},trim=duration=${s.seconds},setpts=PTS-STARTPTS`;
      } else {
        const still = join(dir, `still-${i}.png`);
        writeFileSync(still, r.still);
        args.push("-loop", "1", "-framerate", String(REEL_FPS), "-t", String(s.seconds), "-i", still);
        base = `[${input}:v]${zoompan(s.motion ?? "in", s.seconds, r.focus)},trim=duration=${s.seconds},setpts=PTS-STARTPTS`;
      }
      input++;
      const timed = a.overlays[i]!.timed;
      if (timed?.length) {
        // the words revealed group by group: each group's picture shown only between its times
        filters.push(`${base},format=yuva420p[b${i}_0]`);
        timed.forEach((t, k) => {
          const f = join(dir, `over-${i}-${k}.png`);
          writeFileSync(f, t.png);
          args.push("-loop", "1", "-framerate", String(REEL_FPS), "-t", String(s.seconds), "-i", f);
          filters.push(`[b${i}_${k}][${input}:v]overlay=0:0:enable='between(t,${t.from.toFixed(2)},${t.to.toFixed(2)})'[b${i}_${k + 1}]`);
          input++;
        });
        filters.push(`[b${i}_${timed.length}]format=yuv420p,setsar=1[s${i}]`);
      } else {
        args.push("-loop", "1", "-framerate", String(REEL_FPS), "-t", String(s.seconds), "-i", ov);
        filters.push(`${base}[b${i}]`, `[b${i}][${input}:v]overlay=0:0:shortest=1,format=yuv420p,setsar=1[s${i}]`);
        input++;
      }
      labels.push(`[s${i}]`);
    });
    const end = join(dir, "end.png");
    writeFileSync(end, a.end);
    args.push("-loop", "1", "-framerate", String(REEL_FPS), "-t", String(REEL_LIMITS.endCardSeconds), "-i", end);
    filters.push(`[${input}:v]scale=${REEL_W}:${REEL_H},fps=${REEL_FPS},format=yuv420p,setsar=1[e]`);
    input++;
    labels.push("[e]");
    filters.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[out]`);
    const out = join(dir, "reel.mp4");
    const total = a.plan.scenes.reduce((n, s) => n + s.seconds, 0) + REEL_LIMITS.endCardSeconds;
    let audio: string[] = [];
    if (a.music) {
      // the music bed: trimmed to the reel, faded in and out, at a social level (-16 LUFS)
      const m = join(dir, "music.audio");
      writeFileSync(m, a.music);
      args.push("-i", m);
      filters.push(`[${input}:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1.2,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
      input++;
      audio = ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k", "-shortest"];
    }
    args.push("-filter_complex", filters.join(";"), "-map", "[out]", ...audio, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(REEL_FPS), "-movflags", "+faststart", out);
    await video.run(args);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One frame of the reel at a time t, as a JPEG (for the check).
export async function frameAt(video: ReelVideo, mp4: Buffer, t: number): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "allevia-reel-frame-"));
  try {
    writeFileSync(join(dir, "r.mp4"), mp4);
    await video.run(["-v", "error", "-y", "-ss", t.toFixed(2), "-i", join(dir, "r.mp4"), "-frames:v", "1", "-q:v", "3", join(dir, "f.jpg")], 60_000);
    return readFileSync(join(dir, "f.jpg"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Fact Checker reads one frame per scene and the end card against the words that were set there.
export async function checkReel(video: ReelVideo, mp4: Buffer, a: { plan: ReelPlan; overlays: Overlay[]; endTexts: PosterManifest["texts"]; endLogo: "file" | "wordmark"; brand: BrandForCompose }, vision: VisionRunner): Promise<OptionVerdict[]> {
  const frames: Array<{ label: string; image: Buffer; manifest: PosterManifest }> = [];
  let t = 0;
  const base = (texts: PosterManifest["texts"], logo: "file" | "wordmark", inHeadline: boolean): PosterManifest => ({
    format: "insta_story", layout: "type-only", width: REEL_W, height: REEL_H, texts, artwork: true, problems: [],
    logo: { kind: logo, box: { x: 0, y: 0, w: 0, h: 0 }, plate: false, scale: 1, sourceW: 0, soft: false, ...(inHeadline ? { inHeadline: true } : {}) },
    colours: { paper: a.brand.palette.paper, dark: a.brand.palette.dark, accent: a.brand.palette.accent, light: a.brand.palette.light, background: a.brand.palette.dark },
    fonts: { heading: "", body: "" },
  });
  for (const [i, s] of a.plan.scenes.entries()) {
    // a revealed line is whole by 70% of its scene, and the hook is gone by 2.6 s: look when every word that should be there is
    const timed = !!a.overlays[i]!.timed?.length;
    const at = timed ? s.seconds * 0.9 : s.seconds * 0.6;
    const texts = a.overlays[i]!.texts.filter((x) => !(timed && x.role === "hook" && at > 2.6));
    frames.push({ label: `S${i + 1}`, image: await frameAt(video, mp4, t + at), manifest: base(texts, "wordmark", true) });
    t += s.seconds;
  }
  frames.push({ label: "END", image: await frameAt(video, mp4, t + REEL_LIMITS.endCardSeconds * 0.5), manifest: base(a.endTexts, a.endLogo, false) });
  // a scene frame has no logo of its own: only the end card is held to showing it
  const verdicts = await checkPosters(frames, { businessName: a.brand.businessName, hasLogoFile: a.endLogo === "file" }, { vision });
  return verdicts;
}

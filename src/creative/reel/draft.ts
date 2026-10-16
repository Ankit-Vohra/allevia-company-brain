// A reel plan becomes a reel DRAFT, priced before anything is spent, checked and repaired after it is made:
//   1. claims  - every word the reel shows is grounded in the owner's request or the business record (as on posters);
//   2. price   - generated stills and engine clips are QUOTED; anything that costs credits waits for the owner's OK
//                (confirmSpend), the way the founder's pipeline stops at a card before paying for clips;
//   3. make    - each scene's picture (an approved picture, a new still, or a brand card), the words set by code, the
//                slow push or the agreed clip, the end card with the real logo, one ffmpeg pass;
//   4. check   - Nisha reads a frame of each scene and the end card against the words that were set;
//   5. repair  - the cheapest fix first: a generated still that came back with lettering or a defect is swapped for a
//                brand card and the reel is assembled again (free); then checked once more;
//   6. save    - Asset{kind: clip} with lineage (the pictures it used, the logo, the fonts) and a card for the owner's OK.
// Everything that could not be done is said plainly, and the rest is still delivered. Never a fake result.
import sharp from "sharp";
import type { GraphHandle } from "../../graph/client.js";
import { groundClaims, type OptionVerdict } from "../compose/check.js";
import { saveDeliverable, type SaveDeps, type SavedDeliverable } from "../deliverable.js";
import { loadComposeKit } from "../kit.js";
import { EngineUnavailable, type CreativeDeps } from "../ports.js";
import { planSeconds, planWords, type ReelPlan } from "./plan.js";
import { assemble, brandCard, checkReel, endCard, fillVertical, REEL_H, REEL_W, sceneOverlay, type Overlay, type ReelVideo, type ResolvedScene } from "./render.js";
import { endCardHtml, sceneWords, screenFrame } from "./motion.js";
import { designSystem } from "../design/system.js";
import { sharedRenderer } from "../design/render.js";
import { screenPicture } from "../design/material.js";

const chromiumMissing = (e: unknown): boolean => e instanceof Error && /Executable doesn't exist|browserType\.launch|Failed to launch|playwright install/i.test(e.message);

export interface ReelDraftJob {
  tenant: string; businessId: string; agentId: string; turnId: string; now: number;
  question: string;               // the owner's words (and the idea): what the reel's words may be grounded in
  plan: ReelPlan;
  confirmSpend: boolean;          // the owner agreed to the quoted price
}

export interface ReelDraftResult {
  status: "made" | "priced" | "no_video" | "refused";
  why?: string;
  priceCredits: number;           // what the plan costs in image-engine credits (0: everything is free)
  spentCredits: number;
  seconds: number;
  saved?: SavedDeliverable;
  verdicts: OptionVerdict[];
  repaired: string[];             // what the repair pass changed
  notes: string[];
}

const QUOTE_UNKNOWN = 3;

export async function makeReelDraft(g: GraphHandle, job: ReelDraftJob, deps: CreativeDeps & { video?: ReelVideo | null }): Promise<ReelDraftResult> {
  const plan = { ...job.plan, scenes: job.plan.scenes.map((s) => ({ ...s })) };
  const notes: string[] = [];
  const seconds = planSeconds(plan);
  const base: ReelDraftResult = { status: "refused", priceCredits: 0, spentCredits: 0, seconds, verdicts: [], repaired: [], notes };
  const kit = await loadComposeKit(g, job.businessId, { store: deps.store, tenant: job.tenant, businessId: job.businessId, fetchMissingFonts: deps.fonts?.fetchMissing ?? false, now: job.now });
  notes.push(...kit.notes.filter((n) => /logo|font/i.test(n)));

  // 1. the words
  const bad = groundClaims(planWords(plan), { request: job.question, facts: kit.facts });
  if (bad.length) return { ...base, why: `I won't put ${bad.slice(0, 3).map((b) => `"${b.claim}" (${b.role})`).join(", ")} in the reel: it isn't in what you asked for or in what I know about the business.` };
  const video = deps.video;
  if (!video || !(await video.available())) return { ...base, status: "no_video", why: "this server can't make video yet (the video tool, ffmpeg, isn't installed), so I wrote the script and the scenes only" };

  // 2. the price, before anything is spent
  const engine = deps.engine;
  const st = engine ? await engine.status().catch(() => ({ ok: false as const, plain: "the image engine did not answer" })) : { ok: false as const, plain: "no image engine is set up on this server" };
  let price = 0;
  for (const [i, s] of plan.scenes.entries()) {
    if (s.visual.kind === "generate") {
      if (!st.ok) { notes.push(`Scene ${i + 1} uses a brand card instead of a new picture: ${st.plain ?? "the image engine is not available"}.`); s.visual = { kind: "card" }; }
      else price += (await engine!.quote({ prompt: s.visual.prompt, aspect: "9:16" }).catch(() => null)) ?? QUOTE_UNKNOWN;
    }
    if (s.clip) {
      if (!st.ok || !engine?.animate) { notes.push(`Scene ${i + 1} gets a slow push instead of a clip: ${!st.ok ? st.plain ?? "the image engine is not available" : "this engine can't make clips"}.`); delete s.clip; }
      else price += (await engine.quoteClip?.({ seconds: s.seconds, aspect: "9:16" }).catch(() => null)) ?? QUOTE_UNKNOWN * 2;
    }
  }
  let musicPrice: number | null = null;
  if (plan.music) {
    if (!st.ok || !engine?.music) { notes.push(`No music bed: ${!st.ok ? st.plain ?? "the engine is not available" : "this engine can't make music"}. Add a sound in Instagram before posting.`); delete plan.music; }
    else { musicPrice = (await engine.quoteMusic?.({ prompt: plan.music, seconds: seconds }).catch(() => null)) ?? 1; price += musicPrice; }
  }
  price = Math.round(price * 100) / 100;
  if (price > 0 && !job.confirmSpend) return { ...base, status: "priced", priceCredits: price, why: `this reel would cost ${price} image credits (new pictures or clips); say OK and I'll make it, or use your own approved pictures for free` };
  const room = deps.maxCreditsPerRequest - (deps.spent?.credits ?? 0);
  if (price > room) return { ...base, status: "priced", priceCredits: price, why: `this reel would cost ${price} credits, more than one request may use (${deps.maxCreditsPerRequest}); use fewer new pictures or your own approved pictures` };

  // 3. the pictures, the words, the end card
  const card = await brandCard(kit.brand);
  const resolved: ResolvedScene[] = [];
  const parents: string[] = [];
  let spent = 0;
  for (const [i, s] of plan.scenes.entries()) {
    let still = card, generated = false, raw: Buffer | undefined;
    let focus: ResolvedScene["focus"];
    if (s.visual.kind === "asset") {
      // an approved picture, or a photo from the brand library (the business's own work)
      const [row] = await g.roQuery<{ key: string | null; status: string | null }>("MATCH (a:Entity {id:$id}) WHERE a:Asset OR a:BrandAsset RETURN a.storageKey AS key, a.status AS status", { id: s.visual.assetId });
      const bytes = row?.key ? deps.store.get(job.tenant, row.key) : null;
      if (bytes) { raw = bytes; still = await fillVertical(bytes); parents.push(s.visual.assetId); }
      else notes.push(`Scene ${i + 1}'s picture isn't in your library any more, so it uses a brand card.`);
    } else if (s.visual.kind === "screen") {
      // a real app screen in a phone, the camera pushing in on the part the line is about
      const [row] = await g.roQuery<{ key: string | null; crop: string | null; focus: string | null }>("MATCH (a:Entity:BrandAsset {id:$id}) RETURN a.storageKey AS key, a.crop AS crop, a.focus AS focus", { id: s.visual.assetId });
      const bytes = row?.key ? deps.store.get(job.tenant, row.key) : null;
      const parse = (x: string | null) => { try { return x ? JSON.parse(x) : undefined; } catch { return undefined; } };
      if (bytes) {
        try {
          const ds = await designSystem(kit.brand, kit.colours, "insta_story", kit.named);
          const pic = await screenPicture(bytes, { id: s.visual.assetId, ...(parse(row!.crop) ? { crop: parse(row!.crop) } : {}), ...(parse(row!.focus) ? { focus: parse(row!.focus) } : {}) });
          const fr = await screenFrame(ds, deps.renderer ?? sharedRenderer(), pic);
          still = fr.png; focus = fr.focus; parents.push(s.visual.assetId);
        } catch (e) {
          if (!chromiumMissing(e)) throw e;
          still = await fillVertical(bytes);
        }
      } else notes.push(`Scene ${i + 1}'s app screen isn't in your library any more, so it uses a brand card.`);
    } else if (s.visual.kind === "generate" && engine) {
      try {
        const img = await engine.generate({ prompt: `${s.visual.prompt}. One continuous photograph, 9:16, no text, no letters, no logos, no watermarks.`, aspect: "9:16" });
        if (img.credits) { spent += img.credits; if (deps.spent) deps.spent.credits += img.credits; }
        raw = img.image; still = await fillVertical(img.image); generated = true;
      } catch (e) {
        notes.push(`Scene ${i + 1}'s new picture wasn't made (${e instanceof EngineUnavailable ? e.plain : "the engine failed"}), so it uses a brand card.`);
      }
    }
    let clip: Buffer | undefined;
    if (s.clip && engine?.animate && raw) {
      try {
        // the clip starts from the scene's own 9:16 frame, so the motion matches what the reel shows
        const c = await engine.animate({ image: await sharp(still).jpeg({ quality: 92 }).toBuffer(), prompt: `${s.film ? `${s.film}. ` : ""}A slow, steady camera move on this exact picture; the room, furniture and light stay exactly as they are; nothing added, nothing changed, no people, no lettering.`, seconds: Math.max(5, Math.ceil(s.seconds)), aspect: "9:16" });
        if (c.credits) { spent += c.credits; if (deps.spent) deps.spent.credits += c.credits; }
        clip = c.video;
      } catch (e) {
        notes.push(`Scene ${i + 1}'s clip wasn't made (${e instanceof EngineUnavailable ? e.plain : "the engine failed"}), so it has a slow push instead.`);
      }
    }
    resolved.push({ still, generated, ...(clip ? { clip } : {}), ...(focus ? { focus } : {}) });
  }
  // the words: revealed a few at a time in the brand's own fonts (HTML in Chromium); the simpler SVG overlay where it can't run
  let overlays: Overlay[];
  let end: { png: Buffer; texts: Overlay["texts"]; logo: "file" | "wordmark" };
  try {
    const ds = await designSystem(kit.brand, kit.colours, "insta_story", kit.named);
    const renderer = deps.renderer ?? sharedRenderer();
    const blank = await sharp({ create: { width: REEL_W, height: REEL_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    overlays = [];
    for (const [i, s] of plan.scenes.entries()) {
      const w = await sceneWords(ds, renderer, { text: s.onScreen, seconds: s.seconds, ...(i === 0 ? { hook: plan.hook } : {}) });
      overlays.push({ png: blank, texts: w.texts, timed: w.timed });
    }
    end = await endCardHtml(ds, renderer, { ...(plan.endCard.line ? { line: plan.endCard.line } : {}) });
  } catch (e) {
    if (!chromiumMissing(e)) throw e;
    overlays = await Promise.all(plan.scenes.map((s, i) => sceneOverlay(kit.brand, { onScreen: s.onScreen, ...(i === 0 ? { hook: plan.hook } : {}) })));
    end = await endCard(kit.brand, plan.endCard.line);
  }
  let music: Buffer | undefined;
  if (plan.music && engine?.music) {
    try {
      const m = await engine.music({ prompt: `${plan.music}. Instrumental only, no vocals, no lyrics.`, seconds: Math.ceil(seconds) });
      if (m.credits) { spent += m.credits; if (deps.spent) deps.spent.credits += m.credits; }
      music = m.audio;
    } catch (e) {
      notes.push(`The music bed wasn't made (${e instanceof EngineUnavailable ? e.plain : "the engine failed"}): add a sound in Instagram before posting.`);
    }
  }

  // 4. assemble and check; 5. repair the cheapest way and check once more
  let mp4 = await assemble(video, { plan, scenes: resolved, overlays, end: end.png, ...(music ? { music } : {}) });
  let verdicts = await checkReel(video, mp4, { plan, overlays, endTexts: end.texts, endLogo: end.logo, brand: kit.brand }, deps.vision);
  const repaired: string[] = [];
  const fixable = verdicts.filter((v) => v.badge === "held" && /^S\d+$/.test(v.label)).map((v) => Number(v.label.slice(1)) - 1).filter((i) => resolved[i]?.generated || resolved[i]?.clip);
  if (fixable.length) {
    for (const i of fixable) { resolved[i] = { still: card, generated: false }; repaired.push(`scene ${i + 1}: the new picture had ${verdicts.find((v) => v.label === `S${i + 1}`)!.reasons.join("; ")}, so it was swapped for a brand card`); }
    mp4 = await assemble(video, { plan, scenes: resolved, overlays, end: end.png, ...(music ? { music } : {}) });
    verdicts = await checkReel(video, mp4, { plan, overlays, endTexts: end.texts, endLogo: end.logo, brand: kit.brand }, deps.vision);
  }
  const held = verdicts.filter((v) => v.badge === "held");
  const unchecked = verdicts.some((v) => v.badge === "unchecked");
  const badge = held.length ? "held" : unchecked ? "unchecked" : "ok";
  const note = held.length ? held.map((v) => `${v.label}: ${v.reasons.join("; ")}`).join(" | ")
    : unchecked ? "Not double-checked: watch it before approving." : `Checked: the words on every scene and the end card are right${repaired.length ? " (after a repair)" : ""}.`;
  if (!music) notes.push("The draft has no sound: record the lines yourself or add music in Instagram before posting.");

  // 6. save
  const saveDeps: SaveDeps = { store: deps.store, tenant: job.tenant, agentId: job.agentId, turnId: job.turnId, now: job.now };
  const script = plan.scenes.map((s, i) => [`Scene ${i + 1} (${s.seconds} s): on screen "${s.onScreen}"`, s.voiceOver ? `says "${s.voiceOver}"` : "", s.film ? `film: ${s.film}` : ""].filter(Boolean).join(" · ")).join("\n");
  const saved = await saveDeliverable(g, saveDeps, {
    kind: "clip", title: `Reel draft: ${plan.title}`, caption: `${plan.caption}\n\n${script}`.trim(), altText: `A ${seconds}-second vertical reel: ${plan.hook}.`, aspect: "9:16", channel: "instagram", format: "reel",
    request: job.question, notes, hfCredits: spent,
    options: [{ label: "A", buffer: mp4, mime: "video/mp4", w: REEL_W, h: REEL_H, badge, note, aiEdited: resolved.some((r) => r.generated || !!r.clip),
      extra: { seconds, scenes: plan.scenes.length, planSource: plan.source, hook: plan.hook, repaired: repaired.length, imageCredits: spent, plan: JSON.stringify(plan).slice(0, 6000) } }],
    ...(parents[0] ? { parentId: parents[0] } : {}),
    usesBrand: [...(kit.ids.logo && end.logo === "file" ? [kit.ids.logo] : []), ...kit.ids.fonts], guidedBy: kit.ids.rules,
  });
  return { status: "made", priceCredits: price, spentCredits: spent, seconds, saved, verdicts, repaired, notes };
}

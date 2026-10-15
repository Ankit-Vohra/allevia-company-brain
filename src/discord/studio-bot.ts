// The Studio on Discord: the owner drops photos (or videos) in #studio, or attaches one in #your-team, and the team does
// the Studio flow (src/studio/*) in a thread:
//   Tara looks at the photo -> variants -> Nisha checks them -> Dev writes the caption -> the card.
// Each variant is posted back as an image attachment with its caption and Approve / Change buttons. Approve is the same
// decision as the web's Studio card (approveStudioDraft: the draft post, the approved Asset and its lineage). A text
// reply in the thread ("make it warmer") makes the next variant (studio/revise.ts). Mid-run progress is one message,
// edited as the team works, like the question work log.
// The files are fetched under the rules in attachments.ts (Discord's own hosts, size, type, at most four). Photos go
// through the Studio's own intake (EXIF and other metadata stripped; a person is flagged and blurred in the options, no
// identity is stored). Videos are kept as raw Assets; the first frame is assessed when ffmpeg is here, and the owner is
// told plainly what the team can and cannot do with video. Nobody's Discord id or name is written to the graph.
// One Studio run at a time across every business on the hub (the same limit as the API's `busy`): the rest queue.
import type { AgentEvent } from "../../shared/contracts.js";
import { DecisionError, decide, type ActionOpts, type OnDecision } from "../server/approvals.js";
import { studioErrorMessage } from "../server/studio.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";
import { approveStudioDraft, studioCard, type DecideFn } from "../studio/approve.js";
import type { PhotoAssessment } from "../studio/assess.js";
import { ImageRejected } from "../studio/image.js";
import { runStudio, type StudioDeps, type StudioResult } from "../studio/pipeline.js";
import { parseStudioSetting, setBlurFaces, SETTING_REPLY } from "../studio/settings.js";
import { reviseVariant, type ReviseResult } from "../studio/revise.js";
import { generateVariant, type GenerateRequest, type GenerateResult } from "../studio/generate.js";
import { creditsWords } from "../studio/credits.js";
import { routeRequest } from "../studio/request.js";
import { assessFirstFrame, storeVideo, VideoRejected, type Ffmpeg } from "../studio/video.js";
import { downloadAttachment, AttachmentRejected, MAX_ATTACHMENTS, pickMedia, type AttachmentRef, type FetchFn } from "./attachments.js";
import type { ButtonPort, ButtonSpec, MessagePort, ThreadPort } from "./bot.js";
import { threadName } from "./format.js";
import { ThrottledEditor, WorkLogState } from "./worklog.js";

const PREFIX = "allevia:studio";
const BUTTON = new RegExp(`^${PREFIX}:(approve|change|retry):(.+):([A-Z][A-Z0-9]*)$`);
export const studioButtonId = (verb: "approve" | "change" | "retry", approvalId: string, label: string): string => `${PREFIX}:${verb}:${approvalId}:${label}`;
export const isStudioButton = (customId: string): boolean => customId.startsWith(`${PREFIX}:`);

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const quote = (s: string): string => s.split("\n").map((l) => `> ${l}`).join("\n");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// One at a time: the next waits its turn.
export class StudioGate {
  private tail: Promise<unknown> = Promise.resolve();
  private running = false;
  private waiting = 0;
  get busy(): boolean { return this.running || this.waiting > 0; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting++;
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    try {
      await prev;
    } finally {
      this.waiting--;
    }
    this.running = true;
    try {
      return await fn();
    } finally {
      this.running = false;
      release();
    }
  }
}

export interface StudioBotDeps {
  tenant: string;
  businessId: string;
  graph: GraphHandle;
  studio: Omit<StudioDeps, "now" | "signal">;
  ffmpeg: Ffmpeg;
  gate: StudioGate;
  /** The clip offer (studio/clip.ts), when video from a still is switched on. */
  clip?: { offer(o: { tenant: string; businessId: string; approvalId: string }): Promise<{ message: string }> };
  fetch?: FetchFn;
  onDecision?: OnDecision;
  actions?: ActionOpts;
  now?: () => number;
  workLogIntervalMs?: number;
  log?: (line: string) => void;
}

const VERDICT_WORDS: Record<PhotoAssessment["verdict"], string> = {
  use: "it is ready to use as it is",
  enhance: "it needs a little polish",
  recompose: "a different crop would help",
  reshoot: "it is worth taking again",
};

export class StudioDiscord {
  constructor(private d: StudioBotDeps) {}

  private now(): number { return this.d.now?.() ?? Date.now(); }
  private log(line: string): void { (this.d.log ?? ((l: string) => console.error(l)))(`[studio] ${line}`); }

  hasMedia(m: Pick<MessagePort, "files">): boolean { return pickMedia(m.files).picked.length > 0; }

  // ----- photos and videos arrive -----

  async onMedia(m: MessagePort, into?: ThreadPort | null): Promise<void> {
    const { picked, extra, other } = pickMedia(m.files);
    if (!picked.length) return;
    const note = m.content.trim().slice(0, 500);
    const thread = into ?? await m.startThread(threadName(note || (picked[0]!.kind === "image" ? "New photo" : "New video")));
    if (extra) await thread.send(`I will work on the first ${MAX_ATTACHMENTS} files and leave the other ${extra}. Send them again after.`);
    if (other) await thread.send(`${other === 1 ? "One file was" : `${other} files were`} not a photo or a video, so I left ${other === 1 ? "it" : "them"} alone.`);
    for (const file of picked) {
      try {
        const bytes = await downloadAttachment(file, this.d.fetch ? { fetch: this.d.fetch } : {});
        if (file.kind === "image") await this.photo(thread, bytes, note);
        else await this.video(thread, bytes, file, note);
      } catch (e) {
        if (e instanceof AttachmentRejected || e instanceof ImageRejected || e instanceof VideoRejected) await thread.send(e.message);
        else {
          this.log(`${this.d.tenant}: ${message(e)}`);
          await thread.send(studioErrorMessage(e));
        }
      }
    }
  }

  // ----- a photo -----

  private async photo(thread: ThreadPort, bytes: Buffer, note: string): Promise<void> {
    if (this.d.gate.busy) await thread.send("The Studio is working on another photo. Yours is next.");
    await this.d.gate.run(async () => {
      const state = new WorkLogState();
      const logMsg = await thread.send(state.render());
      const editor = new ThrottledEditor((t) => logMsg.edit(t), this.d.workLogIntervalMs ?? 1500, undefined, (e) => this.log(`work log edit failed: ${message(e)}`));
      const emit = (e: AgentEvent) => { state.apply(e); editor.update(state.render()); };
      let result: StudioResult;
      try {
        result = await runStudio(this.d.graph, { tenant: this.d.tenant, businessId: this.d.businessId, bytes, ...(note ? { note } : {}) }, { ...this.d.studio, now: this.d.now ?? (() => Date.now()) }, emit);
      } finally {
        await editor.flush();
      }
      // remember which thread this photo lives in, so a text reply there finds it
      const [row] = await this.d.graph.roQuery<{ name: string | null }>("MATCH (a:Entity:Asset {id:$id}) RETURN a.name AS name", { id: result.original.id });
      await upsertNode(this.d.graph, { type: "Asset", id: result.original.id, name: row?.name ?? result.original.id, props: { discordThreadId: thread.id } }, this.now());
      await this.post(thread, result);
    });
  }

  private async post(thread: ThreadPort, r: StudioResult): Promise<void> {
    const a = r.assessment;
    await thread.send(clip([
      `Tara looked at your photo: ${VERDICT_WORDS[a.verdict]}. ${a.story}`.trim(),
      ...(a.verdict === "reshoot" && a.coaching ? [a.coaching] : []),
      ...(r.privacy.blurredPeople && !r.privacy.minor ? ["Faces are blurred in the options, because your setting blurs people's faces."] : []),
      ...r.notices,
    ].join("\n"), 1900));
    const caption = [r.caption.caption, r.caption.hashtags.join(" ")].filter(Boolean).join("\n\n");
    const card = await studioCard(this.d.graph, r.approvalId);
    const recommended = card?.payload.studio.recommended;
    if (!r.variants.length) await thread.send("I could not make a usable option from this photo. Try a straighter, brighter one.");
    for (const v of r.variants) {
      const f = r.fidelity.find((x) => x.assetId === v.id);
      const flavour = v.label === "A" ? " (the safe one: a free clean-up)" : v.label === "B" ? ` (the bolder one: edited with AI${v.credits !== undefined ? `, ${creditsWords(v.credits, { about: true })}` : ""})` : "";
      await this.postOption(thread, r.approvalId, v, { badge: f?.badge ?? "unchecked", note: f?.note ?? "it could not be checked" }, {
        head: `**Option ${v.label}**${flavour}${v.id === recommended ? " · our pick" : ""}`, caption,
        canRetry: !!card?.payload.studio.variants.find((x) => x.id === v.id)?.canRetry,
      });
    }
    await thread.send("Tap Approve on the one you like. It is saved as a draft and nothing is posted anywhere. To change one, reply here. Light and colour changes are free, for example \"make it warmer\". A bigger change, like \"make it festive\", \"change the background\" or \"make this into an ad saying ...\", uses the AI editor, and I will tell you what it costs.");
  }

  // One option as a message: the picture, the check, the caption, and the buttons that fit (Approve and Change when Nisha passed
  // it; Try again, with its price, when she held an AI edit back).
  private async postOption(
    thread: ThreadPort, approvalId: string, v: { label: string; buffer: Buffer }, check: { badge: string; note: string },
    o: { head: string; caption?: string; canRetry?: boolean; credits?: number; extra?: string },
  ): Promise<void> {
    const passed = check.badge === "unchanged";
    const buttons: ButtonSpec[] = passed ? [
      { customId: studioButtonId("approve", approvalId, v.label), label: "Approve", style: "success" },
      { customId: studioButtonId("change", approvalId, v.label), label: "Change", style: "secondary" },
    ] : o.canRetry ? [
      { customId: studioButtonId("retry", approvalId, v.label), label: `Try again${o.credits !== undefined ? ` (${creditsWords(o.credits, { about: true })})` : ""}`, style: "secondary" },
    ] : [];
    await thread.send({
      content: clip([
        o.head,
        passed ? `Checked: ${check.note.replace(/^Building unchanged\s*·?\s*/i, "the building is unchanged; ") || "the building is unchanged"}` : `Held back: ${check.note}${o.canRetry ? " I can try once more with a tighter lock." : ""}`,
        ...(o.extra ? [o.extra] : []),
        ...(o.caption ? ["", quote(clip(o.caption, 900))] : []),
      ].join("\n"), 1900),
      buttons,
      files: [{ name: `option-${v.label.toLowerCase()}.jpg`, data: v.buffer }],
    });
  }

  // ----- a text reply under the options -----

  // "blur faces from now on" / "stop blurring faces": the one Studio setting, by a plain reply. True when it was one.
  async onSetting(words: string, say: (text: string) => Promise<unknown>): Promise<boolean> {
    const s = parseStudioSetting(words);
    if (!s) return false;
    try {
      await setBlurFaces(this.d.graph, this.d.businessId, s.blurFaces, this.now());
      await say(SETTING_REPLY[s.blurFaces ? "on" : "off"]);
    } catch (e) {
      this.log(`${this.d.tenant}: setting failed: ${message(e)}`);
      await say("I couldn't save that setting. Try again in a moment.");
    }
    return true;
  }

  async onReply(m: MessagePort, thread: ThreadPort): Promise<void> {
    const words = m.content.trim();
    if (!words) return;
    if (await this.onSetting(words, (t) => thread.send(t))) return;
    const [row] = await this.d.graph.roQuery<{ id: string; approval: string | null }>(
      `MATCH (a:Entity:Asset) WHERE a.kind = 'original' AND a.discordThreadId = $tid
       RETURN a.id AS id, a.approvalId AS approval ORDER BY coalesce(a.studioRunAt, 0) DESC, a.id LIMIT 1`, { tid: thread.id });
    if (!row?.approval) return void await thread.send("Drop a photo here and your team will make post options from it.");
    const approvalId = row.approval;
    const req = routeRequest(words);
    if (req.kind === "chat") return void await thread.send("Tell me what you would like changed, for example \"make it warmer\", \"make it festive\", \"a different background\", or \"make this into an ad saying ...\".");
    if (req.kind === "clip") return void await this.d.gate.run(() => this.clip(thread, approvalId));
    if (req.kind === "generate" || req.kind === "ad" || req.kind === "retry") {
      return void await this.d.gate.run(() => this.generate(thread, approvalId, req.kind === "retry" ? { kind: "retry" } : req.kind === "ad" ? { kind: "ad", words: req.words, ...(req.headline ? { headline: req.headline } : {}), ...(req.sub ? { sub: req.sub } : {}) } : { kind: "request", words: req.words }));
    }
    await this.d.gate.run(async () => {
      let r: ReviseResult;
      try {
        r = await reviseVariant(this.d.graph, { tenant: this.d.tenant, businessId: this.d.businessId, approvalId, instruction: words }, { ...this.d.studio, now: this.now() });
      } catch (e) {
        this.log(`${this.d.tenant}: revise failed: ${message(e)}`);
        return void await thread.send(studioErrorMessage(e));
      }
      if (!r.ok) return void await thread.send(r.message);
      const passed = r.fidelity.badge === "unchanged";
      await thread.send({
        content: clip([
          `**Option ${r.variant.label}**: ${r.adjustment.label}${passed ? " · our pick" : ""}`,
          passed ? "Made with the team's own colour and light tools (free). Checked: the building is unchanged." : `Held back: ${r.fidelity.note}`,
        ].join("\n"), 1900),
        buttons: passed ? [
          { customId: studioButtonId("approve", approvalId, r.variant.label), label: "Approve", style: "success" },
          { customId: studioButtonId("change", approvalId, r.variant.label), label: "Change", style: "secondary" },
        ] : [],
        files: [{ name: `option-${r.variant.label.toLowerCase()}.jpg`, data: r.variant.buffer }],
      });
    });
  }

  // A request for the AI editor ("make it festive", an ad, "try again"): one work-log line for the price, then the new option.
  private async generate(thread: ThreadPort, approvalId: string, request: GenerateRequest): Promise<void> {
    const log = await thread.send(request.kind === "retry" ? "Trying the AI edit again..." : request.kind === "ad" ? "Styling your photo as an ad..." : "Asking the AI editor...");
    const lines: string[] = [];
    let r: GenerateResult;
    try {
      r = await generateVariant(this.d.graph, { tenant: this.d.tenant, businessId: this.d.businessId, approvalId, request },
        { ...this.d.studio, now: this.now(), status: (t) => { lines.push(t); void log.edit(clip(`${lines.map((x) => `· ${x}`).join("\n")}`, 1900)).catch(() => undefined); } });
    } catch (e) {
      this.log(`${this.d.tenant}: generate failed: ${message(e)}`);
      return void await thread.send(studioErrorMessage(e));
    }
    if (!r.ok) return void await thread.send(r.message);
    const f = r.fidelity;
    await this.postOption(thread, approvalId, r.variant, { badge: f.badge, note: f.note }, {
      head: `**Option ${r.variant.label}** (edited with AI${r.variant.credits !== undefined ? `, ${creditsWords(r.variant.credits, { about: true })}` : ""}): ${clip(r.request, 120)}${r.passed ? " · our pick" : ""}`,
      canRetry: r.canRetry, ...(r.variant.credits !== undefined ? { credits: r.variant.credits } : {}),
    });
  }

  // "make a clip": a short video from the approved still, priced first (see studio/clip.ts).
  private async clip(thread: ThreadPort, approvalId: string): Promise<void> {
    const c = this.d.clip;
    if (!c) return void await thread.send("I can't make video clips here yet. I can make photos: ask for a change, or an ad.");
    const r = await c.offer({ tenant: this.d.tenant, businessId: this.d.businessId, approvalId });
    await thread.send(r.message);
  }

  // ----- the buttons -----

  /** True when the press was a Studio button (handled here), false when it belongs to someone else. */
  async onButton(b: ButtonPort): Promise<boolean> {
    const m = BUTTON.exec(b.customId);
    if (!m) return false;
    if (!b.isOwner) {
      await b.reply("Only people on this business's team can say OK here.", { ephemeral: true });
      return true;
    }
    const [, verb, approvalId, label] = m as unknown as [string, "approve" | "change" | "retry", string, string];
    if (verb === "change") {
      await b.reply("Tell me what to change in this thread, for example \"make it warmer\", \"a bit darker\", \"make it festive\" or \"a different background\". I will make a new option.", { ephemeral: true });
      return true;
    }
    if (verb === "retry") {
      const thread = b.thread?.();
      if (!thread) return void await b.reply("Reply in the thread with \"try again\" and I will have another go.", { ephemeral: true }), true;
      await b.defer?.();
      await b.update({ content: `Option ${label} was held back. Trying again...`, buttons: [] });
      await this.d.gate.run(() => this.generate(thread, approvalId, { kind: "retry", of: label }));
      return true;
    }
    try {
      await b.defer?.();
      const card = await studioCard(this.d.graph, approvalId);
      if (!card) return void await b.reply("That photo's card no longer exists.", { ephemeral: true }), true;
      const v = card.payload.studio.variants.find((x) => x.label === label);
      if (!v) return void await b.reply("I can't find that option any more.", { ephemeral: true }), true;
      const decideWith: DecideFn = (id, edited) => decide(this.d.graph, this.d.tenant, id, { decision: "approve", ...(edited ? { editedPayload: edited } : {}) },
        { now: this.now(), log: (l) => this.log(l), ...(this.d.onDecision ? { onDecision: this.d.onDecision } : {}), ...(this.d.actions ? { actions: this.d.actions } : {}) });
      await approveStudioDraft(this.d.graph, { approvalId, variantId: v.id, now: this.now() }, decideWith);
      await b.update({
        content: clip([`✅ You approved option ${label}. It is saved as a draft post. Nothing has been published.`, "", quote(clip(card.payload.body, 1200))].join("\n"), 1900),
        buttons: [],
      });
    } catch (e) {
      if (e instanceof DecisionError && e.status === 409) await b.reply(e.message.includes("Nisha") ? "That option was held back, so it can't be approved." : "This photo was already decided.", { ephemeral: true });
      else if (e instanceof DecisionError) await b.reply("That photo's card no longer exists.", { ephemeral: true });
      else {
        this.log(`${this.d.tenant}: approve ${approvalId} failed: ${message(e)}`);
        await b.reply("I couldn't record that. Try again, or approve it in the web app.", { ephemeral: true });
      }
    }
    return true;
  }

  // ----- a video -----

  private async video(thread: ThreadPort, bytes: Buffer, file: AttachmentRef, note: string): Promise<void> {
    if (this.d.gate.busy) await thread.send("The Studio is working on another photo. Yours is next.");
    await this.d.gate.run(async () => {
      const stored = await storeVideo(this.d.graph, { tenant: this.d.tenant, bytes, mime: (file.contentType ?? "").split(";")[0]!.trim().toLowerCase() || "video/mp4", ...(note ? { note } : {}) },
        { store: this.d.studio.store, now: this.now(), ffmpeg: this.d.ffmpeg });
      if (!stored.hasFfmpeg) {
        return void await thread.send("I saved your video with your other media. I can't look inside videos on this server yet, and I can't edit video today, so it is kept as you sent it for your team to use. Details like where it was filmed are not removed from a video yet.");
      }
      const kept = `I saved your video${stored.stripped ? " and removed the location and device details from the file" : ""}.`;
      if (!stored.frame) {
        return void await thread.send(`${kept} I couldn't read its first frame, so I could not look at it. I can't edit video yet, so it is kept as you sent it.`);
      }
      const a = await assessFirstFrame(this.d.graph, { businessId: this.d.businessId, assetId: stored.asset.id, frame: stored.frame, ...(note ? { note } : {}) },
        { vision: this.d.studio.vision, ...(this.d.studio.models ? { models: this.d.studio.models } : {}), now: this.now() });
      await thread.send(clip(`${kept} Tara looked at its first frame: ${VERDICT_WORDS[a.verdict]}. ${a.story}\nI can't edit or restyle video yet, so it is kept as you sent it for your team to use.`, 1900));
    });
  }
}


// "Add your numbers" on Discord (issue #8): an owner drops a CSV or XLSX in #your-team and gets the same two steps as the
// web app's upload (src/server/routes/numbers.ts): what we found, in plain words, with OK and Not now; their changes in
// their own words ("column C is orders", "leave out D", "each row is a week"); then the numbers are added and the goals
// read them. Nothing is written until OK.
//
// - The business is the bot's own: the hub picks the bot from the channel (hub-bot.ts), never from the file or the text.
// - The file is fetched under attachments.ts's rules (Discord's own hosts, 20 MB, redirects held to the same rule), and
//   fetched again on OK, checked against the preview's fingerprint, so no file is held in memory while the owner thinks.
// - What is waiting lives in memory only (a restart forgets it: the owner drops the file again), at most MAX_PENDING
//   files per business for at most PENDING_TTL_MS. At most two files are read at once on the whole process.
import { randomBytes, createHash } from "node:crypto";
import { UploadError } from "../connectors/upload/limits.js";
import { applyReply, describePlan, describePreview, describeResult } from "../connectors/upload/text.js";
import type { Preview, UploadPlan } from "../connectors/upload/types.js";
import type { GraphHandle } from "../graph/client.js";
import { importUpload, previewUpload, type UploadedNumbers } from "../server/routes/numbers.js";
import { AttachmentRejected, downloadAttachment, type AttachmentRef, type FetchFn } from "./attachments.js";
import type { ButtonPort, ButtonSpec, MessagePort, ThreadPort } from "./bot.js";
import { splitMessage } from "./format.js";

const PREFIX = "allevia:num";
const BUTTON = new RegExp(`^${PREFIX}:(ok|no):([0-9a-f]{12})$`);
const MAX_PENDING = 10;
const PENDING_TTL_MS = 2 * 3_600_000;
const MAX_READING = 2;
const SHEET_EXT = /\.(csv|xlsx|xls)$/i;
const SHEET_TYPES = new Set(["text/csv", "application/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"]);
const SAID_OK = /^(?:ok(?:ay)?|yes|yep|yeah|sure|go ahead|looks (?:good|right)|add (?:them|these|it)|that'?s right|correct)\b[\s.!]*$/i;

export const isNumbersButton = (id: string): boolean => id.startsWith(`${PREFIX}:`);

// The first spreadsheet in a message, by its name or the type Discord gives it.
export function pickSpreadsheet(files: AttachmentRef[] | undefined): AttachmentRef | null {
  return (files ?? []).find((f) => SHEET_EXT.test(f.name) || SHEET_TYPES.has((f.contentType ?? "").split(";")[0]!.trim().toLowerCase())) ?? null;
}

let reading = 0; // files being read right now, across every business on this process

export interface NumbersDeps {
  graph: GraphHandle;
  businessId: string;
  now: () => number;
  fetch?: FetchFn;
  log?: (line: string) => void;
}

interface Pending {
  key: string;
  thread: ThreadPort;
  ref: AttachmentRef;
  preview: Preview;
  plan: UploadPlan;
  card: { id: string; edit: (m: { content: string; buttons: ButtonSpec[] }) => Promise<void> } | null;
  text: string;
  at: number;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export class NumbersOnDiscord {
  private pending = new Map<string, Pending>();

  constructor(private d: NumbersDeps) {}

  private log(line: string): void { (this.d.log ?? ((l: string) => console.error(l)))(`[numbers] ${line}`); }

  private buttons(key: string): ButtonSpec[] {
    return [
      { customId: `${PREFIX}:ok:${key}`, label: "OK, add these", style: "success" },
      { customId: `${PREFIX}:no:${key}`, label: "Not now", style: "secondary" },
    ];
  }

  private sweep(): void {
    const now = this.d.now();
    for (const [k, p] of this.pending) if (now - p.at > PENDING_TTL_MS) this.pending.delete(k);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
  }

  private forThread(threadId: string): Pending | undefined {
    for (const p of this.pending.values()) if (p.thread.id === threadId && this.d.now() - p.at <= PENDING_TTL_MS) return p;
    return undefined;
  }

  // Reads the file once (the shared gate keeps the process light); every refusal is a sentence the owner can act on.
  private async read(ref: AttachmentRef): Promise<UploadedNumbers> {
    const bytes = await downloadAttachment({ ...ref, kind: "file" }, this.d.fetch ? { fetch: this.d.fetch } : {});
    return { fileName: ref.name || "your file", bytes };
  }

  private async gated<T>(fn: () => Promise<T>): Promise<T | string> {
    if (reading >= MAX_READING) return "I'm reading other files right now. Drop it again in a minute.";
    reading++;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof UploadError || e instanceof AttachmentRejected) return e.message;
      throw e;
    } finally {
      reading--;
    }
  }

  private async post(thread: ThreadPort, text: string, key: string): Promise<Pending["card"]> {
    const parts = splitMessage(text, 1900);
    let last: Pending["card"] = null;
    for (const [i, part] of parts.entries()) {
      const posted = await thread.send(i === parts.length - 1 ? { content: part, buttons: this.buttons(key) } : part);
      if (i === parts.length - 1) last = { id: posted.id, edit: (m) => posted.edit(m) };
    }
    return last;
  }

  // A spreadsheet dropped in #your-team (or in one of its threads): what we found, with OK and Not now, in a thread.
  async onFile(m: MessagePort, ref: AttachmentRef): Promise<void> {
    const thread = m.thread() ?? await m.startThread(clip(`Your numbers: ${ref.name || "spreadsheet"}`, 90));
    const preview = await this.gated(async () => previewUpload(this.d.graph, this.d.businessId, await this.read(ref)));
    if (typeof preview === "string") {
      await thread.send(preview);
      return;
    }
    this.sweep();
    const key = randomBytes(6).toString("hex");
    const text = describePreview(preview);
    const p: Pending = { key, thread, ref, preview, plan: preview.plan, card: null, text: "", at: this.d.now() };
    this.pending.set(key, p);
    p.card = await this.post(thread, text, key);
    p.text = splitMessage(text, 1900).at(-1) ?? text;
    this.log(`preview for ${this.d.businessId}: ${preview.rowCount} rows, ${preview.columns.length} columns`);
  }

  // A reply in a thread with a file waiting: "OK" adds it; "column C is orders" changes the plan. False when nothing is
  // waiting here, so the reply goes to the team as a question.
  async onReply(text: string, thread: ThreadPort): Promise<boolean> {
    const p = this.forThread(thread.id);
    if (!p) return false;
    const changed = applyReply(p.plan, text);
    if (!changed) {
      if (SAID_OK.test(text.trim())) {
        await this.add(p);
        return true;
      }
      await thread.send("I didn't catch that. Try “column C is orders”, “leave out D” or “each row is a week”, or say OK to add them as they are.");
      return true;
    }
    p.plan = changed;
    p.at = this.d.now();
    await p.card?.edit({ content: p.text, buttons: [] }).catch(() => undefined); // the older card's buttons go
    const words = describePlan(p.preview, p.plan);
    p.card = await this.post(thread, words, p.key);
    p.text = words;
    return true;
  }

  async onButton(b: ButtonPort): Promise<void> {
    const m = BUTTON.exec(b.customId);
    if (!m) return;
    const p = this.pending.get(m[2]!);
    if (!p || this.d.now() - p.at > PENDING_TTL_MS) return b.reply("That file is no longer waiting. Drop it in this channel again.", { ephemeral: true });
    await b.defer?.();
    await b.update({ content: p.text, buttons: [] });
    if (m[1] === "no") {
      this.pending.delete(p.key);
      await p.thread.send("Okay, nothing was added. Drop the file again whenever you like.");
      return;
    }
    await this.add(p);
  }

  private async add(p: Pending): Promise<void> {
    const r = await this.gated(async () => {
      const file = await this.read(p.ref);
      // the same file the owner saw: a file changed behind the link is not added on an OK given to another
      if (createHash("sha256").update(file.bytes).digest("hex") !== p.preview.fileHash) {
        throw new UploadError("That file changed since I read it. Drop it here again and I'll take another look.", "bad_plan");
      }
      return importUpload(this.d.graph, this.d.businessId, file, p.plan, this.d.now());
    });
    if (typeof r === "string") {
      await p.thread.send(r); // e.g. "Tell us what column C is": the file stays waiting for the answer
      return;
    }
    this.pending.delete(p.key);
    for (const part of splitMessage(describeResult(r), 1900)) await p.thread.send(part);
    this.log(`imported for ${this.d.businessId}: ${r.status}, ${r.written} numbers`);
  }
}

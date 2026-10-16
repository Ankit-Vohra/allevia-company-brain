// What a card in Discord carries beyond its title and text, looked up from the business's own graph and storage: the
// reason in one line, the pictures or clips themselves, what the website page says now, who a message goes to. Only this
// business's own graph and folder are read (the graph handle and the store are the business's own).
import type { GraphHandle } from "../graph/client.js";
import type { AssetStore } from "../studio/store.js";
import { loadAssetFile } from "../creative/files.js";
import type { ApprovalDto } from "../server/types.js";
import { PLATFORMS, accountWords } from "../publish/platforms.js";
import { readBlock } from "../publish/types.js";
import { whenWords } from "../publish/when.js";
import { oneLineWhy, type CardExtras, type CardOption } from "./approval-card.js";
import type { OutFile } from "./bot.js";

// Discord takes 25 MB a message on a plain server and 10 files; stay well inside both.
export const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACH_FILES = 4;

type Read = Pick<GraphHandle, "roQuery">;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

interface StudioVariant { id: string; label: string; badge?: string; note?: string; aiEdited?: boolean }
interface StudioExtra { id: string; label?: string; kind?: string; note?: string }
interface RawPayload {
  to?: unknown; recipient?: unknown; recipients?: unknown; subject?: unknown;
  studio?: { variants?: StudioVariant[]; recommended?: string; creative?: { kind?: string }; extras?: StudioExtra[] };
}

function parse(raw: unknown): RawPayload {
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as RawPayload) : {};
  } catch { return {}; }
}

const recipientOf = (p: RawPayload): string | undefined => {
  const r = p.to ?? p.recipient ?? p.recipients;
  return Array.isArray(r) ? r.filter((x) => typeof x === "string").join(", ") || undefined : str(r);
};

// The words on the page now, for a website fix: its address is in the draft ("Address: https://…") or the card's target.
async function pageNow(g: Read, a: ApprovalDto): Promise<{ label: string; text: string } | undefined> {
  const addr = /^Address:\s*(\S+)/m.exec(a.payload.body)?.[1] ?? (/^https?:\/\//.test(a.payload.target ?? "") ? a.payload.target : undefined);
  if (!addr) return undefined;
  const [row] = await g.roQuery<{ title: string | null; h1: string | null; meta: string | null }>(
    "MATCH (p:Entity:Page) WHERE p.url = $url RETURN p.title AS title, p.h1 AS h1, p.metaDescription AS meta ORDER BY p.id LIMIT 1", { url: addr });
  if (!row) return undefined;
  const lines = [row.title && `Page title: ${row.title}`, row.h1 && `Main heading: ${row.h1}`, row.meta && `Description: ${row.meta}`].filter((x): x is string => !!x);
  return lines.length ? { label: "On the page now", text: lines.join("\n") } : undefined;
}

export interface ExtrasDeps { graph: Read; store?: AssetStore; tenant: string; webBase?: string }

export async function approvalExtras(a: ApprovalDto, d: ExtrasDeps, standupWhy?: string): Promise<CardExtras> {
  const out: CardExtras = {};
  // the reason: the stand-up's own line, else the summary of the idea that proposed this
  let why = standupWhy;
  if (!why && a.recommendationId) {
    const [r] = await d.graph.roQuery<{ s: string | null }>("MATCH (r:Entity:Recommendation {id:$id}) RETURN r.summary AS s", { id: a.recommendationId });
    why = r?.s ?? undefined;
  }
  const w = oneLineWhy(why);
  if (w) out.why = w;

  const [row] = await d.graph.roQuery<{ payload: string | null }>("MATCH (n:Entity:Approval {id:$id}) RETURN n.payload AS payload", { id: a.id });
  const p = parse(row?.payload);
  const to = recipientOf(p);
  if (to) out.to = to;
  const subject = str(p.subject);
  if (subject) out.subject = subject;

  const pub = a.kind === "publish_post" ? readBlock((p as { publish?: unknown }).publish) : null;
  if (pub) {
    const spec = PLATFORMS[pub.platform];
    out.where = `${spec.name} (${accountWords(spec, pub.account)})`;
    if (pub.at) out.when = whenWords(pub.at, pub.tz ?? "UTC");
  }

  if (a.kind === "github_issue") {
    const before = await pageNow(d.graph, a).catch(() => undefined);
    if (before) out.before = before;
  }

  const variants = p.studio?.variants ?? [];
  if (variants.length) {
    const recommended = p.studio?.recommended;
    const options: CardOption[] = variants.map((v) => ({
      label: `Option ${v.label}`, note: (v.note ?? "").replace(/^(?:Building|Product) unchanged · /, "").replace(/^Changed: /, ""), pick: v.id === recommended, held: v.badge === "held",
    }));
    out.options = options;
    if (d.store) {
      const files: OutFile[] = [];
      let bytes = 0, skipped = 0;
      for (const v of variants) {
        const f = await loadAssetFile(d.graph, d.store, d.tenant, v.id, undefined).catch(() => null);
        if (!f) continue;
        const ext = f.name.split(".").pop() ?? "jpg";
        if (files.length >= MAX_ATTACH_FILES || bytes + f.data.length > MAX_ATTACH_BYTES) { skipped++; continue; }
        bytes += f.data.length;
        files.push({ name: `option-${v.label.toLowerCase()}.${ext}`, data: f.data });
      }
      // a clip made from one of the options goes with the card (a video, attached after the pictures)
      for (const x of (p.studio?.extras ?? []).filter((e) => e.kind === "clip").slice(0, 1)) {
        const f = await loadAssetFile(d.graph, d.store, d.tenant, x.id, undefined).catch(() => null);
        if (f && files.length < MAX_ATTACH_FILES && bytes + f.data.length <= MAX_ATTACH_BYTES) { bytes += f.data.length; files.push({ name: `clip.${f.name.split(".").pop() ?? "mp4"}`, data: f.data }); out.options = [...(out.options ?? []), { label: "Clip (5 seconds, silent)", note: x.note ?? "", pick: false, held: false }]; }
        else if (f) skipped++;
      }
      if (files.length) out.files = files;
      if (skipped) {
        out.notAttached = skipped;
        if (d.webBase) out.webUrl = `${d.webBase.replace(/\/+$/, "")}/approvals`;
      }
    }
  }
  return out;
}

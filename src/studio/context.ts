// What the Studio reads from the tenant graph before it touches a photo: the business, its brand kit (palette roles,
// fonts, visual and voice rules), the owner who authors uploads, and the portfolio project the owner's note names.
// Read-only (GRAPH.RO_QUERY), bounded, and tolerant of a thin graph: every field has a fallback.
import type { GraphHandle } from "../graph/client.js";

export interface BrandKit {
  paper: string;     // background colour: variant A's white-balance target
  ink?: string;
  accent?: string;
  neutral?: string;
  fonts: string[];
  visualStyle?: string;
  tone?: string;
  visualRules: Array<{ id: string; text: string }>;
  voiceRules: Array<{ id: string; text: string }>;
  ids: string[];     // every BrandAsset / BrandRule node used (the prompt's provenance)
}

export interface StudioContext {
  business: { id: string; name: string; industry?: string; city?: string; country?: string; designStyle?: string };
  brand: BrandKit;
  owner: { id: string; name: string } | null;
  project: { contentId: string; name: string; summary?: string; pageId?: string; pageUrl?: string } | null;
}

export const DEFAULT_PAPER = "#f3efe7";

const OWNER_WORDS = /\b(found(?:ed|er|ing)|owner|owns|principal|proprietor|director)\b/i;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function loadStudioContext(g: GraphHandle, businessId: string, note = ""): Promise<StudioContext> {
  const [biz] = await g.roQuery<Record<string, unknown>>(
    "MATCH (b:Business {id:$id}) RETURN b.name AS name, b.industry AS industry, b.city AS city, b.country AS country, b.designStyle AS designStyle",
    { id: businessId });
  const business: StudioContext["business"] = { id: businessId, name: str(biz?.name) ?? businessId };
  for (const k of ["industry", "city", "country", "designStyle"] as const) { const v = str(biz?.[k]); if (v) business[k] = v; }

  const assets = await g.roQuery<{ id: string; name: string | null; kind: string | null; value: string | null }>(
    "MATCH (a:BrandAsset) RETURN a.id AS id, a.name AS name, a.kind AS kind, a.value AS value ORDER BY a.id LIMIT 40");
  const rules = await g.roQuery<{ id: string; name: string | null; kind: string | null; summary: string | null }>(
    "MATCH (r:BrandRule) RETURN r.id AS id, r.name AS name, r.kind AS kind, r.summary AS summary ORDER BY r.id LIMIT 40");
  const colour = (role: RegExp) => assets.find((a) => /colou?r/i.test(a.kind ?? "") && role.test(a.name ?? "") && /^#[0-9a-f]{6}$/i.test(a.value ?? ""));
  const paper = colour(/background/i), ink = colour(/text/i), accent = colour(/primary|accent/i), neutral = colour(/neutral/i);
  const fonts = assets.filter((a) => /font/i.test(a.kind ?? "") && a.value).map((a) => a.value!);
  const rule = (k: RegExp) => rules.filter((r) => k.test(r.kind ?? ""));
  const visualStyle = rule(/^visual-style$/)[0], tone = rule(/^tone$/)[0];
  const brand: BrandKit = {
    paper: paper?.value?.toLowerCase() ?? DEFAULT_PAPER, fonts,
    visualRules: rule(/^visual$/).map((r) => ({ id: r.id, text: r.summary ?? r.name ?? "" })).filter((r) => r.text),
    voiceRules: rule(/^voice$/).map((r) => ({ id: r.id, text: r.summary ?? r.name ?? "" })).filter((r) => r.text),
    ids: [],
  };
  if (ink?.value) brand.ink = ink.value.toLowerCase();
  if (accent?.value) brand.accent = accent.value.toLowerCase();
  if (neutral?.value) brand.neutral = neutral.value.toLowerCase();
  if (visualStyle?.summary) brand.visualStyle = visualStyle.summary;
  if (tone?.summary) brand.tone = tone.summary;
  brand.ids = [
    ...[paper, ink, accent, neutral].filter(Boolean).map((a) => a!.id), ...assets.filter((a) => /font/i.test(a.kind ?? "")).map((a) => a.id),
    ...[visualStyle, tone].filter(Boolean).map((r) => r!.id), ...brand.visualRules.map((r) => r.id), ...brand.voiceRules.map((r) => r.id),
  ];

  const people = await g.roQuery<{ id: string; name: string | null; summary: string | null; role: string | null }>(
    "MATCH (p:Person)-[m:MEMBER_OF]->(:Business {id:$id}) WHERE m.until IS NULL RETURN p.id AS id, p.name AS name, p.summary AS summary, p.role AS role ORDER BY p.id LIMIT 50",
    { id: businessId });
  const o = people.find((p) => OWNER_WORDS.test(`${p.role ?? ""} ${p.summary ?? ""}`));
  const owner = o ? { id: o.id, name: o.name ?? o.id } : null;

  return { business, brand, owner, project: await matchProject(g, note) };
}

// The portfolio project the note names: the longest project name found in the note as whole words. Its page is the
// Page titled "<name> — …" (how sites title project pages), when there is one.
export async function matchProject(g: GraphHandle, note: string): Promise<StudioContext["project"]> {
  const text = ` ${note.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ")} `;
  if (!text.trim()) return null;
  const projects = await g.roQuery<{ id: string; name: string | null; summary: string | null }>(
    "MATCH (c:Content) WHERE c.format = 'project' RETURN c.id AS id, c.name AS name, c.summary AS summary ORDER BY c.id LIMIT 200");
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim()} `;
  const hit = projects.filter((p) => p.name && norm(p.name).trim().length >= 3 && text.includes(norm(p.name)))
    .sort((a, b) => b.name!.length - a.name!.length)[0];
  if (!hit) return null;
  const pages = await g.roQuery<{ id: string; name: string | null; url: string | null }>(
    "MATCH (p:Page) WHERE p.name STARTS WITH $prefix RETURN p.id AS id, p.name AS name, p.url AS url ORDER BY p.id LIMIT 5",
    { prefix: hit.name! });
  const page = pages.find((p) => /^\s*[—–\-|:]/.test((p.name ?? "").slice(hit.name!.length)));
  return {
    contentId: hit.id, name: hit.name!, ...(hit.summary ? { summary: hit.summary } : {}),
    ...(page ? { pageId: page.id, ...(page.url ? { pageUrl: page.url } : {}) } : {}),
  };
}

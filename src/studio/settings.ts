// The Studio's one setting for the owner (founder's decision, 2026-10-15): "Blur people's faces in my content", off by
// default, per business. It lives on the Business node (`blurFaces`), is changed from the web app (PUT
// /api/:t/studio/settings) or by a plain reply in Discord ("blur faces from now on"), and is read at the start of every
// Studio run. No question is asked per photo and nothing is learned about people.
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";
import { findBusiness } from "../capabilities/ladder.js";

export interface StudioSettings { blurFaces: boolean }

export const STUDIO_SETTING_DEFAULTS: StudioSettings = { blurFaces: false };

export async function loadStudioSettings(g: GraphHandle, businessId?: string): Promise<StudioSettings> {
  const id = await findBusiness(g, businessId);
  if (!id) return { ...STUDIO_SETTING_DEFAULTS };
  const [row] = await g.roQuery<{ blur: boolean | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.blurFaces AS blur", { id });
  return { blurFaces: row?.blur === true };
}

export async function setBlurFaces(g: GraphHandle, businessId: string | undefined, on: boolean, now: number): Promise<StudioSettings> {
  const id = await findBusiness(g, businessId);
  if (!id) throw new Error("There is no business in this graph to set that on.");
  const [row] = await g.roQuery<{ name: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name", { id });
  await upsertNode(g, { type: "Business", id, name: row?.name ?? id, props: { blurFaces: on } }, now);
  return { blurFaces: on };
}

// A plain reply about the setting. null when the words are not about it.
export type StudioSettingReply = { blurFaces: boolean };

export function parseStudioSetting(words: string): StudioSettingReply | null {
  const t = ` ${words.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim()} `;
  if (t.length > 160) return null;
  const about = /\b(?:blur|blurring|blurred|pixelate|hide|cover)\b/.test(t) && /\b(?:faces?|people|person|persons|everyone|anyone|humans?)\b/.test(t);
  if (about) {
    if (/\b(?:stop|don't|dont|do not|no more|never|no need to|without|turn off|switch off)\b/.test(t) && !/\b(?:don't|dont|do not) forget\b/.test(t)) return { blurFaces: false };
    return { blurFaces: true };
  }
  if (/\b(?:keep|leave|show|use)\b.*\b(?:faces?|people)\b.*\b(?:as they are|visible|clear|unblurred|unchanged|natural)\b/.test(t)) return { blurFaces: false };
  return null;
}

export const SETTING_REPLY: Record<"on" | "off", string> = {
  on: "Done. From now on I will blur people's faces in your content. You can change this any time: just say \"stop blurring faces\".",
  off: "Done. People's faces will be kept as they are in your content. Say \"blur faces from now on\" if you change your mind.",
};

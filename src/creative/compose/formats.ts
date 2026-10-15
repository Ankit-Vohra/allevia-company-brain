// The sizes the composer makes (px). Instagram's own: square 1080x1080, portrait 1080x1350 (4:5, the feed's tallest), story
// 1080x1920 (9:16); a flyer is A4 at 200 dpi. A story keeps its text out of the zones the app draws over (the top 250 px and
// the bottom 400 px: the profile bar and the reply box).
export type FormatKey = "insta_square" | "insta_portrait" | "insta_story" | "flyer";

export interface PosterFormat {
  key: FormatKey;
  label: string;
  w: number;
  h: number;
  aspect: "1:1" | "4:5" | "9:16" | "3:4";   // what to ask the image engine for the artwork
  margin: number;                           // outer margin
  safeTop: number;                          // text and logo stay below this
  safeBottom: number;                       // ... and above h - this
  mime: "image/jpeg" | "image/png";
}

export const FORMATS: Record<FormatKey, PosterFormat> = {
  insta_square: { key: "insta_square", label: "Instagram square", w: 1080, h: 1080, aspect: "1:1", margin: 76, safeTop: 76, safeBottom: 76, mime: "image/jpeg" },
  insta_portrait: { key: "insta_portrait", label: "Instagram portrait", w: 1080, h: 1350, aspect: "4:5", margin: 76, safeTop: 76, safeBottom: 76, mime: "image/jpeg" },
  insta_story: { key: "insta_story", label: "Instagram story", w: 1080, h: 1920, aspect: "9:16", margin: 76, safeTop: 250, safeBottom: 400, mime: "image/jpeg" },
  flyer: { key: "flyer", label: "A4 flyer", w: 1654, h: 2339, aspect: "3:4", margin: 118, safeTop: 118, safeBottom: 118, mime: "image/png" },
};

export const FORMAT_KEYS = Object.keys(FORMATS) as FormatKey[];
export const isFormat = (k: unknown): k is FormatKey => typeof k === "string" && k in FORMATS;

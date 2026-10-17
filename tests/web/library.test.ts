// The Library and the chat's photo attach (web/src/lib/library.ts, drawn by web/src/pages/Library.tsx and
// web/src/components/chat/PhotoAttach.tsx): the grid's tiles and filters, the sheet's actions, the empty state, and what a photo
// sent in the chat says and refuses. The words follow docs/owner-words.md: no ids, models, steps or "variant".
import { describe, expect, it } from "vitest";
import type { LibraryItem } from "../../shared/contracts.js";
import { ownerJargon } from "../../src/agent/style.js";
import { DEFAULT_PHOTO_NOTE as SERVER_NOTE } from "../../src/server/routes/chat-photo.js";
import {
  DEFAULT_PHOTO_NOTE, EMPTY, FILTERS, KIND_WORDS, LIBRARY_CHAT_WITH, PHOTO_PLACEHOLDER, STATE_WORDS, askPrompt, chatPrefill, creditWords, dayWords, emptyFor,
  filterItems, isFilter, photoProblem, photoQuestion, plainTitle, sheetActions, tileWords, variationPrompt,
} from "../../web/src/lib/library.js";

const NOW = Date.UTC(2026, 9, 17, 12);
const item = (over: Partial<LibraryItem> & { id: string }): LibraryItem => ({
  title: over.id, kind: "picture", media: "image", mine: false, state: null, approvalId: null, at: NOW, credits: null, label: null, check: null,
  url: `/api/mini/assets/${encodeURIComponent(over.id)}`, thumb: `/api/mini/assets/${encodeURIComponent(over.id)}?w=480`, ...over,
});

const PHOTO = item({ id: "asset:photo", title: "Photo: the front, before the garden", kind: "your-photo", mine: true, at: NOW - 3_600_000 });
const A = item({ id: "asset:a", title: "Variant A: straightened and graded (local)", label: "A", state: "declined", check: "ok", at: NOW - 1000 });
const B = item({ id: "asset:b", title: "Variant B: Make it festive for Diwali (Higgsfield, AI-edited)", label: "B", state: "waiting", approvalId: "approval:1", credits: 6.5, check: "ok", at: NOW - 900 });
const POSTER = item({ id: "asset:poster", title: "Dussehra greeting: option A", kind: "poster", state: "posted", at: NOW - 86_400_000 * 3 });
const CLIP = item({ id: "asset:clip", title: "Clip from option B (5 s, 9:16, Higgsfield, AI-made)", kind: "clip", media: "video", state: "waiting", approvalId: "approval:1", credits: 7.5, at: NOW - 100 });
const VIDEO = item({ id: "asset:video", title: "Video 3fa9c2e1", kind: "your-video", media: "video", mine: true, at: NOW - 5_000_000 });
const ALL = [PHOTO, A, B, POSTER, CLIP, VIDEO];

describe("the Library grid", () => {
  it("has five filters in the owner's words, and reads ?show= safely", () => {
    expect(FILTERS.map((f) => f.label)).toEqual(["All", "Pictures", "Videos", "Your photos", "Brand"]);
    expect(isFilter("brand")).toBe(true);
    expect(isFilter("studio")).toBe(false);
    expect(isFilter(null)).toBe(false);
  });

  it("shows everything newest first; Pictures are the team's pictures, Videos every video, Your photos what the owner sent; Brand is its own tab", () => {
    expect(filterItems(ALL, "all").map((i) => i.id)).toEqual(["asset:clip", "asset:b", "asset:a", "asset:photo", "asset:video", "asset:poster"]);
    expect(filterItems(ALL, "pictures").map((i) => i.id)).toEqual(["asset:b", "asset:a", "asset:poster"]);
    expect(filterItems(ALL, "videos").map((i) => i.id)).toEqual(["asset:clip", "asset:video"]);
    expect(filterItems(ALL, "mine").map((i) => i.id)).toEqual(["asset:photo", "asset:video"]);
    expect(filterItems(ALL, "brand")).toEqual([]);
  });

  it("each tile says what it is, where it stands, the day and the credits, in plain words", () => {
    expect(tileWords(B, NOW)).toEqual({
      title: "Make it festive for Diwali", kind: "Picture", state: "Waiting for your OK", tone: "waiting", date: "17 Oct", credits: "6.5 credits", alt: "Picture: Make it festive for Diwali",
    });
    expect(tileWords(A, NOW)).toMatchObject({ title: "Straightened and graded", state: "Declined", credits: null });
    expect(tileWords(PHOTO, NOW)).toMatchObject({ title: "The front, before the garden", kind: "Your photo", state: null });
    expect(tileWords(POSTER, NOW)).toMatchObject({ title: "Dussehra greeting: option A", kind: "Poster", state: "Posted", date: "14 Oct" });
    expect(tileWords(CLIP, NOW)).toMatchObject({ title: "Clip from option B", kind: "Clip", credits: "7.5 credits" });
    expect(tileWords(VIDEO, NOW).title).toBe("Your video"); // a file name made of a hash is no title
    expect(plainTitle({ kind: "poster", title: "Instagram portrait poster: Cook an evening shift this weekend: option A" })).toBe("Cook an evening shift this weekend: option A");
    expect(plainTitle({ kind: "product-shoot", title: "Variant C: Premium ad (Higgsfield product photoshoot, AI-made)" })).toBe("Premium ad");
    expect(dayWords(Date.UTC(2025, 2, 3, 12), NOW)).toBe("3 Mar 2025");
    expect(creditWords(1)).toBe("1 credit");
    expect(creditWords(0)).toBeNull();
    for (const w of [...Object.values(KIND_WORDS), ...Object.values(STATE_WORDS), ...ALL.map((i) => plainTitle(i))]) expect(ownerJargon(w)).toEqual([]);
  });

  it("an empty Library is one line and the way to make the first post in Chat", () => {
    expect(EMPTY).toEqual({ line: "Every post, ad and clip your team makes is kept here.", cta: "Make your first post in Chat" });
    expect(emptyFor("all")).toBe(EMPTY.line);
    expect(emptyFor("mine")).toBe("Photos you send in Chat are kept here.");
    expect(emptyFor("videos")).toBe("No videos yet.");
  });
});

describe("the sheet behind a tile", () => {
  it("offers Download, Make a variation and Ask about it (both open Chat with the words typed), and OK and Look only while it waits", () => {
    const a = sheetActions(B);
    expect(a.download).toEqual({ href: "/api/mini/assets/asset%3Ab", filename: "make-it-festive-for-diwali.jpg" });
    expect(a.decide).toBe(true);
    expect(variationPrompt(B)).toBe('Make a variation of "Make it festive for Diwali"');
    expect(askPrompt(B)).toBe('About "Make it festive for Diwali": ');
    expect(a.variation).toBe(`/chat/${LIBRARY_CHAT_WITH}?q=${encodeURIComponent('Make a variation of "Make it festive for Diwali"')}`);
    expect(a.ask).toBe(chatPrefill(askPrompt(B)));
    expect(sheetActions(A).decide).toBe(false);          // declined: nothing to decide
    expect(sheetActions(PHOTO).decide).toBe(false);      // the owner's own photo
    expect(sheetActions({ ...B, approvalId: null }).decide).toBe(false);
    expect(sheetActions(CLIP).download.filename).toBe("clip-from-option-b.mp4");
  });
});

describe("a photo attached in the chat", () => {
  it("takes JPEG, PNG or WebP up to 20 MB, and says why not otherwise", () => {
    expect(photoProblem({ type: "image/jpeg", size: 2_000_000 })).toBeNull();
    expect(photoProblem({ type: "image/webp", size: 10 })).toBeNull();
    expect(photoProblem({ type: "image/gif", size: 10 })).toBe("Send a JPEG, PNG or WebP photo.");
    expect(photoProblem({ type: "application/pdf", size: 10 })).toBe("Send a JPEG, PNG or WebP photo.");
    expect(photoProblem({ type: "image/png", size: 21 * 1024 * 1024 })).toBe("That photo is too large: send one under 20 MB.");
    expect(photoProblem({ type: "image/png", size: 0 })).toBe("That file is empty.");
  });

  it("sends the owner's words with it, or says what a photo with no words is for (the same words as the server)", () => {
    expect(photoQuestion("  make this a premium ad ")).toBe("make this a premium ad");
    expect(photoQuestion("")).toBe(DEFAULT_PHOTO_NOTE);
    expect(DEFAULT_PHOTO_NOTE).toBe(SERVER_NOTE);
    expect(PHOTO_PLACEHOLDER).toMatch(/Diwali post/);
  });
});

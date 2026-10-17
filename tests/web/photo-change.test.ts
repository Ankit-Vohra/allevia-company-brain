// Changing a photo's card from the chat's card and the Library sheet (web/src/lib/library.ts, drawn by web/src/components/MadeCard.tsx
// and web/src/pages/Library.tsx): which cards and pictures offer Change and the 5 second clip, what a change sends, the words it shows
// in the thread (the same as the server's), and the cost lines. The words follow docs/owner-words.md: no ids, models, steps or "variant".
import { describe, expect, it } from "vitest";
import type { AgentEvent, LibraryItem } from "../../shared/contracts.js";
import { ownerJargon } from "../../src/agent/style.js";
import { changeQuestion as serverQuestion } from "../../src/server/routes/chat-photo.js";
import {
  CHANGE_COST, CHANGE_PLACEHOLDER, CLIP_COST, canChangeCard, canClipOption, changeFrom, changeQuestion, clipWords, sheetChange,
} from "../../web/src/lib/library.js";

type Made = Extract<AgentEvent, { type: "deliverable" }>;
const card = (over: Partial<Made> = {}): Made => ({
  type: "deliverable", agent: "content-strategist", kind: "image", title: "A post from the front", approvalId: "approval:1", recommended: "asset:a", notes: [],
  options: [
    { assetId: "asset:a", label: "A", badge: "ok", note: "", thumb: "", aiEdited: false },
    { assetId: "asset:b", label: "B", badge: "held", note: "a sign was added", thumb: "", aiEdited: true },
  ],
  ...over,
});
const item = (over: Partial<LibraryItem>): LibraryItem => ({
  id: "asset:b", title: "Make it festive", kind: "picture", media: "image", mine: false, state: "waiting", approvalId: "approval:1", at: 1, credits: null, label: "B", check: "ok",
  url: "", thumb: "", ...over,
});

describe("Change and the clip on the chat's card", () => {
  it("only a photo's card (the Studio's) gets the Change field and the clip; posters and older cards keep Change in the box", () => {
    expect(canChangeCard(card({ studio: true }))).toBe(true);
    expect(canChangeCard(card())).toBe(false);
    expect(canChangeCard(card({ studio: true, kind: "clip" }))).toBe(false);
    expect(canChangeCard(card({ kind: "poster" }))).toBe(false);
  });

  it("a clip is offered only from an option Fact Checker passed", () => {
    const m = card({ studio: true });
    expect(m.options.map((o) => canClipOption(m, o))).toEqual([true, false]);
    expect(canClipOption(card(), m.options[0]!)).toBe(false);
  });

  it("what a change sends: the owner's words for the Studio's change path, trimmed and capped; nothing for an empty box", () => {
    expect(changeFrom("  make it warmer ", { approvalId: "approval:1" })).toEqual({ approvalId: "approval:1", instruction: "make it warmer" });
    expect(changeFrom("brighter", { approvalId: "approval:1", variantId: "asset:b", sessionId: "s1" })).toEqual({ approvalId: "approval:1", instruction: "brighter", variantId: "asset:b", sessionId: "s1" });
    expect(changeFrom("x".repeat(600), { approvalId: "approval:1" })).toMatchObject({ instruction: "x".repeat(400) });
    expect(changeFrom("   ", { approvalId: "approval:1" })).toBeNull();
    expect(changeFrom("warmer", { approvalId: "" })).toBeNull();
  });

  it("the words a change shows in the thread are the server's", () => {
    const cases: Array<[Parameters<typeof changeQuestion>[0], string | undefined]> = [
      [{ approvalId: "a", instruction: "make it warmer" }, "B"],
      [{ approvalId: "a", instruction: "make it warmer" }, undefined],
      [{ approvalId: "a", clip: true, variantId: "asset:a" }, "A"],
      [{ approvalId: "a", clip: true, variantId: "asset:a" }, undefined],
    ];
    for (const [c, label] of cases) {
      const server = serverQuestion({ ...("clip" in c ? { clip: true } : { instruction: c.instruction }), ...(label ? { label } : {}) });
      expect(changeQuestion(c, label)).toBe(server);
    }
    expect(changeQuestion({ approvalId: "a", instruction: "make it warmer" }, "B")).toBe("Change option B: make it warmer");
    expect(changeQuestion({ approvalId: "a", clip: true, variantId: "v" }, "A")).toBe("Make a 5 second clip from option A");
  });

  it("each shows its cost: light and colour free, an AI edit priced as it starts, the clip priced before anything is made", () => {
    expect(CHANGE_COST).toMatch(/free/);
    expect(CHANGE_COST).toMatch(/price/);
    expect(CLIP_COST).toMatch(/nothing is made until you say yes/);
    expect(clipWords()).toBe("Make a 5-second clip");
    expect(clipWords("about 7.5 Studio credits")).toBe("Make the clip (about 7.5 Studio credits)");
    for (const w of [CHANGE_COST, CHANGE_PLACEHOLDER, CLIP_COST, clipWords(), clipWords("about 2 Studio credits")]) {
      expect(ownerJargon(w)).toEqual([]);
      expect(w).not.toMatch(/variant|asset|approval/i);
    }
  });
});

describe("Change and the clip on the Library sheet", () => {
  it("a picture from a photo's card that waits can be changed; a checked one can also become a clip", () => {
    expect(sheetChange(item({}))).toEqual({ change: true, clip: true });
    expect(sheetChange(item({ check: "held" }))).toEqual({ change: true, clip: false });
  });

  it("not once it is decided, nor the owner's own photo, a poster, a video, or a picture no card proposes", () => {
    for (const over of [{ state: "approved" as const }, { state: "posted" as const }, { mine: true, kind: "your-photo" as const }, { kind: "poster" as const }, { media: "video" as const, kind: "clip" as const }, { approvalId: null }]) {
      expect(sheetChange(item(over))).toEqual({ change: false, clip: false });
    }
  });
});

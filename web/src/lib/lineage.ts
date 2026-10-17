// The Studio page's "How this was made": a photo's history in four plain steps (your photo, the options made from it, your OK, the post),
// told from the graph's lineage read (GET /api/:t/assets/:id/lineage, src/studio/lineage.ts). Pure words, no drawing: the page draws it.
// No ids, models or edges reach the owner: an option is "A, a free clean-up" or "B, an AI edit", the check is Nisha's, the cost is in
// Studio credits.
import type { Lineage, LineageAsset } from "../../../shared/contracts.js";

export interface StoryAsset {
  id: string;
  label: string;                         // "A", "B"; "Your photo" for the original
  what: string;                          // "Free clean-up", "AI edit", "5 second clip"
  check: "ok" | "held" | "unchecked" | null;
  chosen: boolean;
}
export interface StoryStep {
  key: "photo" | "options" | "approved" | "posted";
  title: string;
  line: string;
  state: "done" | "waiting" | "none";    // done: it happened; waiting: it is the next thing; none: not reached
  assets: StoryAsset[];
}
export interface LineageStory {
  steps: StoryStep[];
  /** "About 6.5 Studio credits so far", or null when nothing was spent. */
  cost: string | null;
  /** The owner's own rules it followed (names), at most five. */
  followed: string[];
  /** What the checker said about each option, in her words. */
  checks: string[];
}

const creditWords = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)} Studio credit${n === 1 ? "" : "s"}`;
const isClip = (a: LineageAsset): boolean => a.kind === "clip" || a.mediaType === "video";
const PICKED = new Set(["approved", "edited", "executed"]);

// What Content.status says, in the owner's words (PostStatus in src/publish/types.ts, and "draft" from a Studio card that only saves).
const POST_WORDS: Record<string, string> = {
  draft: "Saved as a draft post. Nothing was posted.",
  scheduled: "Set to post at the time you chose.",
  publishing: "Being posted now.",
  published: "Posted.",
  failed: "It did not go out.",
  cancelled: "The post was cancelled.",
  dry_run: "A practice run: it would have posted.",
};

/** `nameOf` turns a roster id ("fact-checker") into the name the owner knows ("Nisha"). */
export function lineageStory(l: Lineage, nameOf: (rosterId: string) => string | undefined = () => undefined): LineageStory {
  const options = l.descendants.filter((a) => !isClip(a)).sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id));
  const clips = l.descendants.filter(isClip);
  const credits = (id: string): number => l.jobs.filter((j) => j.assetId === id).reduce((s, j) => s + j.credits, 0);
  const asOption = (a: LineageAsset): StoryAsset => {
    const check = a.badge === "unchanged" ? "ok" : a.badge === "unchecked" ? "unchecked" : a.badge ? "held" : null;
    const paid = credits(a.id);
    return {
      id: a.id, label: a.label ?? "", chosen: a.status === "approved", check,
      what: a.aiEdited ? (paid > 0 ? `AI edit, ${creditWords(paid)}` : "AI edit") : "Free clean-up",
    };
  };
  const opts = options.map(asOption);
  const chosen = opts.find((o) => o.chosen);

  const photo: StoryStep = {
    key: "photo", title: "Your photo", state: l.root || l.ancestors.length || l.descendants.length ? "done" : "none",
    line: "As you sent it.",
    assets: [{ id: (l.ancestors.at(-1) ?? l.root)?.id ?? "", label: "Your photo", what: "", check: null, chosen: false }].filter((a) => a.id),
  };

  const heldCount = opts.filter((o) => o.check !== "ok").length;
  const optionsLine = !opts.length
    ? "No options were made."
    : `${opts.length === 1 ? "One option" : `${opts.length} options`}: ${opts.map((o) => `${o.label ? `${o.label}: ` : ""}${o.what}`).join("; ")}.`
      + (heldCount ? ` ${heldCount === opts.length ? "None passed" : `${heldCount} held back by`} the check.` : "")
      + (clips.length ? ` ${clips.length === 1 ? "A 5 second clip was" : `${clips.length} clips were`} made from ${clips.length === 1 ? "one" : "them"}.` : "");
  const options_: StoryStep = { key: "options", title: "Options made", state: opts.length ? "done" : "none", line: optionsLine, assets: opts };

  const cards = l.cards;
  const said = cards.find((c) => PICKED.has(c.status));
  const refused = !said && cards.find((c) => c.status === "rejected");
  const waiting = !said && !refused && cards.some((c) => c.status === "pending");
  const approved: StoryStep = said
    ? { key: "approved", title: "You said OK", state: "done", line: chosen ? `You chose option ${chosen.label || "?"}.` : "You said OK.", assets: [] }
    : refused
      ? { key: "approved", title: "You said no", state: "done", line: "You turned it down. Nothing was posted.", assets: [] }
      : { key: "approved", title: "Your OK", state: waiting ? "waiting" : "none", line: waiting ? "Waiting for your OK." : "No card for it yet.", assets: [] };

  const post = l.posts.find((p) => POST_WORDS[p.status]) ?? l.posts[0];
  const posted: StoryStep = post
    ? { key: "posted", title: post.status === "published" ? "Posted" : post.status === "draft" ? "Saved" : "The post", state: "done", line: POST_WORDS[post.status] ?? `The post is ${post.status}.`, assets: [] }
    : { key: "posted", title: "The post", state: "none", line: said ? "No post was made." : "Nothing is posted until you say OK.", assets: [] };

  const checks = l.reviews
    .filter((r) => r.by.endsWith("-fact-checker") && r.note.trim())
    .map((r) => {
      const label = l.descendants.find((a) => a.id === r.assetId)?.label;
      const who = nameOf("fact-checker") ?? "The checker";
      return `${who}${label ? ` on option ${label}` : ""}: ${r.note.trim().replace(/^Building unchanged · /, "").replace(/^Changed: /, "")}`;
    })
    .slice(0, 4);

  const followed = [...new Set(l.rules.map((r) => r.name.trim()).filter(Boolean))].slice(0, 5);
  return { steps: [photo, options_, approved, posted], cost: l.spent > 0 ? `About ${creditWords(l.spent)} so far.` : null, followed, checks };
}

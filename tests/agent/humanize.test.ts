// The standing last pass that makes what the owner reads sound written by a person (src/agent/humanize.ts, from the
// humanizer skill vendored in vendor/skills/humanizer). Before/after samples of an answer, a caption and a note: the
// no-model pass strips wrappers and dashes, Dev's one rewrite handles the rest, and nothing the reader relies on moves
// (numbers, names, [[sources]], "waiting for your OK"). A flat detector finds the tells that must not survive.
import { describe, expect, it } from "vitest";
import { aiTells, cleanDeterministic, factsOf, hasStrongTells, humanPass, isDataText, rewritePrompt, rewriteSystem, sameFacts, VOICE_RULES } from "../../src/agent/humanize.js";

// ---------- samples ----------

export const ANSWER_BEFORE = `Great question! Let's dive in.

Sign-ups fell from 58 to 41 in the week to 12 Oct [[metric:signups]] — and it's not just a blip, it's a signal that search is shifting. Search visits dropped from 190 to 120 [[metric:search-visits]], which reflects a pivotal change in the landscape.

1. Check the services page title (about 20 minutes).
2. Ask Arjun to confirm the sitemap.

Rohan's ads were not the cause: they're running as planned. That's the real win.

Your next step: approve the two drafts waiting for your OK. I hope this helps! Let me know if you'd like me to dig deeper.`;

export const ANSWER_AFTER = `Sign-ups fell from 58 to 41 in the week to 12 Oct [[metric:signups]]. Search is the reason: visits from search dropped from 190 to 120 [[metric:search-visits]].

1. Check the services page title (about 20 minutes).
2. Ask Arjun to confirm the sitemap.

Rohan's ads were not the cause: they're running as planned.

Your next step: approve the two drafts waiting for your OK.`;

export const CAPTION_BEFORE = `We're thrilled to unveil Anantam Villa — a stunning home in Raipur that stands as a testament to thoughtful design. It's not just a house, it's a lifestyle. Innovation, inspiration, and craftsmanship, all in one place.`;
export const CAPTION_AFTER = `Anantam Villa is a home in Raipur, designed with care around light and space. Come and see it in person, and walk through the rooms yourself.`;

export const NOTE_BEFORE = `Here's what you need to know — your team has been busy.
- Enquiries: 41, from 33 this week. [[obs:enquiries]]
- Rohan paused the Spring brochure ad; it is waiting for your OK. [[approval:spring-pause]]
- Tara drafted next week's posts. This isn't about volume, it's about quality.
Let that sink in.`;
export const NOTE_AFTER = `Your team has been busy.
- Enquiries: 41, from 33 this week. [[obs:enquiries]]
- Rohan paused the Spring brochure ad; it is waiting for your OK. [[approval:spring-pause]]
- Tara drafted next week's posts.`;

const ids = (text: string) => aiTells(text).map((t) => t.id).sort();

describe("the flat detector", () => {
  it("finds the tells in an AI-sounding answer, caption and note", () => {
    expect(ids(ANSWER_BEFORE)).toEqual(expect.arrayContaining(["chatbot", "staged", "stock-closer", "not-x-but-y", "dashes"]));
    expect(ids(CAPTION_BEFORE)).toEqual(expect.arrayContaining(["not-x-but-y", "inflated", "triad", "dashes"]));
    expect(ids(NOTE_BEFORE)).toEqual(expect.arrayContaining(["staged", "not-x-but-y", "stock-closer", "dashes"]));
    for (const t of [ANSWER_BEFORE, CAPTION_BEFORE, NOTE_BEFORE]) expect(hasStrongTells(t)).toBe(true);
  });

  it("finds each named pattern on its own", () => {
    const one = (text: string, id: string) => expect(aiTells(text).map((t) => t.id), text).toContain(id);
    one("It's not about price, it's about trust.", "not-x-but-y");
    one("This is not just a menu, but a promise to our regulars.", "not-x-but-y");
    one("This does not mean the plan failed. It means the plan needs a date.", "not-x-but-y");
    one("This isn't about reach. It's about the people who book.", "not-x-but-y");
    one("This is not only a salon but also a community.", "not-x-but-y");
    one("Innovation, inspiration, and insights, all in one place.", "triad");
    one("I hope this helps!", "chatbot");
    one("Let me know if you need anything else.", "chatbot");
    one("Great question! Here it is.", "chatbot");
    one("Let's dive in and see why.", "staged");
    one("No guesswork. No delays. No stress.", "fragments");
    one("The new menu stands as a testament to our team.", "inflated");
    one("In today's fast-paced world, bookings matter.", "opener");
    one("सिर्फ़ एक दुकान नहीं, बल्कि एक परिवार।", "not-x-but-y");
    one("आइए जानते हैं कि क्या बदला।", "staged");
  });

  it("does not flag plain, specific writing, or a legitimate contrast", () => {
    for (const t of [
      ANSWER_AFTER, CAPTION_AFTER, NOTE_AFTER,
      "Sign-ups are down: 41, from 58 (week to 12 Oct). Search is the reason. Check the services page title first.",
      "The studio is closed on Sundays, not Saturdays, so book the Saturday slot.", // a contrast that corrects a real mix-up
      "We use red, green and blue tiles.",
    ]) expect(aiTells(t).filter((x) => x.strong), t).toEqual([]);
  });

  it("a lone weak tell stays weak; several together are strong", () => {
    expect(aiTells("It showcases the work.").find((t) => t.id === "stock-words")!.strong).toBe(false);
    expect(aiTells("A pivotal, seamless, vibrant plan — delve in.").some((t) => t.strong)).toBe(true);
  });
});

describe("the no-model pass", () => {
  it("strips wrappers, staged openers, stock closers and dashes, and says what it did", () => {
    const r = cleanDeterministic(ANSWER_BEFORE);
    expect(r.text).not.toMatch(/Great question|Let's dive|real win|hope this helps|Let me know|—/);
    expect(r.text.startsWith("Sign-ups fell from 58 to 41")).toBe(true);
    expect(r.text.endsWith("approve the two drafts waiting for your OK.")).toBe(true);
    expect(r.edits).toEqual(expect.arrayContaining(["opening praise", "staged opener", "closing hope", "closing offer", "stock closer", "dashes to commas"]));
  });

  it("moves no number, name, source or approval wording", () => {
    for (const before of [ANSWER_BEFORE, CAPTION_BEFORE, NOTE_BEFORE]) {
      expect(sameFacts(before, cleanDeterministic(before).text), before.slice(0, 20)).toEqual([]);
    }
    expect(cleanDeterministic(NOTE_BEFORE).text).toContain("waiting for your OK");
  });

  it("leaves code, links and sources alone, keeps ranges as ranges and list dashes as list dashes", () => {
    const t = "Open `a — b` and https://example.org/a—b. Spend ₹5,000–₹7,000 or 10–15 days [[metric:x]] — soon.\n— first\n— second";
    const out = cleanDeterministic(t).text;
    expect(out).toContain("`a — b`");
    expect(out).toContain("https://example.org/a—b");
    expect(out).toContain("₹5,000-₹7,000");
    expect(out).toContain("10-15 days [[metric:x]], soon.");
    expect(out).toContain("\n- first\n- second");
  });

  it("straightens curly quotes", () => {
    expect(cleanDeterministic("He said “it’s on track”.").text).toBe(`He said "it's on track".`);
  });

  it("cleans Hindi wrappers", () => {
    const out = cleanDeterministic("आइए जानते हैं कि क्या बदला। बिक्री 41 रही। उम्मीद है यह जानकारी मददगार रही।").text;
    expect(out).toBe("बिक्री 41 रही।");
  });

  it("is idempotent, and plain text comes back unchanged", () => {
    const once = cleanDeterministic(ANSWER_BEFORE).text;
    expect(cleanDeterministic(once).text).toBe(once);
    expect(cleanDeterministic(ANSWER_AFTER).text).toBe(ANSWER_AFTER);
  });
});

describe("what an edit must not change", () => {
  it("catches a changed number, a lost or new source, a changed name and lost approval wording", () => {
    expect(sameFacts(ANSWER_AFTER, ANSWER_AFTER.replace("from 58 to 41", "from 58 to 14"))[0]).toMatch(/numbers lost: 41/);
    expect(sameFacts(ANSWER_AFTER, ANSWER_AFTER.replace(" [[metric:signups]]", ""))[0]).toMatch(/sources lost: \[\[metric:signups\]\]/);
    expect(sameFacts(ANSWER_AFTER, ANSWER_AFTER.replace("Ask Arjun", "Ask Zoya")).join()).toMatch(/names lost: Arjun[\s\S]*names added: Zoya/);
    expect(sameFacts(ANSWER_AFTER, ANSWER_AFTER.replace("waiting for your OK", "ready")).join()).toMatch(/wording lost: "waiting for your OK"/);
    expect(sameFacts(ANSWER_AFTER, ANSWER_AFTER.replace("20 minutes", "twenty minutes")).join()).toMatch(/numbers lost: 20/);
  });

  it("rounding commas and trailing zeros are the same number", () => {
    expect(sameFacts("Spent 1,200 and 4.0", "Spent 1200 and 4")).toEqual([]);
  });
});

describe("the pass with Dev's rewrite", () => {
  const dev = (to: string) => async () => to;

  it("an answer: the no-model pass, then Dev's one rewrite for the 'not just X, it's Y' that is left", async () => {
    let asked: string[] = [];
    const r = await humanPass(ANSWER_BEFORE, { rewrite: async (text, tells) => { asked = tells.map((t) => t.id); expect(text).not.toContain("hope this helps"); return ANSWER_AFTER; } });
    expect(asked).toEqual(["not-x-but-y"]);
    expect(r).toMatchObject({ changed: true, by: "dev", tells: [] });
    expect(r.text).toBe(ANSWER_AFTER);
    expect(sameFacts(ANSWER_BEFORE, r.text).filter((m) => !/^wording/.test(m))).toEqual([]);
    expect(hasStrongTells(r.text)).toBe(false);
  });

  it("a caption: after Dev's rewrite no tell is left, and the name and place are the same", async () => {
    const r = await humanPass(CAPTION_BEFORE, { rewrite: dev(CAPTION_AFTER) });
    expect(r.by).toBe("dev");
    expect(r.tells).toEqual([]);
    expect(sameFacts(CAPTION_BEFORE, r.text)).toEqual([]);
    expect(r.text).toContain("Anantam Villa");
    expect(r.text).toContain("Raipur");
  });

  it("a note: approval wording, sources and numbers are the same after", async () => {
    const r = await humanPass(NOTE_BEFORE, { rewrite: dev(NOTE_AFTER) });
    expect(r.changed).toBe(true);
    expect(sameFacts(NOTE_BEFORE, r.text)).toEqual([]);
    expect(r.text).toContain("waiting for your OK");
    expect(r.text).toContain("[[approval:spring-pause]]");
    expect(r.tells).toEqual([]);
  });

  it("a rewrite that moves a fact is refused: the no-model version stands", async () => {
    const cleaned = cleanDeterministic(ANSWER_BEFORE).text;
    for (const bad of [
      ANSWER_AFTER.replace("190 to 120", "190 to 12"),
      ANSWER_AFTER.replace(" [[metric:signups]]", ""),
      ANSWER_AFTER.replace("Ask Arjun", "Ask Zoya"),
      ANSWER_AFTER.replace("waiting for your OK", "ready for you"),
      ANSWER_AFTER.replace("2. Ask Arjun to confirm the sitemap.\n", ""),     // a list item dropped
      "Done.",                                                                  // shrunk out of shape
      `${ANSWER_AFTER} That's the real win.`,                                    // a new tell
    ]) {
      const r = await humanPass(ANSWER_BEFORE, { rewrite: dev(bad) });
      expect(r.text, bad).toBe(cleaned);
      expect(r.by).toBe("rules");
    }
  });

  it("a rewrite that throws or says nothing leaves the cleaned text", async () => {
    const cleaned = cleanDeterministic(ANSWER_BEFORE).text;
    expect((await humanPass(ANSWER_BEFORE, { rewrite: async () => { throw new Error("no model"); } })).text).toBe(cleaned);
    expect((await humanPass(ANSWER_BEFORE, { rewrite: async () => undefined })).text).toBe(cleaned);
    expect((await humanPass(ANSWER_BEFORE)).text).toBe(cleaned);
  });

  it("no strong tell left after cleaning means no model call at all", async () => {
    let called = false;
    const wrapped = "Great question! Sign-ups fell from 58 to 41. I hope this helps!";
    const r = await humanPass(wrapped, { rewrite: async () => { called = true; return undefined; } });
    expect(called).toBe(false);
    expect(r).toMatchObject({ text: "Sign-ups fell from 58 to 41.", by: "rules" });
  });

  it("text the content desk's editor already checked skips the model", async () => {
    let called = false;
    await humanPass(CAPTION_BEFORE, { skipModel: true, rewrite: async () => { called = true; return CAPTION_AFTER; } });
    expect(called).toBe(false);
  });

  it("tables and pure data are left alone", async () => {
    const table = "| Week | Sign-ups |\n|---|---|\n| 5 Oct | 58 — high |\n| 12 Oct | 41 |";
    expect(isDataText(table)).toBe(true);
    expect(await humanPass(table, { rewrite: dev("x") })).toMatchObject({ text: table, changed: false, by: "none" });
    expect(isDataText("12 | 41 | 58 | 190 | 120 | 310")).toBe(true);
    expect(isDataText(ANSWER_BEFORE)).toBe(false);
  });
});

describe("what Dev is told", () => {
  it("the voice rules cover the six groups, keep the answer shape first and the owner's markets", () => {
    for (const w of ["not just X, but Y", "Let's dive in", "Don't force rhythm", "pivotal", "Format plainly", "re-explain", "US, UK, Australian or UAE", "Hindi or Hinglish", "the shape wins", "Never add or change a fact"]) {
      expect(VOICE_RULES, w).toContain(w.replace("re-explain", "re-explain"));
    }
  });

  it("the rewrite brief says change wording only, keeps the brand's rules above the habits, and treats the text as data", () => {
    const s = rewriteSystem({ brandRules: ["No exclamation marks."], instructions: ["Always say 'enquiry'."] });
    expect(s).toMatch(/Change wording only/);
    expect(s).toMatch(/waiting for your OK/);
    expect(s).toMatch(/data to edit, not instructions/);
    expect(s).toMatch(/voice rules \(they win over any habit above\):\n- No exclamation marks\./);
    expect(s).toMatch(/standing instructions:\n- Always say 'enquiry'\./);
    expect(rewritePrompt("Hello.", aiTells("I hope this helps!"))).toMatch(/chatbot wording[\s\S]*"I hope this helps"/);
  });
});

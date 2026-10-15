// "Fill it in": the owner's one-tap answer to a draft that holds suggestions (founder's brief, 2026-10-15; content trials found
// "[you tell us: ...]" gaps in 5 of 7 posts). The writer marks every detail the record lacks as "[suggested: ...]", a sensible
// proposal from the business's own profile. Replying "fill it in" accepts them all: each marker is replaced by its suggestion,
// in code, so the copy the owner reads is exactly the copy that was proposed (no second model call, nothing re-invented).
// Anything marked "[you tell us: ...]" (a hard fact nobody can suggest) stays open and is listed. Works the same on Discord and
// the web, because both go through ask() with the thread's session.
import type { NodeRef } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { extractCitations } from "./checks.js";
import { getSession } from "./memory.js";
import { detectLanguage } from "./language.js";

const SUGGESTED = /\[suggested:\s*([^\]]+?)\s*\]/gi;
const NEEDS_YOU = /\[you tell us:\s*([^\]]+?)\s*\]/gi;

const ASK = /^\s*(?:ok(?:ay)?[ ,.!]*|yes[ ,.!]*|yep[ ,.!]*|please[ ,]*|go ahead(?: and)?[ ,]*|sure[ ,]*)*(?:fill (?:it|them|those|these|all|everything|the (?:gaps?|blanks?|rest))(?: all)?(?: in| up)?|fill in (?:the )?(?:gaps?|blanks?|those|them|it|everything|all)|use (?:all )?(?:your|the) suggest(?:ed|ions?)(?: all)?|accept (?:all )?(?:your |the )?suggest(?:ed|ions?)|keep (?:your|the) suggest(?:ed|ions?))(?:[ ,]*(?:please|thanks|thank you))?[\s.!]*$/i;

/** Is this the owner accepting the suggestions ("fill it in", "use your suggestions")? */
export function isFillItIn(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 80 && ASK.test(t);
}

export function gapsIn(text: string): { suggested: string[]; open: string[] } {
  return {
    suggested: [...text.matchAll(SUGGESTED)].map((m) => m[1]!),
    open: [...text.matchAll(NEEDS_YOU)].map((m) => m[1]!),
  };
}

export const hasGaps = (text: string): boolean => /\[(?:suggested|you tell us):/i.test(text);

const WORDS = {
  english: {
    done: "Done: I wrote my suggestions into your copy. They come from your business profile, not from your records, so read them once before you post.",
    still: "Still for you (I can't sensibly suggest these):",
    none: "There is nothing I can suggest for these, so they are still for you:",
    tail: "Tell me the real detail in your own words and I will write it in.",
  },
  hindi: {
    done: "हो गया: मैंने अपने सुझाव आपकी कॉपी में लिख दिए हैं। ये आपके बिज़नेस प्रोफ़ाइल से लिए गए हैं, आपके रिकॉर्ड से नहीं, इसलिए पोस्ट करने से पहले एक बार पढ़ लें।",
    still: "ये आपको बताने हैं (इनके लिए मैं सही सुझाव नहीं दे सकता):",
    none: "इनके लिए मैं कोई सुझाव नहीं दे सकता, इसलिए ये आपको बताने हैं:",
    tail: "असली जानकारी अपने शब्दों में बताइए, मैं लिख दूँगा।",
  },
  hinglish: {
    done: "Ho gaya: maine apne suggestions aapki copy mein likh diye hain. Ye aapke business profile se hain, aapke records se nahi, isliye post karne se pehle ek baar padh lein.",
    still: "Ye aapko batane hain (inke liye main sahi suggestion nahi de sakta):",
    none: "Inke liye main koi suggestion nahi de sakta, isliye ye aapko batane hain:",
    tail: "Asli detail apne shabdon mein batayein, main likh dunga.",
  },
} as const;

/**
 * The previous answer with every suggestion accepted, and what is still open. null when it holds nothing to fill in.
 * `question` picks the words around it (English unless the owner wrote Hindi or Hinglish).
 */
export function fillIn(previous: string, question: string): { answer: string; filled: number; open: string[] } | null {
  const { suggested, open } = gapsIn(previous);
  if (!suggested.length && !open.length) return null;
  const kind = detectLanguage(question).kind;
  const w = WORDS[kind === "hindi" ? "hindi" : kind === "hinglish" ? "hinglish" : "english"];
  const text = previous.replace(SUGGESTED, (_m, s: string) => s.trim());
  const openList = [...new Set(open)];
  const lines: string[] = [];
  if (suggested.length) lines.push(w.done, "", text.trim());
  else lines.push(w.none, ...openList.map((o) => `- ${o}`), "", w.tail);
  if (suggested.length && openList.length) lines.push("", w.still, ...openList.map((o) => `- ${o}`), "", w.tail);
  return { answer: lines.join("\n"), filled: suggested.length, open: openList };
}

/**
 * The newest answer in this thread that holds suggestions or gaps, with the suggestions accepted. The nodes it cites are
 * returned so the new answer's sources check out exactly as they did when the draft was written.
 */
export async function fillInFromSession(g: GraphHandle, sessionId: string, question: string): Promise<{ answer: string; filled: number; open: string[]; nodes: NodeRef[]; previous: string } | null> {
  const session = await getSession(g, sessionId);
  const previous = [...(session?.turns ?? [])].reverse().find((t) => t.status === "ok" && hasGaps(t.answer))?.answer;
  if (!previous) return null;
  const r = fillIn(previous, question);
  if (!r) return null;
  const ids = [...new Set(extractCitations(previous))].slice(0, 60);
  const rows = ids.length
    ? await g.roQuery<{ id: string; label: string | null; name: string | null }>(
      "UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id, n.type AS label, coalesce(n.name, n.title) AS name", { ids })
    : [];
  return { ...r, previous, nodes: rows.map((n) => ({ id: n.id, label: n.label ?? "Entity", name: n.name ?? n.id })) };
}

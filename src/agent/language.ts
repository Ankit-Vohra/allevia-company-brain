// The language of an answer (founder's first live Discord test, 2026-10-15: an English question got a Hinglish answer
// because the business's documents contain Hindi, and "reply in the language of the question" let the model drift).
// The rule is now explicit and decided in code, not left to the model:
// - detectLanguage looks at the question's script and words: English, Hindi (Devanagari), Hinglish (Hindi in Latin
//   letters), another script, or a Latin-script language it cannot name;
// - languageNote turns that (and the business's own `language` preference, when it has one) into one plain instruction
//   that goes into every prompt: the Chief's plan and answer and every desk's work, review and revision;
// - the preference lives on the Business node (`language`: "auto" or absent follows the question), set with
//   setLanguagePreference, read with loadLanguagePreference.
// Names, document titles and quoted data stay as they are in the data: only the writing around them follows the rule.
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";
import { findBusiness } from "../capabilities/ladder.js";

export type LanguageKind = "english" | "hindi" | "hinglish" | "other-script" | "other";

export interface QuestionLanguage {
  kind: LanguageKind;
  /** The script the question is written in. */
  script: "latin" | "devanagari" | "other";
}

// Romanised Hindi words that are not also common English words (so "me", "the", "hi", "to", "par" are not here).
const HINGLISH = new Set((
  "hai hain kya kaam aap aapke aapka aapki aapko mujhe mera meri mere hum hamara hamari hamare tum tumhara nahi nahin " +
  "kab kitna kitne kitni kaise kaisa kyun kyu kahan kidhar kaun kaunsa mein ka ki ke ko aur yeh woh wo tha thi raha rahe rahi " +
  "kar karo karna kare karein kiya kiye batao bataiye bataao dikhao dikhaiye chahiye hoga hogi honge hota hoti abhi kal aaj " +
  "intezaar intezar zaroor zaroori lekin magar bhi sirf bahut thoda thodi accha acha theek sab kuch koi apna apni apne wala wali wale " +
  "paise paisa rupaye grahak sabse jaldi pehle baad liye liya diya diye mila mili mile chal chalo dena lena dekho dekhna " +
  "isme usme isko usko inhe unhe iska uska inka unka kyunki agar toh jo jab tab yahan wahan hamein humein samajh samjhao " +
  "batayein hafta mahina saal din raat subah shaam kaafi bilkul shayad hoon hu hoga rakhna rakho banao banana likho likhna " +
  "bhejo bhejna dikhana pata maloom jaldi dhanyavaad shukriya ghar dukaan dukan bikri kharcha munafa nuksaan"
).split(/\s+/));

const ENGLISH = new Set((
  "the a an and or but if then of to in on at by for with from about as is are was were be been being am do does did done have has had " +
  "what whats what's which who whom whose when where why how that this these those it its it's i me my mine we our us you your he she they them their " +
  "can could will would shall should may might must not no yes any some all each every more most less least much many few other " +
  "up down out over under again here there so than too very just also only still ever never always again into onto per week month day today tomorrow yesterday " +
  "need needs waiting wait show tell give make write draft please thanks thank"
).split(/\s+/));

const scriptOf = (ch: string): "latin" | "devanagari" | "other" | null => {
  if (/\p{Script=Devanagari}/u.test(ch)) return "devanagari";
  if (/\p{Script=Latin}/u.test(ch)) return "latin";
  if (/\p{L}/u.test(ch)) return "other";
  return null;
};

// What to look at: the question without [[ids]], links, numbers and punctuation.
const clean = (text: string): string => text.replace(/\[\[[^\]]*\]\]/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\d+/g, " ");

export function detectLanguage(text: string): QuestionLanguage {
  const prose = clean(text);
  const count = { latin: 0, devanagari: 0, other: 0 };
  for (const ch of prose) {
    const s = scriptOf(ch);
    if (s) count[s]++;
  }
  const letters = count.latin + count.devanagari + count.other;
  if (!letters) return { kind: "english", script: "latin" };
  if (count.devanagari / letters >= 0.3) return { kind: "hindi", script: "devanagari" };
  if (count.other / letters >= 0.3) return { kind: "other-script", script: "other" };
  const tokens = prose.toLowerCase().replace(/[’']/g, "'").split(/[^\p{L}']+/u).filter(Boolean);
  const hin = tokens.filter((t) => HINGLISH.has(t)).length;
  const eng = tokens.filter((t) => ENGLISH.has(t)).length;
  if (hin >= 3 || (hin >= 2 && hin / tokens.length >= 0.2) || (hin >= 1 && eng === 0 && tokens.length <= 4 && hin / tokens.length >= 0.5)) {
    return { kind: "hinglish", script: "latin" };
  }
  if (eng >= 1 || tokens.length <= 3 || hin === 0 && eng / Math.max(1, tokens.length) >= 0.1) return { kind: "english", script: "latin" };
  return { kind: "other", script: "latin" };
}

// Preferences the business can set. "auto" (or nothing) follows the question.
export const LANGUAGE_PREFS = ["auto", "english", "hindi", "hinglish"] as const;
export type LanguagePref = (typeof LANGUAGE_PREFS)[number];

/** What an owner (or a form) wrote for the setting, as a stored value: auto, a known one, or a plain language name. */
export function normaliseLanguagePref(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\s+/g, " ") : "";
  if (!t || t === "auto" || t === "follow the question" || t === "automatic") return "auto";
  if (/^(?:en|eng|english|plain english)$/.test(t)) return "english";
  if (/^(?:hi|hindi|हिंदी|हिन्दी)$/.test(t)) return "hindi";
  if (/^hinglish$/.test(t)) return "hinglish";
  return /^\p{L}[\p{L} -]{1,29}$/u.test(t) ? t : "auto";
}

const KEEP = "Names, document titles, ids and quoted data stay exactly as they are in the records: don't translate or respell them. " +
  "Anything you draft for the owner to post publicly follows the brand's own voice and language rules; your notes around it follow this rule.";

/**
 * The one instruction about language that goes into every prompt. `pref` is the business's own setting (absent or
 * "auto": follow the question).
 */
export function languageNote(question: string, pref?: string): string {
  const p = pref ? normaliseLanguagePref(pref) : "auto";
  if (p === "english") {
    return `LANGUAGE: this business is set to English. Write every word of your output in plain English, even if the owner asks in another language and even if the records are in Hindi or mixed. Never Hinglish. ${KEEP}`;
  }
  if (p === "hindi") {
    return `LANGUAGE: this business is set to Hindi. Write in plain, simple Hindi in Devanagari script, even if the owner asks in another language. ${KEEP}`;
  }
  if (p === "hinglish") {
    return `LANGUAGE: this business is set to Hinglish. Write in the owner's plain Hinglish (Hindi in Latin letters), even if the owner asks in another language. ${KEEP}`;
  }
  if (p !== "auto") {
    return `LANGUAGE: this business is set to ${p}. Write in plain ${p}, even if the owner asks in another language. ${KEEP}`;
  }
  const q = detectLanguage(question);
  switch (q.kind) {
    case "english":
      return `LANGUAGE: the owner wrote in English. Write every word of your output in plain English: no Hindi, no Hinglish, no romanised Hindi, even if the company's documents, notes or names are in Hindi or mixed. ${KEEP}`;
    case "hindi":
      return `LANGUAGE: the owner wrote in Hindi, in Devanagari script. Write in the same plain Hindi, in Devanagari script (not Latin letters). ${KEEP}`;
    case "hinglish":
      return `LANGUAGE: the owner wrote in Hinglish (Hindi in Latin letters). Write in the same plain, easy Hinglish, in Latin letters. ${KEEP}`;
    case "other-script":
      return `LANGUAGE: the owner wrote in a non-Latin script. Reply in exactly the language and script the owner used. ${KEEP}`;
    default:
      return `LANGUAGE: reply in exactly the language and script the owner wrote in, matching its spelling. If it is plain English, that means plain English. ${KEEP}`;
  }
}

// ---------- the business's setting ----------

export async function loadLanguagePreference(g: GraphHandle): Promise<string | undefined> {
  const id = await findBusiness(g);
  if (!id) return undefined;
  const [row] = await g.roQuery<{ language: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.language AS language", { id });
  const p = row?.language ? normaliseLanguagePref(row.language) : "auto";
  return p === "auto" ? undefined : p;
}

export async function setLanguagePreference(g: GraphHandle, raw: unknown, now: number): Promise<string> {
  const id = await findBusiness(g);
  if (!id) throw new Error("There is no business in this graph to set a language on.");
  const pref = normaliseLanguagePref(raw);
  const [row] = await g.roQuery<{ name: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name", { id });
  await upsertNode(g, { type: "Business", id, name: row?.name ?? id, props: { language: pref } }, now);
  return pref;
}

// ---------- the setting, in the owner's words ----------

const LANG_WORDS = "english|hindi|hinglish|हिंदी|हिन्दी|spanish|french|german|arabic|gujarati|marathi|tamil|telugu|bengali|punjabi|urdu|portuguese";
const PERSISTENT = /\b(?:from now on|always|by default|going forward|from here on|every time|each time|in future|henceforth)\b/i;
const SPEAK = String.raw`(?:answer|reply|respond|write|talk|speak|answering|replying|writing)`;

/**
 * "Always answer in English" / "reply in Hindi from now on" / "reply in the language I write in": the language setting.
 * Needs a standing marker ("from now on", "always"), so "can you write this post in Hindi?" is still just a question.
 * null when the words are not about the setting.
 */
export function parseLanguageSetting(words: string): { language: string } | null {
  const t = words.trim();
  if (!t || t.length > 160 || !PERSISTENT.test(t)) return null;
  const follow = /\b(?:in the language i (?:write|ask|use|type)|in my (?:own )?language|the language i (?:write|ask|use|type)|like i (?:write|ask))\b/i.test(t);
  if (follow && new RegExp(String.raw`\b${SPEAK}\b`, "i").test(t)) return { language: "auto" };
  const m = new RegExp(String.raw`\b${SPEAK}\b[^.?!]{0,30}?\b(?:in|using)\s+(${LANG_WORDS})\b`, "iu").exec(t);
  return m ? { language: normaliseLanguagePref(m[1]) } : null;
}

export const LANGUAGE_REPLY = (pref: string): string =>
  pref === "auto"
    ? "Done. I will answer in the language you write in."
    : `Done. From now on I will answer in ${pref === "english" ? "English" : pref === "hindi" ? "Hindi" : pref === "hinglish" ? "Hinglish" : pref}, whatever language you ask in. Say "answer in the language I write in" to go back.`;

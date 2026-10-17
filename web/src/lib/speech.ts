// Talking to the ask box (components/MicButton.tsx): the browser's own speech recognition (SpeechRecognition, or
// webkitSpeechRecognition in Chrome and Safari), in the business's language. Nothing is recorded or sent by Allevia: the
// browser turns speech into words, and the words land in the box for the owner to send as usual.

/** The few members of the Web Speech API the mic uses (TypeScript's DOM types do not include it). */
export interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionCtor = new () => Recognition;

/** The browser's recognizer, or null where there is none (Firefox, older browsers, the server). */
export function speechRecognizer(w: unknown = typeof window === "undefined" ? undefined : window): RecognitionCtor | null {
  if (!w || typeof w !== "object") return null;
  const o = w as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return o.SpeechRecognition ?? o.webkitSpeechRecognition ?? null;
}

// The languages the business's locale maps to as they are (onboard/region.ts sets the locale from the country).
const AS_IS = new Set(["en-IN", "en-GB", "en-US", "en-AU", "en-CA", "hi-IN"]);

/** The recognition language for a business locale: en-IN, en-GB, en-US, en-AU, en-CA or hi-IN; anything else is en-US. */
export function speechLang(locale: string | undefined): string {
  const l = (locale ?? "").trim();
  if (/^hi\b/i.test(l)) return "hi-IN";
  const exact = [...AS_IS].find((x) => x.toLowerCase() === l.toLowerCase());
  return exact ?? "en-US";
}

/** What the box says while the owner talks: what was typed before, then the spoken words. */
export function withSpoken(before: string, spoken: string): string {
  const s = spoken.replace(/\s+/g, " ").trim();
  if (!s) return before;
  const b = before.replace(/\s+$/, "");
  return b ? `${b} ${s}` : s;
}

/** All the words heard so far in one listening, final and in progress. */
export function transcriptOf(results: ArrayLike<ArrayLike<{ transcript: string }>>): string {
  let out = "";
  for (let i = 0; i < results.length; i++) out += results[i]?.[0]?.transcript ?? "";
  return out;
}

/** What to tell the owner when listening stops on an error; null when it just ended (no speech, or they stopped it). */
export function speechProblem(error: string): string | null {
  if (error === "not-allowed" || error === "service-not-allowed") return "Allow the microphone for this site to talk to your team.";
  if (error === "audio-capture") return "No microphone was found.";
  if (error === "network") return "Talking needs an internet connection.";
  return null; // "no-speech", "aborted": nothing to say
}

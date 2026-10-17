// The microphone on the ask box (Home) and the chat box: tap to talk, the words appear in the box as they are heard, and
// listening stops on a tap or when the owner pauses. The owner then sends as usual. Speech is turned into words by the
// browser (lib/speech.ts), in the business's language; where the browser cannot, there is no button.
import { useEffect, useRef, useState } from "react";
import { speechLang, speechProblem, speechRecognizer, transcriptOf, withSpoken, type Recognition } from "../lib/speech";
import { Icon } from "./Icon";
import "./mic.css";

export function MicButton({ locale, value, onText, disabled, className }: {
  /** The business's locale (en-IN, en-GB, en-US, hi-IN …): the language listened for. */
  locale: string | undefined;
  /** What the box says now: spoken words are added after it. */
  value: string;
  onText: (text: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [Ctor] = useState(() => speechRecognizer());
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);

  useEffect(() => () => rec.current?.abort(), []);
  useEffect(() => { if (disabled) rec.current?.stop(); }, [disabled]);
  useEffect(() => {
    if (!problem) return;
    const t = window.setTimeout(() => setProblem(null), 6000);
    return () => window.clearTimeout(t);
  }, [problem]);

  if (!Ctor) return null;

  const start = () => {
    setProblem(null);
    const r = new Ctor();
    r.lang = speechLang(locale);
    r.interimResults = true;
    r.continuous = false; // a pause ends it
    r.maxAlternatives = 1;
    const before = value;
    r.onresult = (e) => onText(withSpoken(before, transcriptOf(e.results)));
    r.onerror = (e) => setProblem(speechProblem(e.error));
    r.onend = () => { setListening(false); if (rec.current === r) rec.current = null; };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
      setProblem("The microphone could not start. Try again.");
    }
  };
  const toggle = () => (listening ? rec.current?.stop() : start());

  return (
    <span className="mic">
      <button
        type="button" className={`mic-btn${listening ? " is-listening" : ""}${className ? ` ${className}` : ""}`} onClick={toggle}
        disabled={disabled && !listening} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Talk instead of typing"}
        title={problem ?? (listening ? "Listening… tap to stop" : "Talk instead of typing")}
      >
        <Icon name="mic" size={18} />
        {listening && <span className="mic-dot" aria-hidden="true" />}
      </button>
      <span className={problem && !listening ? "mic-problem" : "visually-hidden"} role="status" aria-live="polite">{listening ? "Listening" : problem ?? ""}</span>
    </span>
  );
}

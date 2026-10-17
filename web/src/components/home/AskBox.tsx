// Home's ask box: one line to start a chat with the whole team. It is the same chat as /chat (the question is sent at once
// and the conversation opens there); on Discord the same thing is /ask. The microphone (where the browser can listen)
// writes the spoken question into the box.
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { askPath } from "../../lib/chat";
import { Icon } from "../Icon";
import { MicButton } from "../MicButton";

export function AskBox({ suggestions, locale }: { suggestions: string[]; locale?: string | undefined }) {
  const [text, setText] = useState("");
  const nav = useNavigate();
  const go = (q: string) => {
    const question = q.trim();
    if (question) nav(askPath(question));
  };
  const submit = (e: FormEvent) => { e.preventDefault(); go(text); };
  return (
    <section className="hm-ask" aria-label="Ask your team">
      <form className="hm-ask-bar" onSubmit={submit} role="search">
        <label htmlFor="hm-ask-q" className="visually-hidden">Ask your team anything</label>
        <span className="hm-ask-icon" aria-hidden="true"><Icon name="ask" size={20} /></span>
        <input
          id="hm-ask-q" className="hm-ask-input" placeholder="Ask your team anything…" value={text} autoComplete="off" enterKeyHint="send"
          onChange={(e) => setText(e.target.value)}
        />
        <MicButton locale={locale} value={text} onText={setText} />
        <button type="submit" className="btn btn-gold hm-ask-go" disabled={!text.trim()}>Ask <Icon name="send" size={16} /></button>
      </form>
      {suggestions.length > 0 && (
        <ul className="hm-chips" aria-label="Try asking">
          {suggestions.map((s) => <li key={s}><button type="button" className="hm-chip" onClick={() => go(s)}>{s}</button></li>)}
        </ul>
      )}
    </section>
  );
}

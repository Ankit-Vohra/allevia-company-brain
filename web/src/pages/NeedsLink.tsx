import { useState, type FormEvent } from "react";
import { openWithToken, tokenFrom } from "../lib/link";

/** Shown instead of the app when the server asks for an owner link (ALLEVIA_AUTH=1) and none has been opened in this browser. */
export function NeedsLink({ failed }: { failed: boolean }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "bad">(failed ? "bad" : "idle");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const token = tokenFrom(text);
    if (!token) { setState("bad"); return; }
    setState("busy");
    const r = await openWithToken(token);
    if (r.opened) location.reload();
    else setState("bad");
  }

  return (
    <main className="needs-link">
      <div className="wordmark"><span className="wordmark-text">Allevia</span><span className="wordmark-mark" aria-hidden="true" /></div>
      <h1>This business is private</h1>
      <p>Open it with the link your Allevia team sent you. It looks like <code>https://…/#key=…</code>. Open that link in this browser, or paste it here.</p>
      <form onSubmit={submit}>
        <label htmlFor="owner-link">Your link</label>
        <input id="owner-link" name="owner-link" type="password" autoComplete="off" spellCheck={false} value={text}
          onChange={(e) => { setText(e.target.value); if (state === "bad") setState("idle"); }} placeholder="Paste your link" />
        <button className="btn btn-gold" type="submit" disabled={state === "busy" || !text.trim()}>{state === "busy" ? "Opening…" : "Open"}</button>
      </form>
      {state === "bad" && <p role="alert" className="needs-link-bad">That link is not valid any more. Ask your Allevia team for a new one.</p>}
      <style>{`
        .needs-link { max-width: 34rem; margin: 12vh auto 0; padding: 0 var(--space-md); display: grid; gap: var(--space-md); color: var(--color-ink); }
        .needs-link h1 { font-family: var(--font-display); font-weight: 400; font-size: var(--text-xl); margin: 0; }
        .needs-link p { color: var(--color-muted); margin: 0; line-height: 1.5; }
        .needs-link code { font-family: var(--font-mono); font-size: var(--text-sm); }
        .needs-link form { display: grid; gap: var(--space-xs); }
        .needs-link label { font-size: var(--text-sm); font-weight: 600; }
        .needs-link input { font: inherit; padding: 10px 12px; border: var(--rule); border-radius: var(--radius-sm); background: var(--color-card); color: inherit; }
        .needs-link .needs-link-bad { color: var(--color-bad); }
      `}</style>
    </main>
  );
}

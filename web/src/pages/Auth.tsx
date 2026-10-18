// Signing in, signing up, an invite and a reset link (with ALLEVIA_AUTH=1). One calm column that works on a phone, in the app's
// paper-and-ink look; no business is needed to show these. A success reloads the app (location.assign), so it starts again from
// what the server says this browser may open: a new account goes straight to setting up its business.
import { useEffect, useId, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { BrowserRouter, Link, Route, Routes, useParams } from "react-router";
import { ApiError } from "../lib/sse";
import { accountApi, forgetDemo, nextPath, type Account, type InvitePreview } from "../lib/account";
import { openWithToken, tokenFrom } from "../lib/link";
import { Reveal } from "../components/Reveal";
import "./auth.css";

const MIN_PASSWORD = 10;
const words = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong. Try again in a moment.");

export function AuthApp({ account, demo }: { account: Account | null; demo: boolean }) {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage demo={demo} />} />
        <Route path="/signup" element={<SignupPage demo={demo} />} />
        <Route path="/invite/:code" element={<InvitePage account={account} />} />
        <Route path="/reset/:code" element={<ResetPage />} />
        <Route path="*" element={<LoginPage demo={demo} />} />
      </Routes>
    </BrowserRouter>
  );
}

function Shell({ title, lede, children, foot }: { title: string; lede?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  useEffect(() => { document.title = `${title} · Allevia`; }, [title]);
  return (
    <main className="auth" id="main">
      <a className="wordmark auth-mark" href="/" aria-label="Allevia">
        <span className="wordmark-text">allevia</span>
        <span className="wordmark-mark" aria-hidden="true" />
      </a>
      <div className="auth-card">
        <h1 className="page-title">{title}</h1>
        {lede && <p className="auth-lede">{lede}</p>}
        {children}
      </div>
      {foot && <div className="auth-foot">{foot}</div>}
    </main>
  );
}

function Field({ label, hint, ...input }: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="label">
      <span>{label}{hint && <> <span className="hint">{hint}</span></>}</span>
      <input className="field auth-field" {...input} />
    </label>
  );
}

function PasswordField({ label, hint, value, onChange, autoComplete }: { label: string; hint?: string; value: string; onChange: (v: string) => void; autoComplete: string }) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="label auth-password">
      <label htmlFor={id}>{label}{hint && <> <span className="hint">{hint}</span></>}</label>
      <div className="auth-password-row">
        <input id={id} className="field auth-field" type={shown ? "text" : "password"} autoComplete={autoComplete} value={value}
          onChange={(e) => onChange(e.target.value)} required spellCheck={false} autoCapitalize="off" />
        <button type="button" className="btn btn-quiet btn-sm auth-show" onClick={() => setShown((s) => !s)} aria-pressed={shown}>{shown ? "Hide" : "Show"}</button>
      </div>
    </div>
  );
}

function useSubmit(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (err) {
      setError(words(err));
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

// The demo business, read-only, without an account (only when the server has one)
// The demo opens on Blue Tokai (real public data plus labelled sample numbers); a server without it falls back to its first business.
const DEMO_HREF = "/?demo=1&tenant=bluetokai";
const DemoLink = ({ demo }: { demo: boolean }) => (demo ? <a href={DEMO_HREF}>See the demo</a> : null);
/** On the sign-in page, above the form: a visitor (or a judge) can look around without an account. */
const DemoButton = ({ demo }: { demo: boolean }) => (demo ? <a className="btn btn-ghost auth-demo" href={DEMO_HREF}>See the live demo, no sign-in needed</a> : null);

// ---------------------------------------------------------------- sign in

function LoginPage({ demo }: { demo: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await accountApi.login({ email: email.trim(), password });
    forgetDemo();
    location.assign(nextPath("/"));
  });
  return (
    <Shell
      title="Sign in"
      lede="Your business, your team and everything they know."
      foot={<><span>New here? <Link to="/signup">Create an account</Link></span><DemoLink demo={demo} /></>}
    >
      <DemoButton demo={demo} />
      <form className="auth-form" onSubmit={submit} aria-label="Sign in">
        <Field label="Email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <PasswordField label="Password" autoComplete="current-password" value={password} onChange={setPassword} />
        {error && <p className="notice notice-bad" role="alert">{error}</p>}
        <button className="btn btn-gold auth-go" type="submit" disabled={busy || !email.trim() || !password}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="auth-small">Forgot your password? Write to us and we'll send you a link to choose a new one.</p>
      <OwnerLink />
    </Shell>
  );
}

// The owner links businesses were opened with before accounts still work: paste one here.
function OwnerLink() {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "bad">("idle");
  const open = async (e: FormEvent) => {
    e.preventDefault();
    const token = tokenFrom(text);
    if (!token) { setState("bad"); return; }
    setState("busy");
    const r = await openWithToken(token);
    if (r.opened) location.assign(r.tenant ? `/?tenant=${encodeURIComponent(r.tenant)}` : "/");
    else setState("bad");
  };
  return (
    <Reveal label="Have an owner link instead?" className="auth-owner-link">
      <form className="auth-form" onSubmit={open} aria-label="Open with your owner link">
        <Field label="Your owner link" type="password" autoComplete="off" spellCheck={false} placeholder="https://…/#key=…" value={text}
          onChange={(e) => { setText(e.target.value); if (state === "bad") setState("idle"); }} />
        {state === "bad" && <p className="notice notice-bad" role="alert">That link is not valid any more. Ask for a new one.</p>}
        <button className="btn btn-ghost" type="submit" disabled={state === "busy" || !text.trim()}>{state === "busy" ? "Opening…" : "Open"}</button>
      </form>
    </Reveal>
  );
}

// ---------------------------------------------------------------- sign up

function SignupForm({ submitLabel, onDone }: { submitLabel: string; onDone: (a: Account) => Promise<void> | void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const short = password.length > 0 && [...password].length < MIN_PASSWORD;
  const { busy, error, submit } = useSubmit(async () => {
    if ([...password].length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for your password.`);
    const a = await accountApi.signup({ name: name.trim(), email: email.trim(), password });
    forgetDemo();
    await onDone(a);
  });
  return (
    <form className="auth-form" onSubmit={submit} aria-label="Create your account">
      <Field label="Your name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      <Field label="Email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <PasswordField label="Password" hint={`at least ${MIN_PASSWORD} characters`} autoComplete="new-password" value={password} onChange={setPassword} />
      {short && !error && <p className="auth-small" aria-live="polite">{MIN_PASSWORD - [...password].length} more to go.</p>}
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
      <button className="btn btn-gold auth-go" type="submit" disabled={busy || !name.trim() || !email.trim() || !password}>{busy ? "One moment…" : submitLabel}</button>
    </form>
  );
}

function SignupPage({ demo }: { demo: boolean }) {
  return (
    <Shell
      title="Create your account"
      lede={<>Then paste your website, and we set your team up in about two minutes. Your free trial has <b>100 credits for 14 days</b>.</>}
      foot={<><span>Have an account? <Link to="/login">Sign in</Link></span><DemoLink demo={demo} /></>}
    >
      {/* a new account goes straight to setting up its business; one that already had a business goes home */}
      <SignupForm submitLabel="Create my account" onDone={(a) => location.assign(a.businesses.length ? "/" : "/onboard")} />
    </Shell>
  );
}

// ---------------------------------------------------------------- an invite

function InvitePage({ account }: { account: Account | null }) {
  const { code = "" } = useParams();
  const [preview, setPreview] = useState<InvitePreview | null | undefined>(undefined);
  const [have, setHave] = useState(false); // "I have an account": sign in instead of signing up
  useEffect(() => {
    let live = true;
    accountApi.invite(code).then((p) => { if (live) setPreview(p); }, () => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [code]);
  const accept = async () => {
    const r = await accountApi.accept(code);
    location.assign(`/?tenant=${encodeURIComponent(r.tenant)}`);
  };
  const joining = useSubmit(accept);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signingIn = useSubmit(async () => {
    await accountApi.login({ email: email.trim(), password });
    await accept();
  });

  if (preview === undefined) return <Shell title="Opening your invite…"><span className="skeleton auth-skeleton" /></Shell>;
  if (preview === null) {
    return (
      <Shell title="This invite has run out" lede="An invite link works once, for 7 days. Ask the person who sent it for a new one." foot={<Link to="/login">Sign in</Link>}>
        {null}
      </Shell>
    );
  }
  const role = preview.role === "owner" ? "an owner" : "a teammate";
  const title = `Join ${preview.business.name}`;
  if (account) {
    return (
      <Shell title={title} lede={<>You're signed in as <b>{account.user.email}</b>. You'll join as {role}.</>}>
        <form className="auth-form" onSubmit={joining.submit}>
          {joining.error && <p className="notice notice-bad" role="alert">{joining.error}</p>}
          <button className="btn btn-gold auth-go" type="submit" disabled={joining.busy}>{joining.busy ? "Joining…" : `Join ${preview.business.name}`}</button>
        </form>
      </Shell>
    );
  }
  return (
    <Shell
      title={title}
      lede={`You're invited to join as ${role}. ${have ? "Sign in, and you're in." : "Create your account, and you're in."}`}
      foot={<button type="button" className="auth-switch" onClick={() => setHave((h) => !h)}>{have ? "New here? Create an account" : "Have an account? Sign in"}</button>}
    >
      {have ? (
        <form className="auth-form" onSubmit={signingIn.submit} aria-label="Sign in and join">
          <Field label="Email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <PasswordField label="Password" autoComplete="current-password" value={password} onChange={setPassword} />
          {signingIn.error && <p className="notice notice-bad" role="alert">{signingIn.error}</p>}
          <button className="btn btn-gold auth-go" type="submit" disabled={signingIn.busy || !email.trim() || !password}>{signingIn.busy ? "Joining…" : "Sign in and join"}</button>
        </form>
      ) : (
        <SignupForm submitLabel="Create my account and join" onDone={accept} />
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------- a reset link

function ResetPage() {
  const { code = "" } = useParams();
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    if ([...password].length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for your password.`);
    await accountApi.reset({ code, password });
    location.assign("/");
  });
  return (
    <Shell title="Choose a new password" lede="It signs you out everywhere else, and in here." foot={<Link to="/login">Sign in instead</Link>}>
      <form className="auth-form" onSubmit={submit} aria-label="Choose a new password">
        <PasswordField label="New password" hint={`at least ${MIN_PASSWORD} characters`} autoComplete="new-password" value={password} onChange={setPassword} />
        {error && <p className="notice notice-bad" role="alert">{error}</p>}
        <button className="btn btn-gold auth-go" type="submit" disabled={busy || !password}>{busy ? "Saving…" : "Save and sign in"}</button>
      </form>
    </Shell>
  );
}

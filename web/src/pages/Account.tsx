// Your account (with ALLEVIA_AUTH=1): who you are signed in as, the businesses you can open, a new password, and signing out.
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { accountApi, signOut } from "../lib/account";
import { ApiError } from "../lib/sse";
import { useApp } from "../state/app";
import "./auth.css";

const MIN_PASSWORD = 10;

export default function AccountPage() {
  const { account, authRequired, setTenant } = useApp();
  if (!authRequired || !account) {
    return (
      <div className="page-pad account-page">
        <h1 className="page-title">Your account</h1>
        <p className="page-lede">Sign-in is not switched on for this server, so there is no account to show.</p>
      </div>
    );
  }
  return (
    <div className="page-pad account-page">
      <header>
        <h1 className="page-title">Your account</h1>
        <p className="page-lede">Signed in as <b>{account.user.name}</b> ({account.user.email}).</p>
      </header>

      <section className="account-section" aria-labelledby="acct-biz">
        <h2 id="acct-biz" className="section-title">Your businesses</h2>
        {account.businesses.length ? (
          <ul className="account-list">
            {account.businesses.map((b) => (
              <li key={b.id}>
                <Link to="/" onClick={() => setTenant(b.id)}>{b.name}</Link>
                <span className="badge badge-ink">{b.role === "owner" ? "Owner" : "Teammate"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="auth-small">None yet. <Link to="/onboard">Set up your business</Link>.</p>
        )}
      </section>

      <ChangePassword />

      <section className="account-section">
        <button type="button" className="btn btn-ghost" onClick={() => void signOut()}>Sign out</button>
      </section>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: boolean }>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ([...next].length < MIN_PASSWORD) { setState({ error: `Use at least ${MIN_PASSWORD} characters for your new password.` }); return; }
    setState({ busy: true });
    try {
      await accountApi.changePassword({ current, next });
      setCurrent("");
      setNext("");
      setState({ done: true });
    } catch (err) {
      setState({ error: err instanceof ApiError ? err.message : "That did not work. Try again in a moment." });
    }
  };
  return (
    <section className="account-section" aria-labelledby="acct-pw">
      <h2 id="acct-pw" className="section-title">Change your password</h2>
      <p className="auth-small">You stay signed in here; everywhere else signs out.</p>
      <form className="auth-form account-form" onSubmit={submit}>
        <label className="label">Current password
          <input className="field auth-field" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label className="label"><span>New password <span className="hint">at least {MIN_PASSWORD} characters</span></span>
          <input className="field auth-field" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        {state.error && <p className="notice notice-bad" role="alert">{state.error}</p>}
        {state.done && <p className="notice notice-ok" role="status">Your password is changed.</p>}
        <button className="btn" type="submit" disabled={state.busy || !current || !next}>{state.busy ? "Saving…" : "Change password"}</button>
      </form>
    </section>
  );
}

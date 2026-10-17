// Credits on every screen: the top bar's chip ("212 credits left", to the Plan and credits page), and the out-of-credits
// message with its two buttons, "Buy 100 credits" and "Move to Growth". The message shows inline in the chat, and in one
// notice for everything else that can come back with a 402 (an OK, the Studio, the check-up): lib/sse.ts raises the event.
import { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { CREDIT_PACKS, PLAN_BY_ID, isCurrency, type Currency } from "@shared/plans";
import { api, getPublicMode } from "../api";
import { chipWords, packWords, suggestedPlan } from "../lib/credits";
import { fmtMoney } from "../lib/format";
import { ApiError, CREDITS_CHANGED, OUT_OF_CREDITS } from "../lib/sse";
import { useApp, useAsync } from "../state/app";
import { Icon } from "./Icon";
import "./credits.css";

export const creditsChanged = (): void => { window.dispatchEvent(new Event(CREDITS_CHANGED)); };
const APPROVALS_CHANGED = "allevia:approvals-changed"; // TopBar.tsx (not imported: TopBar imports this file)

export function useCurrency(): Currency {
  const { tenant } = useApp();
  const c = tenant.currency?.toUpperCase();
  return c && isCurrency(c) ? c : "USD";
}

/** "212 credits left" in the top bar, to the Plan and credits page. Read again after anything that can spend. */
export function CreditsChip() {
  const { tenant } = useApp();
  const loc = useLocation();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    for (const e of [CREDITS_CHANGED, APPROVALS_CHANGED, OUT_OF_CREDITS]) window.addEventListener(e, on);
    const every = window.setInterval(() => { if (document.visibilityState === "visible") on(); }, 60_000);
    return () => { for (const e of [CREDITS_CHANGED, APPROVALS_CHANGED, OUT_OF_CREDITS]) window.removeEventListener(e, on); window.clearInterval(every); };
  }, []);
  const { data } = useAsync(() => api.credits(tenant.id).catch(() => null), [tenant.id, tick, loc.pathname]);
  if (!data) return null;
  const b = data.balance;
  const had = b.allowance + b.rollover + b.packs + b.trial;
  const tone = b.left <= 0 ? " is-out" : had > 0 && b.left / had < 0.1 ? " is-low" : "";
  return (
    <NavLink to="/plan" className={`credits-chip${tone}`} title="Plan and credits" aria-label={`${chipWords(b)}. Plan and credits.`}>
      <Icon name="layers" size={14} />
      {b.left > 0 ? <span><b>{b.left.toLocaleString()}</b><span className="credits-chip-word"> credits</span><span className="credits-chip-left"> left</span></span> : <span>No credits left</span>}
    </NavLink>
  );
}

/** The owner's sentence and its two buttons. Buying acts at once (in test mode it is recorded for the Allevia team);
 *  moving up a plan opens the Plan and credits page on that plan. */
export function OutOfCreditsMessage({ message, compact = false, onClose }: { message: string; compact?: boolean; onClose?: () => void }) {
  const { tenant } = useApp();
  const nav = useNavigate();
  const cur = useCurrency();
  const credits = useAsync(() => api.credits(tenant.id).catch(() => null), [tenant.id]);
  const next = credits.data ? suggestedPlan(credits.data.balance) : "growth";
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ ok: boolean; text: string } | null>(null);
  const demo = getPublicMode();
  const buy = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.buyPack(tenant.id, CREDIT_PACKS[0]!.id);
      setDone({ ok: true, text: r.message });
      creditsChanged();
    } catch (e) {
      setDone({ ok: false, text: e instanceof ApiError && e.status === 403 ? "Only the business owner can buy credits. Ask them to." : (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [tenant.id]);
  return (
    <div className={`out-of-credits${compact ? " is-compact" : ""}`} role="alert">
      <p className="out-of-credits-text">{message}</p>
      {done ? (
        <p className={`out-of-credits-done${done.ok ? "" : " is-bad"}`}>{done.text}</p>
      ) : demo ? (
        <p className="out-of-credits-done">This is the demo, so nothing can be bought here.</p>
      ) : (
        <div className="out-of-credits-actions">
          <button type="button" className="btn btn-gold btn-sm" disabled={busy} onClick={() => void buy()}>{busy ? "One moment" : packWords(cur, (n, c) => fmtMoney(n, c))}</button>
          {next && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { onClose?.(); nav(`/plan?plan=${next}`); }}>Move to {PLAN_BY_ID[next].name}</button>}
        </div>
      )}
      {onClose && <button type="button" className="btn btn-quiet btn-icon btn-sm out-of-credits-close" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>}
    </div>
  );
}

/** The app shell's notice: shown when an OK, the Studio or the check-up came back out of credits. */
export function OutOfCreditsNotice() {
  const [message, setMessage] = useState<string | null>(null);
  const loc = useLocation();
  useEffect(() => {
    const on = (e: Event) => setMessage((e as CustomEvent<{ message: string }>).detail?.message ?? null);
    window.addEventListener(OUT_OF_CREDITS, on);
    return () => window.removeEventListener(OUT_OF_CREDITS, on);
  }, []);
  useEffect(() => { if (loc.pathname === "/plan") setMessage(null); }, [loc.pathname]);
  if (!message) return null;
  return (
    <div className="out-of-credits-notice">
      <OutOfCreditsMessage message={message} onClose={() => setMessage(null)} />
    </div>
  );
}

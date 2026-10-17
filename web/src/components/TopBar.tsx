import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { signOut } from "../lib/account";
import { type ThemeChoice, useApp, useAsync } from "../state/app";
import { Icon, type IconName } from "./Icon";
import { CreditsChip } from "./Credits";
import { draftRows } from "../lib/group";

// Four places one tap away, then More.
const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "Home", icon: "home", end: true },
  { to: "/chat", label: "Chat", icon: "ask" },
  { to: "/brain", label: "Brain", icon: "brain" },
  { to: "/approvals", label: "Needs your OK", icon: "approvals" },
];

/** The More menu: names only, in two groups. Every screen not in the bar is here. */
const MORE_GROUPS: { label: string; items: { to: string; label: string; icon: IconName }[] }[] = [
  { label: "Your business", items: [
    { to: "/office", label: "Office", icon: "office" },
    { to: "/studio", label: "Studio", icon: "sparkle" },
    { to: "/program", label: "Growth plan", icon: "insights" },
    { to: "/insights", label: "Ideas", icon: "insights" },
  ] },
  { label: "Settings", items: [
    { to: "/connections", label: "Your tools", icon: "link" },
    { to: "/team", label: "Your team", icon: "office" },
    { to: "/plan", label: "Plan and credits", icon: "layers" },
    { to: "/onboard", label: "Add a business", icon: "plus" },
  ] },
];
const MORE_PATHS = MORE_GROUPS.flatMap((g) => g.items.map((i) => i.to));

export const APPROVALS_CHANGED = "allevia:approvals-changed";

export function usePendingApprovals() {
  const { tenant } = useApp();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener(APPROVALS_CHANGED, on);
    return () => window.removeEventListener(APPROVALS_CHANGED, on);
  }, []);
  const { data } = useAsync(() => (tenant.id ? api.approvals(tenant.id) : Promise.resolve([])), [tenant.id, tick]);
  // after folding repeats, so the bar, Home and Needs your OK show the same number
  return draftRows((data ?? []).filter((a) => a.status === "pending"));
}

export function Wordmark() {
  return (
    <NavLink to="/" className="wordmark" aria-label="Allevia, home">
      <span className="wordmark-text">allevia</span>
      <span className="wordmark-mark" aria-hidden="true" />
    </NavLink>
  );
}

function BusinessSwitcher() {
  const { tenants, tenant, setTenant } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="switcher" ref={ref}>
      <button type="button" className="switcher-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="switcher-monogram" aria-hidden="true">{tenant.name.slice(0, 1)}</span>
        <span className="switcher-text">
          <span className="switcher-name">{tenant.name}</span>
          <span className="switcher-domain">{tenant.domain}</span>
        </span>
        <Icon name="chevron" size={16} />
      </button>
      {open && (
        <div className="switcher-menu" role="menu" aria-label="Switch business">
          {tenants.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === tenant.id}
              className="switcher-item"
              onClick={() => { setTenant(t.id); setOpen(false); }}
            >
              <span className="switcher-monogram" aria-hidden="true">{t.name.slice(0, 1)}</span>
              <span className="switcher-text">
                <span className="switcher-name">{t.name}</span>
                <span className="switcher-domain">{t.industry} · {t.domain}</span>
              </span>
              {t.id === tenant.id && <Icon name="check" size={16} />}
            </button>
          ))}
          <button type="button" role="menuitem" className="switcher-item switcher-add" onClick={() => { setOpen(false); nav("/onboard"); }}>
            <span className="switcher-monogram is-add" aria-hidden="true"><Icon name="plus" size={14} /></span>
            <span className="switcher-text"><span className="switcher-name">Set up a new business</span><span className="switcher-domain">From a website URL</span></span>
          </button>
        </div>
      )}
    </div>
  );
}

const THEMES: { id: ThemeChoice; label: string; sub: string; icon: IconName }[] = [
  { id: "light", label: "Light", sub: "Paper and ink, all day", icon: "sun" },
  { id: "dark", label: "Dark", sub: "The night office", icon: "moon" },
  { id: "clock", label: "Follows the office clock", sub: "Dims gently in the evening", icon: "clock" },
];

function ThemeMenu() {
  const { theme, setTheme } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, useCallback(() => setOpen(false), []));
  const cur = THEMES.find((t) => t.id === theme) ?? THEMES[0]!;
  return (
    <div className="more" ref={ref}>
      <button type="button" className="btn btn-quiet btn-icon" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label={`Theme: ${cur.label}`} title={`Theme: ${cur.label}`}>
        <Icon name={cur.icon} />
      </button>
      {open && (
        <div className="switcher-menu more-menu theme-menu" role="menu" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.id} type="button" role="menuitemradio" aria-checked={t.id === theme} className="switcher-item" onClick={() => { setTheme(t.id); setOpen(false); }}>
              <span className="more-icon"><Icon name={t.icon} size={16} /></span>
              <span className="switcher-text"><span className="switcher-name">{t.label}</span><span className="switcher-domain">{t.sub}</span></span>
              {t.id === theme && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useDismiss(open: boolean, ref: RefObject<HTMLDivElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, ref, close]);
}

/** The menu for screens not in the main bar: names only, grouped. */
function MoreMenu({ variant }: { variant: "desktop" | "mobile" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useDismiss(open, ref, useCallback(() => setOpen(false), []));
  const active = MORE_PATHS.includes(loc.pathname);
  return (
    <div className={`more more-${variant}`} ref={ref}>
      {variant === "desktop" ? (
        <button type="button" className={`topnav-link more-btn${active ? " active" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          More <Icon name="chevron" size={15} />
        </button>
      ) : (
        <button type="button" className="btn btn-quiet btn-icon more-btn" aria-haspopup="menu" aria-expanded={open} aria-label="More" onClick={() => setOpen((o) => !o)}>
          <Icon name="menu" />
        </button>
      )}
      {open && (
        <div className="switcher-menu more-menu is-plain" role="menu" aria-label="More">
          {MORE_GROUPS.map((g) => (
            <div key={g.label} className="more-group" role="group" aria-label={g.label}>
              <p className="more-group-label" aria-hidden="true">{g.label}</p>
              {g.items.map((x) => (
                <NavLink key={x.to} to={x.to} role="menuitem" className="more-item">
                  <span className="more-icon"><Icon name={x.icon} size={16} /></span>
                  <span className="switcher-name">{x.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** With sign-in on: the signed-in person (name, their businesses, their account, sign out). */
function AccountMenu() {
  const { account, tenant, setTenant } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useDismiss(open, ref, useCallback(() => setOpen(false), []));
  if (!account) return null;
  const initial = (account.user.name.trim()[0] ?? account.user.email[0] ?? "?").toUpperCase();
  return (
    <div className="more" ref={ref}>
      <button type="button" className="account-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Your account: ${account.user.name}`} title={account.user.name} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">{initial}</span>
      </button>
      {open && (
        <div className="switcher-menu account-menu" role="menu" aria-label="Your account">
          <div className="account-who"><b>{account.user.name}</b><span>{account.user.email}</span></div>
          {account.businesses.length > 0 && <p className="account-menu-label">Your businesses</p>}
          {account.businesses.map((b) => (
            <button key={b.id} type="button" role="menuitemradio" aria-checked={b.id === tenant.id} className="switcher-item"
              onClick={() => { setTenant(b.id); setOpen(false); nav("/"); }}>
              <span className="switcher-monogram" aria-hidden="true">{b.name.slice(0, 1)}</span>
              <span className="switcher-text"><span className="switcher-name">{b.name}</span></span>
              <span className="account-role">{b.role === "owner" ? "Owner" : "Teammate"}</span>
            </button>
          ))}
          <NavLink to="/account" role="menuitem" className="more-item">
            <span className="more-icon"><Icon name="pen" size={16} /></span>
            <span className="switcher-text"><span className="switcher-name">Your account</span><span className="switcher-domain">Your password, and the businesses you're in</span></span>
          </NavLink>
          <button type="button" role="menuitem" className="switcher-item" onClick={() => void signOut()}>
            <span className="more-icon"><Icon name="send" size={16} /></span>
            <span className="switcher-text"><span className="switcher-name">Sign out</span></span>
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const { mode, authRequired, account, tenant } = useApp();
  const pending = usePendingApprovals();
  const none = !tenant.id; // signed in, with no business yet: only setting one up
  return (
    <header className="topbar">
      <div className="topbar-left">
        <Wordmark />
        {!none && <span className="topbar-rule" aria-hidden="true" />}
        {!none && <BusinessSwitcher />}
      </div>
      {!none && (
        <nav className="topnav" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="topnav-link">
              {n.label}
              {n.to === "/approvals" && pending > 0 && <span className="count" aria-label={`${pending} waiting`}>{pending}</span>}
            </NavLink>
          ))}
          <MoreMenu variant="desktop" />
        </nav>
      )}
      <div className="topbar-right">
        {mode === "mock" && (
          <span className="mode-pill" title="The API is not reachable, so the app runs on prepared demo data and scripted runs.">
            <span className="mode-dot" aria-hidden="true" /> Demo data
          </span>
        )}
        {/* the credits of a business you are in; a demo you only look at has none of yours */}
        {!none && !tenant.readOnly && <CreditsChip />}
        {/* looking at the demo without an account: one way in */}
        {authRequired && !account && <a className="btn btn-gold btn-sm account-signup" href="/signup">Sign up free</a>}
        <ThemeMenu />
        {!none && <MoreMenu variant="mobile" />}
        <AccountMenu />
      </div>
    </header>
  );
}

export function TabBar() {
  const pending = usePendingApprovals();
  const { tenant } = useApp();
  if (!tenant.id) return null;
  return (
    <nav className="tabbar" aria-label="Main">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className="tabbar-link">
          <span className="tabbar-icon">
            <Icon name={n.icon} size={20} />
            {n.to === "/approvals" && pending > 0 && <span className="count count-dot" aria-label={`${pending} pending`}>{pending}</span>}
          </span>
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
}

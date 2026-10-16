import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { type ThemeChoice, useApp, useAsync } from "../state/app";
import { Icon, type IconName } from "./Icon";

// At most five primary places; everything else lives under More.
const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "Office", icon: "office", end: true },
  { to: "/chat", label: "Chat", icon: "ask" },
  { to: "/insights", label: "Insights", icon: "insights" },
  { to: "/approvals", label: "Approvals", icon: "approvals" },
  { to: "/studio", label: "Studio", icon: "sparkle" },
];

/** Screens under "More": the growth plan and the plan and credits page (the Studio and Your team have their own entries). */
const MORE_SCREENS: { to: string; label: string; blurb: string; icon: IconName }[] = [
  { to: "/program", label: "Your growth plan", blurb: "Your goals, and how the team is helping", icon: "insights" },
  { to: "/plan", label: "Plan and credits", blurb: "What your plan includes, and this month's use", icon: "layers" },
];

export const APPROVALS_CHANGED = "allevia:approvals-changed";

export function usePendingApprovals() {
  const { tenant } = useApp();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener(APPROVALS_CHANGED, on);
    return () => window.removeEventListener(APPROVALS_CHANGED, on);
  }, []);
  const { data } = useAsync(() => api.approvals(tenant.id), [tenant.id, tick]);
  return data?.filter((a) => a.status === "pending").length ?? 0;
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

/** The menu for screens not in the main bar: setting up a business, and the screens that are coming soon. On a phone
 *  it also holds what the top bar has no room for. */
function MoreMenu({ variant }: { variant: "desktop" | "mobile" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useDismiss(open, ref, useCallback(() => setOpen(false), []));
  const active = MORE_SCREENS.some((x) => loc.pathname === x.to) || ["/team", "/brain", "/onboard"].includes(loc.pathname);
  return (
    <div className={`more more-${variant}`} ref={ref}>
      {variant === "desktop" ? (
        <button type="button" className={`topnav-link more-btn${active ? " active" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          More <Icon name="chevron" size={15} />
        </button>
      ) : (
        <button type="button" className="btn btn-quiet btn-icon more-btn" aria-haspopup="menu" aria-expanded={open} aria-label="More screens" onClick={() => setOpen((o) => !o)}>
          <Icon name="menu" />
        </button>
      )}
      {open && (
        <div className="switcher-menu more-menu" role="menu" aria-label="More screens">
          <NavLink to="/brain" role="menuitem" className="more-item">
            <span className="more-icon"><Icon name="brain" size={16} /></span>
            <span className="switcher-text"><span className="switcher-name">What your team knows</span><span className="switcher-domain">The company brain, and where each fact came from</span></span>
          </NavLink>
          <NavLink to="/team" role="menuitem" className="more-item">
            <span className="more-icon"><Icon name="office" size={16} /></span>
            <span className="switcher-text"><span className="switcher-name">Your team</span><span className="switcher-domain">Tell your team something, switch people on or off</span></span>
          </NavLink>
          <NavLink to="/onboard" role="menuitem" className="more-item">
            <span className="more-icon"><Icon name="plus" size={16} /></span>
            <span className="switcher-text"><span className="switcher-name">Add a business</span><span className="switcher-domain">Set up a new office from a website</span></span>
          </NavLink>
          {MORE_SCREENS.map((x) => (
            <NavLink key={x.to} to={x.to} role="menuitem" className="more-item">
              <span className="more-icon"><Icon name={x.icon} size={16} /></span>
              <span className="switcher-text"><span className="switcher-name">{x.label}</span><span className="switcher-domain">{x.blurb}</span></span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const { mode } = useApp();
  const pending = usePendingApprovals();
  return (
    <header className="topbar">
      <div className="topbar-left">
        <Wordmark />
        <span className="topbar-rule" aria-hidden="true" />
        <BusinessSwitcher />
      </div>
      <nav className="topnav" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="topnav-link">
            {n.label}
            {n.to === "/approvals" && pending > 0 && <span className="count" aria-label={`${pending} waiting`}>{pending}</span>}
          </NavLink>
        ))}
        <MoreMenu variant="desktop" />
      </nav>
      <div className="topbar-right">
        {mode === "mock" && (
          <span className="mode-pill" title="The API is not reachable, so the app runs on prepared demo data and scripted runs.">
            <span className="mode-dot" aria-hidden="true" /> Demo data
          </span>
        )}
        <ThemeMenu />
        <MoreMenu variant="mobile" />
      </div>
    </header>
  );
}

export function TabBar() {
  const pending = usePendingApprovals();
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

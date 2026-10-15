import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { useApp, useAsync } from "../state/app";
import { SOON } from "../lib/soon";
import { Icon, type IconName } from "./Icon";

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "Office", icon: "office", end: true },
  { to: "/ask", label: "Ask", icon: "ask" },
  { to: "/brain", label: "Brain", icon: "brain" },
  { to: "/insights", label: "Insights", icon: "insights" },
  { to: "/approvals", label: "Approvals", icon: "approvals" },
];

export const APPROVALS_CHANGED = "allevia:approvals-changed";

function usePendingApprovals() {
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

function ThemeToggle() {
  const { theme, setTheme } = useApp();
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const icon: IconName = theme === "system" ? "system" : theme === "light" ? "sun" : "moon";
  const label = theme === "system" ? "Theme follows your system" : theme === "light" ? "Light theme" : "Night office";
  return (
    <button type="button" className="btn btn-quiet btn-icon" onClick={() => setTheme(next)} aria-label={`${label}. Switch to ${next === "system" ? "system" : next === "light" ? "light" : "night"}.`} title={label}>
      <Icon name={icon} />
    </button>
  );
}

/** The menu for screens not in the main bar: setting up a business, and the screens that are coming soon. On a phone
 *  it also holds what the top bar has no room for. */
function MoreMenu({ variant }: { variant: "desktop" | "mobile" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const items = SOON.filter((x) => x.id !== "studio"); // the Studio is built: a link of its own, not a "soon" item
  const active = items.some((x) => loc.pathname === x.path) || (variant === "mobile" && loc.pathname === "/onboard");
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
          {variant === "mobile" && (
            <NavLink to="/onboard" role="menuitem" className="more-item">
              <span className="more-icon"><Icon name="plus" size={16} /></span>
              <span className="switcher-text"><span className="switcher-name">Add a business</span><span className="switcher-domain">Build a brain from a website</span></span>
            </NavLink>
          )}
          {variant === "mobile" && (
            <NavLink to="/studio" role="menuitem" className="more-item">
              <span className="more-icon"><Icon name="sparkle" size={16} /></span>
              <span className="switcher-text"><span className="switcher-name">Studio</span><span className="switcher-domain">Turn a phone photo into an on-brand post</span></span>
            </NavLink>
          )}
          {items.map((x) => (
            <NavLink key={x.id} to={x.path} role="menuitem" className="more-item">
              <span className="more-icon"><Icon name={x.icon} size={16} /></span>
              <span className="switcher-text"><span className="switcher-name">{x.nav}</span><span className="switcher-domain">{x.blurb}</span></span>
              <span className="soon-tag">Soon</span>
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
            <Icon name={n.icon} size={17} />
            {n.label}
            {n.to === "/approvals" && pending > 0 && <span className="count" aria-label={`${pending} pending`}>{pending}</span>}
          </NavLink>
        ))}
        <NavLink to="/studio" className="topnav-link">
          <Icon name="sparkle" size={17} />
          Studio
        </NavLink>
        <MoreMenu variant="desktop" />
        <NavLink to="/onboard" className="topnav-link topnav-add">
          <Icon name="plus" size={16} />
          Add a business
        </NavLink>
      </nav>
      <div className="topbar-right">
        {mode === "mock" && (
          <span className="mode-pill" title="The API is not reachable, so the app runs on prepared demo data and scripted runs.">
            <span className="mode-dot" aria-hidden="true" /> Demo data
          </span>
        )}
        <ThemeToggle />
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

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type ApiMode, api, setSignedOutHandler, setSpeed as setApiSpeed, setTenantReadOnly } from "../api";
import { accountApi, type Account } from "../lib/account";
import { chromeMood, useOfficeClock } from "../lib/daylight";
import { setFormatTenant } from "../lib/format";
import type { Tenant } from "../types-ext";

/** Light is the default for everyone. Dark is an explicit choice; "clock" lets the chrome lean with the office's daylight
 *  (a touch dimmer and warmer in the evening, the night office after dark). */
export type ThemeChoice = "light" | "dark" | "clock";

interface AppState {
  mode: ApiMode;
  /** Sign-in is on (ALLEVIA_AUTH=1). */
  authRequired: boolean;
  /** The signed-in account, or null (signed out, or sign-in is off). */
  account: Account | null;
  tenants: Tenant[];
  /** The business on screen. Before an account has set up its first business (and with no demo), a blank one: `id` is "". */
  tenant: Tenant;
  setTenant: (id: string) => void;
  refreshTenants: () => Promise<void>;
  theme: ThemeChoice;
  effectiveTheme: "light" | "dark";
  setTheme: (t: ThemeChoice) => void;
  speed: number;
  setSpeed: (s: number) => void;
  reducedMotion: boolean;
}

const Ctx = createContext<AppState | null>(null);

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage may be blocked */ }
};

function useMedia(query: string) {
  const [match, setMatch] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

const NO_TENANT: Tenant = { id: "", name: "Your business", domain: "", industry: "" };

export function AppProvider({ mode, initialTenants, authRequired = false, account: initialAccount = null, children }: {
  mode: ApiMode; initialTenants: Tenant[]; authRequired?: boolean; account?: Account | null; children: ReactNode;
}) {
  const [tenants, setTenants] = useState(initialTenants);
  const [account, setAccount] = useState(initialAccount);
  // signed in, and the server stops recognising the session (signed out in another tab, expired): start again at sign-in
  useEffect(() => {
    if (!account) return;
    setSignedOutHandler(() => { setSignedOutHandler(null); location.assign(`/login?next=${encodeURIComponent(location.pathname)}`); });
    return () => setSignedOutHandler(null);
  }, [account]);
  const params = new URLSearchParams(location.search);
  const [tenantId, setTenantId] = useState(() => {
    const want = params.get("tenant") ?? read("allevia.tenant");
    const found = initialTenants.find((t) => t.id === want)?.id;
    // a link with ?tenant= picks the business for this tab from then on: the address loses the parameter as the owner moves
    // around, and a reload must not land on another business (where the open conversation does not exist)
    if (found && params.get("tenant")) write("allevia.tenant", found);
    return found ?? initialTenants[0]?.id ?? (authRequired ? "" : "aamdani");
  });
  const [theme, setThemeState] = useState<ThemeChoice>(() => {
    const t = params.get("theme") ?? read("allevia.theme");
    return t === "dark" || t === "clock" ? t : "light";
  });
  const [speed, setSpeedState] = useState(() => {
    const s = Number(params.get("speed") ?? 1);
    return s === 4 ? 4 : 1;
  });
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const clock = useOfficeClock((tenants.find((t) => t.id === tenantId) ?? tenants[0])?.timeZone);
  const mood = theme === "clock" ? chromeMood(clock.minutes) : theme === "dark" ? "night" : "day";
  const effectiveTheme = mood === "night" ? "dark" : "light";

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = effectiveTheme;
    root.dataset.effectiveTheme = effectiveTheme;
    // the installed app's status bar follows the office: peach by day, dark warm at night
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", effectiveTheme === "dark" ? "#2f2621" : "#f4eee3");
    if (mood === "dusk") root.dataset.dusk = "1";
    else delete root.dataset.dusk;
  }, [effectiveTheme, mood]);

  useEffect(() => { setApiSpeed(speed); }, [speed]);

  const setTenant = useCallback((id: string) => { setTenantId(id); write("allevia.tenant", id); }, []);
  const setTheme = useCallback((t: ThemeChoice) => { setThemeState(t); write("allevia.theme", t === "light" ? null : t); }, []);
  const setSpeed = useCallback((s: number) => { setSpeedState(s); setApiSpeed(s); }, []);
  // a business set up or joined: the list, and the account's businesses with it
  const refreshTenants = useCallback(async () => {
    setTenants(await api.tenants());
    if (authRequired && initialAccount) setAccount((await accountApi.me().catch(() => null)) ?? initialAccount);
  }, [authRequired, initialAccount]);

  const tenant = tenants.find((t) => t.id === tenantId) ?? tenants[0] ?? NO_TENANT;
  // set synchronously so this render already formats money and dates for the new business
  setFormatTenant(tenant);
  setTenantReadOnly(tenant.readOnly === true); // likewise: the change buttons are off in this render when the business is a read-only demo
  useEffect(() => { document.documentElement.lang = tenant.locale ?? "en"; }, [tenant.locale]);
  const value = useMemo<AppState>(
    () => ({ mode, authRequired, account, tenants, tenant, setTenant, refreshTenants, theme, effectiveTheme, setTheme, speed, setSpeed, reducedMotion }),
    [mode, authRequired, account, tenants, tenant, setTenant, refreshTenants, theme, effectiveTheme, setTheme, speed, setSpeed, reducedMotion],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** Fetch helper: re-runs when deps change; keeps the last good data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => { if (live) setState({ data, loading: false }); },
      (err: unknown) => { if (live) setState((s) => ({ ...s, error: (err as Error)?.message ?? String(err), loading: false })); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data: state.data, error: state.error, loading: state.loading, reload: () => setTick((t) => t + 1) };
}

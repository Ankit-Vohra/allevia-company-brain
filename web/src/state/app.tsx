import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type ApiMode, api, setSpeed as setApiSpeed } from "../api";
import { chromeMood, useOfficeClock } from "../lib/daylight";
import { setFormatTenant } from "../lib/format";
import type { Tenant } from "../types-ext";

/** Light is the default for everyone. Dark is an explicit choice; "clock" lets the chrome lean with the office's daylight
 *  (a touch dimmer and warmer in the evening, the night office after dark). */
export type ThemeChoice = "light" | "dark" | "clock";

interface AppState {
  mode: ApiMode;
  tenants: Tenant[];
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

export function AppProvider({ mode, initialTenants, children }: { mode: ApiMode; initialTenants: Tenant[]; children: ReactNode }) {
  const [tenants, setTenants] = useState(initialTenants);
  const params = new URLSearchParams(location.search);
  const [tenantId, setTenantId] = useState(() => {
    const want = params.get("tenant") ?? read("allevia.tenant");
    return initialTenants.find((t) => t.id === want)?.id ?? initialTenants[0]?.id ?? "aamdani";
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
    if (mood === "dusk") root.dataset.dusk = "1";
    else delete root.dataset.dusk;
  }, [effectiveTheme, mood]);

  useEffect(() => { setApiSpeed(speed); }, [speed]);

  const setTenant = useCallback((id: string) => { setTenantId(id); write("allevia.tenant", id); }, []);
  const setTheme = useCallback((t: ThemeChoice) => { setThemeState(t); write("allevia.theme", t === "light" ? null : t); }, []);
  const setSpeed = useCallback((s: number) => { setSpeedState(s); setApiSpeed(s); }, []);
  const refreshTenants = useCallback(async () => { setTenants(await api.tenants()); }, []);

  const tenant = tenants.find((t) => t.id === tenantId) ?? tenants[0]!;
  // set synchronously so this render already formats money and dates for the new business
  setFormatTenant(tenant);
  useEffect(() => { document.documentElement.lang = tenant.locale ?? "en"; }, [tenant.locale]);
  const value = useMemo<AppState>(
    () => ({ mode, tenants, tenant, setTenant, refreshTenants, theme, effectiveTheme, setTheme, speed, setSpeed, reducedMotion }),
    [mode, tenants, tenant, setTenant, refreshTenants, theme, effectiveTheme, setTheme, speed, setSpeed, reducedMotion],
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

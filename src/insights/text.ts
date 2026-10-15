// Number and text helpers for the insight templates, the brief and the action layer. Every figure a template prints
// comes from a detector's numbers; these only format it. Plain, short, no hype: the founder reads these on a phone.

export const DAY_MS = 86_400_000;

export function median(xs: readonly number[]): number | null {
  const s = xs.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;

// 48000 -> "48,000"; 11.25 -> "11.3"; 0.4 -> "0.4".
export function fmt(n: number, decimals?: number): string {
  if (!Number.isFinite(n)) return String(n);
  const d = decimals ?? (Number.isInteger(n) || Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  return n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
}

// 0.004 -> "0.4%"; 0.5 -> "50%".
export function pct(fraction: number, decimals?: number): string {
  const v = fraction * 100;
  return `${fmt(v, decimals ?? (Math.abs(v) >= 10 ? 0 : 1))}%`;
}

// 4.75 -> "4.8×"
export const times = (m: number): string => `${fmt(m, 1)}×`;

const CURRENCY: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€", AUD: "A$", AED: "AED " };

// 300, "INR" -> "₹300"; 12, "count" -> "12".
export function money(n: number, unit?: string | null): string {
  const sym = unit ? CURRENCY[unit.toUpperCase()] : undefined;
  return sym ? `${sym}${fmt(n, 0)}` : fmt(n);
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${fmt(n)} ${n === 1 ? one : many}`;

export const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

// "a", "a and b", "a, b and c"
export function list(xs: readonly string[], max = 3): string {
  const shown = xs.slice(0, max);
  const more = xs.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

// ISO date (YYYY-MM-DD) of an ISO string or epoch ms; undefined when it is not a date.
export function dayOf(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString().slice(0, 10);
  if (typeof v !== "string") return undefined;
  const d = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`)) ? d : undefined;
}

export const dayMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);

export function addDays(d: string, n: number): string {
  return new Date(dayMs(d) + n * DAY_MS).toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-15" -> "15 Oct" (fixed month names: ICU versions disagree on "Sep" and "Sept")
export function shortDate(d: string): string {
  const ms = dayMs(d);
  if (!Number.isFinite(ms)) return d;
  const t = new Date(ms);
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
}

// "2026-10-15" -> "15 Oct 2026"
export function longDate(d: string): string {
  const ms = dayMs(d);
  return Number.isFinite(ms) ? `${shortDate(d)} ${new Date(ms).getUTCFullYear()}` : d;
}

// First letter up: "home page: …" -> "Home page: …".
export const cap1 = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// How the owner says a Page: "jobs page" for "/jobs", "home page" for "/", else its name. No slashes: an owner does not
// think in URL paths.
export function pageLabel(p: { path?: unknown; name?: unknown; id: string }): string {
  if (p.path === "/") return "home page";
  if (typeof p.path === "string" && p.path) return `${p.path.replace(/^\/+|\/+$/g, "")} page`;
  if (typeof p.name === "string" && p.name) return p.name;
  return p.id;
}

// "signup_funnel_otp_verified" -> "Sign-up code verified"; "accounts_created" -> "Accounts created".
export function humanise(key: string): string {
  const s = key.replace(/[_.-]+/g, " ").trim().replace(/\bsignup funnel\b/gi, "sign-up").replace(/\botp\b/gi, "sign-up code").replace(/\bctr\b/gi, "CTR").replace(/\bcpa\b/gi, "CPA");
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

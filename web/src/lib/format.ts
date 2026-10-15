// Numbers, money and dates in the current business's own locale and currency. Allevia is sold to small businesses in
// the US, UK, UAE and Australia (and runs its first two in India), so nothing here assumes a country: the tenant says
// which currency it reports in and how its owner reads dates. AppProvider calls setFormatTenant when the business changes.

export interface FormatTenant { locale?: string; currency?: string; timeZone?: string }

const DEFAULT_LOCALE = "en-GB";
const DEFAULT_CURRENCY = "USD";

let locale = DEFAULT_LOCALE;
let currency = DEFAULT_CURRENCY;
let timeZone: string | undefined;
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function safeLocale(l: string | undefined) {
  if (!l) return DEFAULT_LOCALE;
  try { return Intl.getCanonicalLocales(l)[0] ?? DEFAULT_LOCALE; } catch { return DEFAULT_LOCALE; }
}

export function setFormatTenant(t: FormatTenant | undefined) {
  locale = safeLocale(t?.locale);
  currency = (t?.currency ?? DEFAULT_CURRENCY).toUpperCase();
  timeZone = safeTimeZone(t?.timeZone);
}

function safeTimeZone(z: string | undefined) {
  if (!z) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: z }); return z; } catch { return undefined; }
}

export const currentLocale = () => locale;
export const currentCurrency = () => currency;

function nf(opts: Intl.NumberFormatOptions, loc = locale): Intl.NumberFormat {
  const key = `n|${loc}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.NumberFormat | undefined;
  if (!f) {
    try { f = new Intl.NumberFormat(loc, opts); } catch { f = new Intl.NumberFormat(DEFAULT_LOCALE, { ...opts, currency: opts.currency ? DEFAULT_CURRENCY : undefined }); }
    cache.set(key, f);
  }
  return f;
}

/** Dates and times read on the business's own clock (its time zone), not the viewer's. */
function df(opts: Intl.DateTimeFormatOptions, loc = locale): Intl.DateTimeFormat {
  const key = `d|${loc}|${timeZone ?? ""}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) { f = new Intl.DateTimeFormat(loc, timeZone ? { ...opts, timeZone } : opts); cache.set(key, f); }
  return f;
}

/** 18420 → "18,420" in the business's locale. */
export const fmtNum = (n: number, digits = 0) => nf({ maximumFractionDigits: digits }).format(n);

/** 4100 → "₹4,100" / "£4,100" / "AED 4,100", in the business's currency unless one is given. */
export function fmtMoney(amount: number, cur: string = currency, opts: { compact?: boolean } = {}) {
  return nf({ style: "currency", currency: cur, maximumFractionDigits: amount % 1 === 0 || Math.abs(amount) >= 100 ? 0 : 2, notation: opts.compact ? "compact" : "standard" }).format(amount);
}

/** The currency's symbol on its own ("£", "A$", "AED"), for labels. */
export function currencySymbol(cur: string = currency) {
  const part = nf({ style: "currency", currency: cur }).formatToParts(0).find((p) => p.type === "currency");
  return part?.value ?? cur;
}

export const fmtPct = (n: number, digits = 0) => nf({ style: "percent", maximumFractionDigits: digits }).format(n);

export function fmtMs(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

const parse = (iso?: string) => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** "15 Oct" (or "Oct 15" in en-US), with the year only when it is not this year. */
export function fmtDate(iso?: string, withTime = false) {
  const d = parse(iso);
  if (!d) return iso ?? "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return df({ day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) }).format(d);
}

/** "Thursday, 15 October" for page headers. */
export const fmtLongDate = (d = new Date()) => df({ weekday: "long", day: "numeric", month: "long" }).format(d);

export function fmtAgo(iso?: string) {
  const d = parse(iso);
  if (!d) return "";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 2) return "yesterday";
  if (s < 86400 * 7) return `${Math.round(s / 86400)} days ago`;
  return fmtDate(iso);
}

/** Country, currency and locale a business most likely reports in, read from its website's domain. Used by onboarding
 *  as a first guess the owner can change; .com and unknown endings default to the US. */
export function guessRegion(url: string): { country: string; currency: string; locale: string } {
  let host = url.trim().toLowerCase();
  try { host = new URL(/^https?:/.test(host) ? host : `https://${host}`).hostname; } catch { /* keep the raw text */ }
  const ends = (s: string) => host.endsWith(s);
  if (ends(".co.uk") || ends(".uk")) return { country: "United Kingdom", currency: "GBP", locale: "en-GB" };
  if (ends(".com.au") || ends(".au")) return { country: "Australia", currency: "AUD", locale: "en-AU" };
  if (ends(".ae")) return { country: "United Arab Emirates", currency: "AED", locale: "en-AE" };
  if (ends(".co.nz") || ends(".nz")) return { country: "New Zealand", currency: "NZD", locale: "en-NZ" };
  if (ends(".ca")) return { country: "Canada", currency: "CAD", locale: "en-CA" };
  if (ends(".ie")) return { country: "Ireland", currency: "EUR", locale: "en-IE" };
  if (ends(".sg")) return { country: "Singapore", currency: "SGD", locale: "en-SG" };
  if (ends(".in")) return { country: "India", currency: "INR", locale: "en-GB" };
  return { country: "United States", currency: "USD", locale: "en-US" };
}

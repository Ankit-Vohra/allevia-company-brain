// Country defaults for a business (product design §2.1 "Where do we find you?", §2.4 "Country"): currency, spelling
// (locale), time zone and privacy regime follow from the country, inferred from what the owner typed, what the website
// said (Business.country from the crawl), or the domain's country code, in that order. The owner can override any of
// currency, locale and time zone. A country we cannot tell is left unset rather than guessed.
//
// The markets Allevia sells to first (UK, UAE, Australia, then the US) plus India, where the first two businesses are.
// The time zone is the country's main business one (a multi-zone country gets its biggest city's).

export interface Region {
  country: string;        // the name the graph stores ("United Kingdom")
  countryCode: string;    // ISO 3166-1 alpha-2 ("GB")
  currency: string;       // ISO 4217
  locale: string;         // BCP 47: en-GB spelling, en-US spelling…
  timeZone: string;       // IANA
  privacyRegime: string;  // which privacy law the DPA has to meet
  weekStart: "mon" | "sun";
}

export const REGIONS: Readonly<Record<string, Region>> = {
  GB: { country: "United Kingdom", countryCode: "GB", currency: "GBP", locale: "en-GB", timeZone: "Europe/London", privacyRegime: "uk_gdpr", weekStart: "mon" },
  AE: { country: "United Arab Emirates", countryCode: "AE", currency: "AED", locale: "en-AE", timeZone: "Asia/Dubai", privacyRegime: "uae_pdpl", weekStart: "mon" },
  AU: { country: "Australia", countryCode: "AU", currency: "AUD", locale: "en-AU", timeZone: "Australia/Sydney", privacyRegime: "au_privacy_act", weekStart: "mon" },
  US: { country: "United States", countryCode: "US", currency: "USD", locale: "en-US", timeZone: "America/New_York", privacyRegime: "us_state_privacy", weekStart: "sun" },
  IN: { country: "India", countryCode: "IN", currency: "INR", locale: "en-IN", timeZone: "Asia/Kolkata", privacyRegime: "in_dpdp", weekStart: "mon" },
};

// What people type for a country, lowercased with punctuation dropped.
const ALIASES: Record<string, string> = {
  gb: "GB", uk: "GB", "united kingdom": "GB", "great britain": "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB",
  "northern ireland": "GB", london: "GB",
  ae: "AE", uae: "AE", "united arab emirates": "AE", emirates: "AE", dubai: "AE", "abu dhabi": "AE", sharjah: "AE",
  au: "AU", australia: "AU", sydney: "AU", melbourne: "AU",
  us: "US", usa: "US", "united states": "US", "united states of america": "US", america: "US",
  in: "IN", india: "IN", bharat: "IN",
};

const norm = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();

// "UK", "United Kingdom", "gb", "Dubai" -> the region; undefined when it is not one we know.
export function regionOf(raw: string | undefined | null): Region | undefined {
  if (!raw) return undefined;
  const code = ALIASES[norm(raw)];
  return code ? REGIONS[code] : undefined;
}

// The country a domain's TLD names: avsatelier.in -> IN, studio.co.uk -> GB. Generic TLDs (.com, .ai, .studio) say nothing.
export function regionOfDomain(domain: string | undefined | null): Region | undefined {
  if (!domain) return undefined;
  const host = domain.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split("/")[0]!.replace(/\.$/, "");
  const tld = host.split(".").at(-1) ?? "";
  const code = ({ uk: "GB", ae: "AE", au: "AU", in: "IN", us: "US" } as Record<string, string>)[tld];
  return code ? REGIONS[code] : undefined;
}

const validTimeZone = (tz: string | undefined): tz is string => {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export interface RegionInput { country?: string; currency?: string; locale?: string; timeZone?: string; domain?: string }
export interface ResolvedRegion {
  country?: string; countryCode?: string; currency?: string; locale?: string; timeZone?: string; privacyRegime?: string; weekStart?: "mon" | "sun";
  from: "owner" | "website" | "domain" | "unknown";   // where the country came from
}

// The owner's input first, then what the graph already says (the website crawl or an earlier onboarding), then the
// domain. An explicit currency, locale or time zone always wins over the country's default; an invalid time zone is
// dropped. A country name we have no defaults for is kept as written, with no defaults.
export function resolveRegion(input: RegionInput, stored: { country?: string | null; currency?: string | null; locale?: string | null; timeZone?: string | null } = {}): ResolvedRegion {
  const owner = regionOf(input.country);
  const site = regionOf(stored.country ?? undefined);
  const tld = regionOfDomain(input.domain);
  const r = owner ?? site ?? tld;
  const from: ResolvedRegion["from"] = owner ? "owner" : site ? "website" : tld ? "domain" : "unknown";
  const out: ResolvedRegion = { from };
  const name = owner ? owner.country : input.country?.trim() || (site ? site.country : stored.country?.trim()) || r?.country;
  if (name) out.country = name;
  if (r) Object.assign(out, { countryCode: r.countryCode, privacyRegime: r.privacyRegime, weekStart: r.weekStart });
  const currency = input.currency?.trim().toUpperCase() || (r ? r.currency : stored.currency?.trim() || undefined);
  if (currency && /^[A-Z]{3}$/.test(currency)) out.currency = currency;
  const locale = input.locale?.trim() || (r ? r.locale : stored.locale?.trim() || undefined);
  if (locale) out.locale = locale;
  const tz = [input.timeZone?.trim(), r?.timeZone, stored.timeZone?.trim() || undefined].find(validTimeZone);
  if (tz) out.timeZone = tz;
  if (!owner && !site && !tld && name) out.from = input.country ? "owner" : "website";
  return out;
}

// The calendar date in a time zone ("YYYY-MM-DD"): what the owner would call today.
export function localDate(ms: number, timeZone: string | undefined): string {
  const tz = validTimeZone(timeZone) ? timeZone : "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

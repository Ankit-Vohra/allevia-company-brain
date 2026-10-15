// Facts about the company that only the founder can supply. Every empty string below renders on the site as a bright
// "TODO(founder): ..." mark (so it cannot be missed), is left out of the structured data and the sitemap, and is listed
// by `npm run check:placeholders` (add --strict to fail the build while any remain; use it before publishing).
//
// Fill a value in here and the whole site picks it up: the legal pages, the footer, the contact page, the structured data.
// Do not put a real secret or a private identifier in this file: the repo may go public, and the contact addresses and the
// registered address below are meant to be public. Mailbox names are a suggestion; use whatever you set up.

export interface CompanyFacts {
  /** The registered legal name of the company that operates Allevia, as it appears on the registration. */
  legalName: string;
  /** The kind of company, for example "a private limited company". Used in "Allevia is operated by <legalName>, <entityType>". */
  entityType: string;
  /** The registered office address, on one line. Shown on the privacy policy, the terms and the contact page. */
  registeredAddress: string;
  /** Country of registration. Allevia is built in India; change it if the company is registered elsewhere. */
  country: string;
  /** The company registration number, if you want it shown (optional: leave "" to leave it out). */
  registrationNumber: string;
  /** The founder's name, for the About page (optional: leave "" to leave the line out). */
  founderName: string;
  /** Public mailboxes. Suggestions: hello@, support@, privacy@, security@, legal@ at the site's domain. */
  email: { general: string; support: string; privacy: string; security: string };
  /** An invite link to the public support channel on Discord (a permanent invite, not a one-use one). */
  discordSupportUrl: string;
  /** The person who handles privacy requests and complaints (India: the grievance officer). Optional. */
  privacyOfficer: string;
  /** Which law governs the terms and where disputes are heard, for example "the laws of India; the courts of <city>". */
  governingLaw: string;
  /** Where the servers are. The provider is a fact of the current setup; the region is yours to confirm. */
  hosting: { provider: string; region: string };
  /** Who takes card payments, once billing is switched on. */
  paymentProvider: string;
}

export const COMPANY: CompanyFacts = {
  legalName: "",
  entityType: "",
  registeredAddress: "",
  country: "India",
  registrationNumber: "",
  founderName: "",
  email: { general: "", support: "", privacy: "", security: "" },
  discordSupportUrl: "",
  privacyOfficer: "",
  governingLaw: "",
  hosting: { provider: "Amazon Web Services", region: "" },
  paymentProvider: "",
};

// Promises the legal pages make about timing. They are not facts about the company, they are commitments: confirm you can
// keep each one before publishing (the founder's call, then a lawyer's).
export const COMMITMENTS = {
  /** How quickly a person answers a message to support. */
  supportReply: "one working day",
  /** From a confirmed deletion request to everything being gone from live systems. */
  deleteWithinDays: 30,
  /** After that, how long until the deleted data has also aged out of our backups. */
  backupsAgeOutDays: 35,
  /** After a business stops using Allevia and has not asked for deletion, how long its workspace is kept so it can come back. */
  afterEndDays: 90,
  /** How quickly we confirm we got a privacy request. */
  acknowledgeWithinDays: 7,
  /** Notice before a material change to the terms or the privacy policy. */
  changeNoticeDays: 14,
  /** How long the web server keeps its access logs. */
  logRetentionDays: 30,
} as const;

/** The date on the legal pages ("Last updated"). Change it whenever a legal page changes. */
export const LEGAL_UPDATED = "15 October 2026";

// ---------- helpers the renderers use ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The value, or a visible TODO(founder) mark naming what is missing. */
export function fact(value: string, what: string): string {
  return value.trim() ? esc(value) : `<mark class="todo">TODO(founder): ${esc(what)}</mark>`;
}

/** An email address as a mailto link, or the TODO mark. */
export function mail(value: string, what: string): string {
  const v = value.trim();
  return v ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : `<mark class="todo">TODO(founder): ${esc(what)}</mark>`;
}

/** Every empty value, as "path: what", for the placeholder check. */
export function unresolved(): string[] {
  const out: string[] = [];
  const need: [string, string, string][] = [
    ["legalName", COMPANY.legalName, "the company's registered legal name"],
    ["entityType", COMPANY.entityType, "the kind of company, e.g. a private limited company"],
    ["registeredAddress", COMPANY.registeredAddress, "the registered office address"],
    ["email.general", COMPANY.email.general, "the general contact email"],
    ["email.support", COMPANY.email.support, "the support email"],
    ["email.privacy", COMPANY.email.privacy, "the privacy requests email"],
    ["email.security", COMPANY.email.security, "the security reports email"],
    ["discordSupportUrl", COMPANY.discordSupportUrl, "the permanent invite link to the support channel on Discord"],
    ["governingLaw", COMPANY.governingLaw, "the governing law and courts for the terms"],
    ["hosting.region", COMPANY.hosting.region, "the region the servers are in"],
    ["paymentProvider", COMPANY.paymentProvider, "the payment provider"],
  ];
  for (const [k, v, what] of need) if (!v.trim()) out.push(`company.ts ${k}: ${what}`);
  return out;
}

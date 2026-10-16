// Small readers for what arrives in an inbox or a pasted sheet: who an email is from, whether it is a person or a machine, and a
// date in whatever form a sheet gives it. Nothing here follows an instruction found in a message: it only reads names and dates.

export interface Sender { name: string; email: string }

/** "Priya Shah <priya@example.com>" -> { name: "Priya Shah", email: "priya@example.com" }; a bare address gives the name from its first part. */
export function parseFrom(from: string): Sender {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const email = (m ? m[2]! : from).trim().toLowerCase();
  const raw = (m ? m[1]! : "").trim();
  const local = email.split("@")[0] ?? email;
  const name = raw || local.replace(/[._+-]+/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase()).trim();
  return { name: name || "Someone new", email };
}

const MACHINE = /(^|[._-])(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|notifications?|alerts?|newsletter|news|updates?|digest|billing|invoice|receipts?|support-noreply|bounce)([._-]|@)/i;
const MACHINE_SUBJECT = /\b(unsubscribe|newsletter|your (?:receipt|invoice|statement|order)|password reset|verify your|security alert|out of office|automatic reply)\b/i;

/** A message from a machine (no-reply, a newsletter, a receipt) is not a customer's enquiry. */
export function looksAutomated(from: string, subject = ""): boolean {
  const { email } = parseFrom(from);
  return MACHINE.test(email) || MACHINE_SUBJECT.test(subject);
}

/** An epoch ms from an ISO date, an RFC 2822 date or "15/10/2026" style day-first dates; null when it is none of those. */
export function parseWhen(v: unknown, fallback: number | null = null): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string" || !v.trim()) return fallback;
  const s = v.trim();
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (dmy) {
    const t = Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    return Number.isFinite(t) ? t : fallback;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : fallback;
}

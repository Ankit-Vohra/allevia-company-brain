// Each business's own meeting address: a secret web address that any recorder, Zapier or Make step, or email-to-webhook service
// can post a transcript or notes to, with no account on our side. The secret is derived from the server's connector key and the
// business's slug (so nothing new is stored, and changing the key retires every address); it is compared in constant time.
import { createHmac, timingSafeEqual } from "node:crypto";

const MIN_KEY = 32;

/** The address's secret for a business, or null when the server has no connector key (the address is off). */
export function meetingToken(key: string | undefined, tenant: string): string | null {
  if (!key || key.length < MIN_KEY) return null;
  return createHmac("sha256", key).update(`meeting-address:${tenant}`).digest("base64url").slice(0, 32);
}

export function meetingTokenOk(key: string | undefined, tenant: string, token: string): boolean {
  const want = meetingToken(key, tenant);
  if (!want || token.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(token));
}

export const MEETING_HOOK_PATH = "/hooks/meetings";

/** The full address to give a recorder or an automation, or null when it is off. */
export function meetingAddress(base: string, key: string | undefined, tenant: string): string | null {
  const t = meetingToken(key, tenant);
  return t ? `${base.replace(/\/+$/, "")}${MEETING_HOOK_PATH}/${tenant}/${t}` : null;
}

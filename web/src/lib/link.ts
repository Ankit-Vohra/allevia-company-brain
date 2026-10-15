// "Open with your link". An owner link looks like https://<host>/#key=<token>. The token is in the #fragment on purpose: a
// fragment is never sent to a server, never in an access log and never in a Referer header. This reads it once, removes it
// from the address bar, and gives it to POST /api/auth/open, whose answer sets an HttpOnly cookie for that business. The
// page never keeps the token (not in storage, not in memory after the call), and every later request carries the cookie.

export interface LinkResult {
  /** a link was in the address bar (or pasted) */
  seen: boolean;
  /** the server accepted it; `tenant` is the business it opens (absent for the operator's link) */
  opened: boolean;
  tenant?: string;
}

// `#key=<token>`, or a whole link, or the bare token. Anything else is not a link.
export function tokenFrom(text: string): string | null {
  const t = text.trim();
  const m = /(?:[#&?]key=)([A-Za-z0-9_.-]{20,100})(?:[&\s]|$)/.exec(t) ?? /^([a-z0-9_]{1,40}\.[A-Za-z0-9_-]{43})$/.exec(t);
  return m ? m[1]! : null;
}

export async function openWithToken(token: string): Promise<LinkResult> {
  try {
    const res = await fetch("/api/auth/open", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ token }) });
    if (!res.ok) return { seen: true, opened: false };
    const body = (await res.json()) as { tenant?: unknown };
    return { seen: true, opened: true, ...(typeof body.tenant === "string" ? { tenant: body.tenant } : {}) };
  } catch {
    return { seen: true, opened: false };
  }
}

/** Consumes a link in the address bar, if there is one. The fragment is removed first, so a failed link is not kept in history. */
export async function consumeLinkInAddressBar(): Promise<LinkResult> {
  const token = tokenFrom(location.hash);
  if (!token) return { seen: false, opened: false };
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return openWithToken(token);
}

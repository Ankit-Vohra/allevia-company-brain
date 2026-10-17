// Who may do what in a business, in one place. The door in app.ts decides whether a request gets in at all; this decides
// what the caller may change once inside:
//   - owner:  everything, including the plan and billing, credit packs, connections, the team and deleting the business;
//   - member: asks, drafts and approvals, but not the plan, billing, connections or the team;
//   - public: the read-only demo view (nothing changes).
// With ALLEVIA_AUTH off (local use, tests) the person at the keyboard runs the business, so they are the owner. An owner
// link (src/auth/tokens.ts) also makes the caller the owner. A signed-in account carries its own role (the login work sets
// `role` on requestView when the door lets the account in).
import { requestView } from "./auth.js";
import { HttpError } from "./http.js";

export type Role = "owner" | "member" | "public";

export function callerRole(): Role {
  const view = requestView.getStore();
  if (!view) return "owner";
  if (view.publicView) return "public";
  return view.role ?? "owner";
}

export const callerUserId = (): string | undefined => requestView.getStore()?.userId;

export const OWNER_ONLY = "Only the business owner can do that.";

/** Throws a 403 unless the caller is the business's owner. */
export function requireOwner(): void {
  if (callerRole() !== "owner") throw new HttpError(403, OWNER_ONLY);
}

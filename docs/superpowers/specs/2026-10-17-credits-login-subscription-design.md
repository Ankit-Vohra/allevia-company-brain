# Credits, login and the subscription page

The founder, 17 October 2026: "we will need a credit based system and define no of credits in plans and link questions +
different services to credit consumption; get a login page and all; subscription page". Decisions taken the same day:

- **Credits:** one pool, priced by what each service costs us.
- **Login:** our own email and password.
- **Payments:** test mode, with the provider decided later.
- **Timing:** build now and go live for the judges on 18 October.

The plan numbers are already in `shared/plans.ts` (commit 5f2cf17) and the role helper in `src/server/roles.ts` (a8d7759).
Owner-facing words follow `docs/owner-words.md`.

## 1. What the owner sees

- **Sign up** with a name, email and password, then paste the website. The business is set up as today (onboarding) and
  starts on the **trial: 100 credits for 14 days**.
- **Sign in, sign out.** Invite a teammate with a link (seats per plan). A teammate can ask, draft and approve, but cannot
  change the plan, billing, connections or the team.
- **Credits everywhere:** a small "212 credits left" in the top bar, and the cost on anything that spends ("Uses 5
  credits when you say OK"). When credits run out: "You've used this month's credits. Buy 100 more for $29 or move to
  Growth." Today's note and anything the team does on its own still run. The owner spends credits only on what they ask
  for or approve.
- **Plan and credits page** (`/plan`):
  - credits left this month, with when they reset;
  - what used them, by service and by person;
  - the plans with a Monthly or Yearly switch (30% off);
  - "Switch to Growth", "Buy 100 credits", "Pause" and "Cancel" (cancel offers Pause first).

  While billing is in test mode, the page says "Billing opens soon. We'll switch you by hand within a day." The request
  is recorded and the operator approves it.

## 2. Credits (builder A)

**Price list:** `CREDIT_PRICES` in `shared/plans.ts`. A credit is about $0.10 of our cost.

| Service | Credits | Charged when |
|---|---|---|
| Quick question | 1 | the answer arrives |
| Deep question (the whole team) | 5 | the answer arrives |
| Email, reply or caption | 1 | the owner says OK |
| Book a meeting | 1 | the owner says OK |
| Website check-up | 10 | the owner runs it |
| Rivals and public data | 5 | the owner runs it |
| Picture or post | 5 | the owner says OK |
| Carousel | 10 | the owner says OK |
| Photo to premium ad | 15 | the owner says OK |
| Product shoot | 15 | the owner says OK |
| Short video | 40 | the owner says OK |
| Today's note, Brain Snapshot | free | never |

Proactive work is free: the stand-up, Today's note, the monthly automatic check-up, and anything a schedule runs. A failed
answer or a "No thanks" costs nothing.

**Ledger in the business's own graph** (FalkorDB, the graph-first story): one `(:CreditEntry {id, at, month, service,
credits, reason, by})` per grant or spend.
- `credits` is a whole number: positive for a grant (trial, monthly plan credits, rollover, pack), negative for a spend.
- `-[:FOR]->` links the entry to what it paid for: the Turn, the approved card or Asset, or the check-up run. "What used
  my credits" is then a traversal, and every spend has its "how we know".
- An index covers `CreditEntry.month`. Sums are done in TypeScript, never as float math in Cypher. Every ORDER BY ends in
  `id`.

**Spending** goes through one module, `src/credits/`:
- `balance(slug)` returns `{allowance, rollover, packs, used, left, resetsAt}`.
- `canSpend(slug, service)`.
- `spend(slug, service, {ref, by})`. It is idempotent on `(service, ref)`, so a retried approval is not charged twice,
  and a per-business lock in the process keeps two answers from overspending.
- `grant(slug, credits, reason, ref)`.
- The month's plan credits are granted lazily on the first read or spend in a new month. Rollover is at most one month's
  allowance, carried for one month. Pack credits never expire while there is a plan.

**Hook points:**
- the chat runtime: quick for one person, deep for the team or a multi-person investigation, decided by the runtime;
- the approvals decision: draft text, a meeting, Studio outputs (replacing the `credits_charged` Observation, which
  `routes/usage.ts` reads today, so migrate the reader);
- the check-up route, when the owner starts it;
- the public data and Apify run, when the owner starts it.

Discord uses the same paths, so it is charged the same way.

**Out of credits:** check before work starts. The API answers 402 with the owner sentence above, and the web app and
Discord show it with the two buttons. An approval whose credits ran out after the card was made is still allowed; the
balance goes negative by at most that one card, so the owner is never surprised by a blocked OK.

**API:**
- `GET /api/:t/credits` returns the balance, this month's entries by service and by person, and the price list.
- `GET /api/:t/usage` keeps working, reading the ledger.

## 3. Subscription in test mode (builder A)

**Registry graph** (`allevia_meta`, next to `(:Tenant)`):
- `(:Tenant)-[:HAS_SUBSCRIPTION]->(:Subscription {plan, cycle: monthly|yearly, status: trial|active|paused|cancelled,
  startedAt, renewsAt, trialEndsAt, provider: "test", providerRef})`;
- `(:Tenant)-[:REQUESTED]->(:BillingRequest {id, kind: change|pack|pause|cancel, plan, cycle, packId, at, status:
  pending|done|declined})`.

**Provider adapter:** `src/billing/provider.ts`, with a `test` provider. Paddle (or Stripe) is added later behind the
same interface: checkout link, webhook, and cancel.

**Test mode:**
- `ALLEVIA_BILLING=test-request` (the default) records requests for the operator, via the CLI
  `billing:requests` and `billing:approve <id>`.
- `ALLEVIA_BILLING=test-instant`, for local use only, applies them at once.

Approving a plan change sets the subscription and grants the new month's credits (`grant`). Approving a pack grants its
credits.

**API**, owner only via `requireOwner()`:
- `GET /api/:t/subscription`;
- `POST /api/:t/subscription/change {plan, cycle}`;
- `POST /api/:t/credits/packs {packId}`;
- `POST /api/:t/subscription/pause`;
- `POST /api/:t/subscription/cancel`.

**Web:**
- `/plan` becomes "Plan and credits", described in section 1;
- a credits chip in the top bar;
- the out-of-credits message wherever a 402 can come back (chat, approvals, Studio, check-up).

## 4. Login (builder B)

**Registry graph** (`allevia_meta`):
- `(:User {id, email (lower case, unique), name, passHash, createdAt, disabledAt})`;
- `(:User)-[:MEMBER_OF {role: owner|member, since}]->(:Tenant)`;
- `(:User)-[:HAS_SESSION]->(:Session {idHash, createdAt, expiresAt, lastSeenAt, revokedAt})`;
- `(:Tenant)-[:HAS_INVITE]->(:Invite {codeHash, role, createdAt, expiresAt, usedAt, usedBy})`;
- constraints or indexes on `User.email`, `Session.idHash` and `Invite.codeHash`.

**Passwords:** `crypto.scrypt` (N=2^15, r=8, p=1, a 16-byte salt), compared in constant time, at least 10 characters.

**Sessions:** a 256-bit random id. Only its SHA-256 is stored. Cookie `allevia_session`: HttpOnly, SameSite=Lax, Secure
over HTTPS, Path=/, 30 days, sliding.

**API:**
- `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`;
- `GET /api/auth/me`, which returns the user and their businesses with roles;
- `POST /api/:t/invites` (owner) returns a link `/invite/<code>` that works for 7 days, once;
- `POST /api/auth/invites/:code/accept`;
- `POST /api/auth/password` to change the password;
- the CLI `auth:reset-link <email>`, for the operator, because there is no email sender yet.

**Rate limits** follow the existing `/api/auth/open`: per client and per email. Every failure gives one error sentence:
"That email and password don't match."

**The door** (`app.ts`, with ALLEVIA_AUTH=1), in order:
1. a session whose user is a member of T: `requestView.run({publicView: false, role, userId})`;
2. otherwise an owner link, as today, which makes the caller the owner;
3. otherwise the demo business, read-only;
4. otherwise a 401.

`/api/onboard` with a signed-in user makes them the owner of the new business and starts the trial (`grant` from builder
A's module, or the subscription record if A has not merged yet: coordinate on `src/credits/index.ts`'s `grant`
signature, `grant(slug, credits, reason, ref)`). There is one business per account during the trial.

**Seats:** a plan's `seats` limits members and invites.

**Web:**
- `/login` and `/signup` in the app's own design: plain words, one column, works on a phone;
- `/invite/:code`;
- an account menu (name, the businesses, sign out);
- "Your team" gets "Invite someone" for the owner.

Signed out with ALLEVIA_AUTH=1, the app goes to `/login`, and the demo business stays viewable read-only from a
"See the demo" link on the login page.

## 5. Going live for the judges (after both merge)

The hosted app runs with ALLEVIA_AUTH=1:
- judges sign up and get the 100-credit trial;
- the demo business stays open read-only;
- the onboarding limits already in place hold (#23).

Hosting needs:
- the founder to log Claude Code in on the server, with its subscription;
- HTTPS on a public name (an `app.` record on allevia-ai.in, or an sslip.io name on the server's address);
- port 443 opened.

Each is the founder's go-ahead.

## 6. Testing

- **Unit:** the ledger (grants, spends, rollover, idempotency, the lock), prices, roles, password hashing and sessions.
- **HTTP**, against the real server and the local test DB on 6391:
  - sign up, onboard, trial credits;
  - a question spends 1, a deep one 5;
  - out of credits gives a 402;
  - a member cannot switch the plan;
  - invites;
  - the demo stays read-only;
  - the door's order;
  - rate limits.
- **Web:** the login, plan and credits pages render and work at phone width.
- **No test writes to FalkorDB Cloud.**

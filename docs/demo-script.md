# Demo script: live first

The demo is run **live**: real requests, real agents on the Claude subscription, real graph queries, nothing pre-played.
Five scenarios, each started by hand in front of the viewer and judged by what happens. A recorded replay is only a
fallback when something outside the product fails (the network, the subscription's limits), and it is **labelled on
screen as a replay** every time it is used.

Status (15 October 2026): the demo video is **not recorded yet**; the founder holds it until the product is ready.
Scenario 3 (a poster with the owner's logo) depends on the creative tools another builder is finishing; until they land
it is skipped, not faked.

## Before going live

- [ ] FalkorDB up; `npm run cli -- db:check` lists the businesses; `npm run cli -- privacy-scan <tenant>` reports 0 for
      each business that will be on screen.
- [ ] Web app built (`cd web && npm run build`), server in **live** mode: `npm run cli -- serve` (not `--public`).
      Claude Code is logged in with the claude.ai account; nothing else is using the subscription during the demo.
- [ ] Discord bot running for the business on screen (`npm run cli -- discord`); a fresh thread channel is open.
- [ ] Executors stay dry runs (`ALLEVIA_ACTIONS_LIVE` unset): approving a card records it, nothing is posted.
- [ ] Onboarding goes into a **fresh slug** (for example `avs_atelier_demo`), never over a real business.
- [ ] Fallbacks ready, each with its on-screen label: the office's **Replay the last request** (shows "Replay" in the
      work log), an earlier onboarding recording, the last Studio run.
- [ ] Nothing on screen shows a token, an email address, a phone number or a server address (terminal history cleared,
      env file closed). Simulated ad numbers are called simulated wherever they show.

## The five live scenarios

### 1. Onboard a company from its URL

**Do:** Add a business, type its name and website (a public site), start. **Watch:** the stages stream (reading pages,
brand kit, search checks, understanding services and audiences, goals, what the team can see) while the graph grows.
**Point at:** the Brain page afterwards: the business's own graph, built from one URL, and nothing posted anywhere.
**Graph at work:** the new business is its own graph (`allevia_<slug>`); nothing from another business is visible.
**Fallback (labelled "Recording"):** the earlier onboarding of the same site.

### 2. An unscripted question on Discord, answered with its path

**Do:** let the viewer type their own question in the business's Discord thread (for example "what breaks if the
Instagram connector goes down?" or "why did we pause daily stories?"). **Watch:** the live work log in the thread:
Meera plans, a desk works, tool calls stream. **Point at:** the answer's citations as labels, the checks as badges, and
the link to the web path view, where the path behind the answer is lit node by node.
**Graph at work:** on the Brain page, **What breaks if something stops** for the same system: depth 1 (what a table
lookup sees) against depth 4, with the path to each far item and who looks after it. Then type a name the business
does not have ("Payroll gateway"): the answer is "I don't have that in your records", not an empty list.
**Fallback (labelled "Replay"):** Replay the last request in the office.

### 3. A poster with the owner's logo

**Do:** ask the team for a poster for this week's offer. **Watch:** the brand kit from onboarding (logo, colours) is
used, the draft comes back as an approval card. **Point at:** the asset's lineage in the graph (`DERIVED_FROM`, who
produced it). **Status:** blocked until the creative tools land on `dev`; skip it rather than show a mock.

### 4. A bad photo turned into good content

**Do:** drop a dark, tilted phone photo into Studio with a one-line note. **Watch:** Tara marks what is wrong on the
original; two versions come back (a local fix and a generated edit); Nisha compares each with the original and marks
any added or removed detail; Dev writes the caption. **Point at:** "Enhance, never invent": the version that changed the
real place is held back. **Graph at work:** each version is an `Asset` `DERIVED_FROM` the original, with the step that
made it. **Fallback (labelled "Last run"):** the last Studio run.

### 5. The team notices something and drafts it

**Do:** run the detectors (`npm run cli -- insights <tenant>`, or `POST /api/<tenant>/insights/run`). **Watch:** findings appear
with their numbers and evidence ids from the graph, and one becomes an approval card with a draft. **Point at:** edit a
word in the draft and approve: the edit becomes a learned rule linked to that approval, and the next draft uses it.
**Graph at work:** `Recommendation -[:PROPOSES]-> Approval`, `Rule -[:LEARNED_FROM]-> Approval`, evidence one hop away.
**Fallback:** none needed (the detectors are deterministic, no model call).

## Under the hood (30 seconds, optional)

FalkorDB Browser (`http://127.0.0.1:3090`): the graph list (one graph per business), then a decision with its
`BASED_ON` evidence expanded. The queries behind each scenario are in [`falkordb-queries.md`](falkordb-queries.md).

## Recording the video (later, when the founder says go)

Record a live run of the five scenarios, not a script read over replays. Under 3:00, 1080p, captions on. Anything sped
up gets a "2× speed" tag; any fallback keeps its "Replay" or "Recording" label. Frame-by-frame check for tokens, email
addresses, phone numbers, server addresses and private document titles before uploading (unlisted first).

# Demo script: live first

The demo is run **live**: real requests, real agents on the Claude subscription, real graph queries, nothing pre-played.
Five scenarios, each started by hand in front of the viewer and judged by what happens. A recorded replay is only a
fallback when something outside the product fails (the network, the subscription's limits), and it is **labelled on
screen as a replay** every time it is used.

Status (15 October 2026): the demo video is **not recorded yet**; the founder holds it until the product is ready.
Scenario 3 (a poster with the owner's logo) depends on the creative tools another builder is finishing; until they land
it is skipped, not faked.

## The hero: "Why did sign-ups drop this week, and what should we do?"

One question, about two minutes, and every part of the product shows up in it: the office, the graph path, the depth contrast, memory,
approval cards and learning. Run it live on the synthetic business `demo_growth` (public; this is what the repo ships) or on Aamdani (private,
real records, where the honest answer is "the records do not show the cause"). It runs on the Claude subscription, nothing pre-played.

**Set up (once, 30 seconds).** `npm run cli -- seed-demo` builds Shiftly, a synthetic shift-jobs app, as the graph `allevia_demo_growth` and registers it
(no model, no network). Open it in the web app. Its story, written into the records the way ingestion writes them: the 2.8.0 release (7 Oct) put a new
phone-number box on the sign-up screen, it crashes, and new accounts fell from about 250 a day to about 50 that day. Around it: Google sign-ups unchanged, an ad
campaign paused three days *after* the fall began (a red herring), a hotfix waiting in the App Store's review queue, a decision from last week and the thread
it came from.

| Step | Type or do | Point at | Graph at work |
|---|---|---|---|
| 1. Ask | In Ask (web) or the Discord thread: `Why did sign-ups drop this week, and what should we do?` | **The office.** Meera plans five people at once instead of one: Kabir (what moved, and the day), Zoya (what crashed on those screens), Imran (what shipped, what waits in review), Sara (what we decided before), then Arjun (what else it takes down). Each desk's tool calls stream in the work log. | One question becomes five different traversals of the same graph. |
| 2. The answer | Read the first two sentences aloud. | It names the cause and how sure it is ("proven": a record links the release to the crash; "likely": only the dates fit; "not shown"). Numbers carry dates; the paused ad is ruled out by its date. | `metric_trend` on every funnel step: the step where the level stepped (`shift`: the date, the average before and after). |
| 3. The path | Open "Show how we got this". | **The path**, lit node by node: the step that fell, the sign-up screen, the crash, the 2.8.0 release, Farhan. Click a node: its source and date. | `Feature -DEPENDS_ON-> Page <-AFFECTS- Event <-AFFECTS- Event`; one `algo.SPpaths` call between the step and the release ([`falkordb-queries.md` §13](falkordb-queries.md)). |
| 4. Depth 1 against depth 4 | Brain page, **What breaks if something stops**, choose the sign-up screen. | Left: what a table lookup sees one step away (the next step, the ad campaign that sends people in). Right: four steps away (job-alert texts, the employer applicant inbox, the first-hire promise to employers), each with its path and owner. | `impact_of`, one traversal per hop (§3). |
| 5. Memory | Point at the sentence about last week. | "On 10 Oct you chose a hotfix over a rollback; it is waiting on the iPhone review." It remembers the earlier Discord thread, the decision and the rule "tell users only when a fix is on its way". | Recall: from the nodes in the question to the turns, decisions and notes that touched them (§11). |
| 6. Cards | Open Approvals. | Two cards wait for OK, none sent: **the fix task** (evidence ids, numbers, dates) and **a two-line message to users**. | `propose_action`: Recommendation `PROPOSES` Approval, `EVIDENCED_BY` the crash and screen. |
| 7. Learning | Edit the message card (cut a few words) and approve it. | A **learned rule** appears ("Keep it under 25 words"), linked to that approval. The next draft already follows it. | `Rule -[:LEARNED_FROM]-> Approval` (`src/actions/learning.ts`). |
| 8. A day later | Ask the same question again, `npm run cli -- ask demo_growth "..." --now 2026-10-17T20:00:00Z` (demo businesses only). | It remembers: reports where yesterday's cards stand ("the fix task you approved is open, the message is saved with your edit") and does not draft them again. | Recall now reads each earlier answer's cards and the task an approved card made (§13). |

**If a viewer asks "is this scripted?"** Ask them for a different why-question on the same business ("Why did our job-feed views fall?", "Did the ad pause cause it?", "What
did store reviews say?"). The last one has no records behind it, and the answer is "not in your records", never an invented quote.

**On Aamdani (real, private).** Same question. The honest answer today: sign-ups per day are recorded, the funnel steps and the crash-free sessions are recorded, the iOS build
is waiting in review since 7 Oct, and a login-screen timeout was seen on 1 Oct, but **no record links a release to a crash or a crash to the sign-up step**, so it says "cause not
shown" and what to connect. The mapper links a crash to its screen and a release to its crash the day the tracker's data carries them (`firstRelease`, the route in `where`).

**Fallbacks (labelled on screen):** the office's "Replay the last request"; the recorded turn marked as showcase for this question.

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

## The five live scenarios (after the hero)

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

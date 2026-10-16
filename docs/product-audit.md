# Product audit (issue #39), 16 October 2026

What was checked, what broke, what was fixed. Ranked by how much each defect would hurt a founder in the first week.

**How it was done.** A separate server from the audit worktree on port 8791 (the live one on 8787 was never touched),
FalkorDB Cloud (4.22) for the data, headless Playwright at 1440 and 390 wide. Aamdani and AVS Atelier were only read.
Everything that writes ran on the synthetic business `demo_growth` (Shiftly) or on two throwaway businesses
(`audit_cafe_grumpy`, `audit_grumpy_two`, plus a half-made `audit_sightglass` after the server stopped); all three graphs
and their registry rows were deleted afterwards with `GRAPH.DELETE` on exactly those keys. The Studio's paid editor was
switched off (`ALLEVIA_STUDIO_ENGINE=recorded`), the Discord hub was switched off for the audit server, the weekly
check-up and stand-up schedules were off, and nothing was posted to the real hub.

## Defects, worst first

| # | Defect | Hurt | Status |
|---|---|---|---|
| 1 | **Approving any card failed on FalkorDB Cloud** (web: "Something went wrong on the server"; Discord buttons and `approvals approve` the same). The history copy (`Version` node) was created without its id, and Cloud checks the mandatory id before any later `SET`. Local FalkorDB 6.0 does not, which is why no test saw it. | Blocks the core loop (say OK) on the live database | Fixed. `src/graph/nodes.ts`; a source check (`entityCreateWithoutId`) now fails the suite if any `CREATE` of an Entity sets its id afterwards |
| 2 | **Onboarding turned any soft problem into a failed run.** One stage error (here the local embeddings, missing from a worktree) flipped the page to "failed", showed the raw error plus "Check the address and try again", and hid that the business had in fact been built. | A founder who succeeds is told they failed | Fixed. Steps that cannot finish are a plain note on the "ready" page (`soft` error events); only an unreadable site or bad input ends the run |
| 3 | **Discord approvals carried only a title and a short quote**, no pictures, at most 10 cards, only on the minute sync, buttons Approve / Reject. Discord is where owners work for now. | The founder cannot decide from Discord | Fixed (see "Discord approvals" below) |
| 4 | **Brain "groups" (graph-at-work) failed** on any business with no documents (`demo_growth`, `avs_atelier`): "unknown relationship-type LINKS_TO" on Cloud 4.22. | The Brain page's own panel showed an error note | Fixed in `src/graph/algorithms.ts`: an algorithm asks only for relationship types and labels the graph really has |
| 5 | **One error on two apps made two identical cards** (`tech.sentry_hot_issue`). | Duplicate fixes in the owner's list | Fixed (`sentryIssues` returns one row per error) |
| 6 | **A web rebuild left a running server with a blank app**: the shell was read once at start and pointed at deleted files; a missing script came back as HTML. | Every deploy that does not restart | Fixed: shell re-read when the build changes; missing `/assets/*` is a 404 |
| 7 | **`privacy-scan` reported hits on every check-up and stand-up** (a JSON field called `key` with a slug as its value). The README says it must report 0. | The privacy gate cannot be trusted | Fixed in `src/ingest/redact.ts`; 0 hits on aamdani, avs_atelier and demo_growth |
| 8 | **Team notes in chat showed raw markdown and machine dates** ("**Sign-ups broke...** - Daily..." and 2026-10-07), a "Findings:" label, and Meera's answer used 2026-09-28 dates. | Fails the owner-words test on the busiest screen | Fixed in `web/src/lib/chat.ts`, `words.ts` |
| 9 | **Studio showed the checker's numbers and the model name** ("edges 0.98 · dHash 8/64", "nano_banana_2_1") and Dev could write the literal "Project name, Pune" in a caption when the photo had no project. | Jargon, and a placeholder that could be approved and posted | Fixed (numbers in a tooltip; the prompt asks for a name line only with a project) |
| 10 | **Approvals buttons said Approve / Edit / Reject** and drafts showed `Evidence: event:release-...`; Discord said Approve / Change / No thanks. | Two vocabularies, raw ids | Fixed: Approve / Change / No thanks everywhere; evidence ids hidden |
| 11 | **Today's note listed filing bookkeeping as changes** ("Changed: Cafe no longer sourced from Web page: About Us") in a new business's first note. | Confusing first note | Fixed (`src/insights/brief.ts`) |
| 12 | `/chat/rohan` opened the team chat, not Rohan. | A shared link to one person lands on the wrong chat | Fixed (first names work in the address) |
| 13 | **`discord-hub status` fails: the bot's role sits below the customer roles** (customer-demo_seed, customer-prufrock_coffee_3). The bot cannot give a new customer their role. | A real customer who joins would see nothing | **Open, needs the founder in Discord**: Server Settings, Roles, drag the bot's role above every `customer-*` role |
| 14 | Onboarding says "about two minutes"; a real site took 8 minutes (477 s), and the page says nothing when it is long. | Expectation | Open (copy; see notes) |

## Notes that need the founder's taste (not changed)

- ~~**Where "Check my website" lives.** It is inside Office, under "See the full plan", then at the bottom.~~ **Fixed in Home v3 (#43):** it is a visible button in the "Your tools" card on Home, on the plan card and on the growth plan page; on Discord it is `/checkup`.
- ~~**"A fix for your website"** is the label for every fix, including an app crash fix.~~ **Fixed (#43):** `shared/fix-words.ts` reads the subject from the card ("App:", "Android:", "Release check:" say "a fix for your app"; "Funnel:" says "a fix to hand over"; everything else stays "a fix for your website"), on the web, in Discord cards and in Today's note.
- ~~**Goal status early on.** "Search clicks: Going well, 0 clicks a month, goal 50" in week one.~~ **Fixed (#43):** a zero in the first 7 days says "We'll know after your first full week", in the server's goal status (so Today's note and Discord agree) and in the web app.
- **"Growth" is both a price tier and "your growth plan".** On Plan and credits the page says "Growth, $449 a month, included while you're in your growth plan".
- **Today's note is a snapshot**, so after the stand-up it can say "Waiting for your OK: Nothing" while two cards wait.
- **Customise** repeats itself on each skill ("waiting for the owner's OK. Waits for your OK.").
- **Citation chips for older conversations** can show a bare id ("2026 10 16 a5928d36").
- **Console noise**: `/program`, `/studio/sample` and `/standup` answer 404 by design for a business that has none yet; the browser logs them as errors.
- **`graph:tidy --dry-run`** took 132 s on a 500-node graph.
- Demo only: `demo_growth`'s goal "Weekly signups" reads "no data" although signups exist (the goal watches `new_accounts`, the data is `signups_phone`).

## Everything that was checked

Web, `demo_growth` (writes), `aamdani` and `avs_atelier` (read only), 1440 and 390 wide. "Pass" means it did what it
should with no console error or failed request except those listed above.

| Check | Result |
|---|---|
| Office: map, clock chip, This week, Waiting for your OK, stand-up list, Ask box, plan card | Pass (1440, 390) |
| Chat: team thread, hero question live (93 s, grounded answer, cards drafted) | Pass; defect 8 fixed |
| Chat: direct chat with Rohan, new conversation, history list | Pass; defect 12 fixed |
| Chat: Watch the team talk | Pass |
| Chat: Customise (tone, skills, tell Rohan something) | Pass (wording note) |
| Insights: ideas list, review the draft, Today's note, "How we know" | Pass; defects 5, 11 fixed |
| Approvals: approve | **Fail on Cloud** (defect 1), pass after the fix |
| Approvals: change a draft then approve (teaches a rule), No thanks | Pass |
| Studio: upload a photo on demo_growth, Tara's read, option A and B, Nisha's check, caption, approve | Pass in 32 s; defect 9 fixed |
| Studio: brand files, blur-people switch | Pass |
| Brain: facts count, decisions, most-connected, What breaks if something stops, graph-at-work, search, Explore | Pass; defect 4 fixed |
| Team: Tell your team (preview four changes, save), person drawers | Pass |
| Growth plan: OK a goal, Change the number, Save | Pass |
| Plan and credits | Pass |
| Check my website: starts, polls, says it is working | Pass (demo.example does not open, so it reports that) |
| Today's note: web, CLI `brief` | Pass |
| Onboard: a fresh public site into a new tenant (cafegrumpy.com, 40 pages, 464 facts, 3 goals, 12 people) | Pass in 477 s after defect 2; deleted afterwards |
| Not-found page, empty states on a new business | Pass |
| 390 wide: no horizontal page scroll on any screen; the chip and avatar rows scroll sideways on purpose | Pass |

CLI, all on `demo_growth` unless noted:

| Command | Result |
|---|---|
| `agents`, `capabilities`, `action-target`, `threads`, `replay`, `showcase`, `auth:list`, `db:check`, `db:busy` | Pass |
| `approvals` (list, approve, reject) | approve failed on Cloud (defect 1), pass after |
| `brief`, `program`, `enroll`, `insights`, `tell` (preview), `standup --no-llm --no-paid` | Pass; `insights` duplicated a card (defect 5) |
| `privacy-scan` | Failed on check-ups (defect 7), 0 hits after |
| `graph:quality`, `graph:tidy --dry-run` | Pass (tidy slow) |
| `connect status`, `keywords` (no account), `numbers` (missing file), unknown tenant, unknown command | Pass, plain messages |
| `eval --fake` | Runs; scores 0 of 3 because a fake model cannot answer (expected) |
| `ingest demo_growth` | "unknown tenant": ingest only runs for configured businesses (aamdani, avs_atelier); expected |
| `discord-hub status` | Fail: defect 13 |
| `discord-hub list` | Pass (2 customers) |
| `ask`, `ai-visibility`, `checkup`, `eval` (live), `mcp`, `discord`, `serve`, `db:export/import/migrate/unmerge`, `seed-demo`, `auth:issue/revoke/demo`, `enroll` on real businesses | Not run in this audit: they spend model time, post, or change shared data; their tests are green |

## Discord

Read all of `src/discord/*` and ran the existing fake-port tests (`/ask`, `/brief`, `/approvals`, `/continue`,
`/checkup`, Approve / Change / No thanks, Studio buttons, spreadsheet upload, #support mirror, hub isolation, join links,
the database waking up): all green (233 tests). Nothing was posted to the real hub. The only live finding is defect 13.

### Discord approvals (the founder's rule: Discord is where owners work for now)

- **Every card carries the thing itself.** Posts and captions: the full text (a long text continues in the next
  messages, never cut). Posters, pictures, reel drafts and Studio options: the files are attached (up to four, 20 MB; a
  bigger one is left out with a link). Website fixes: what the page says now (title, heading, description), then the new
  words. Emails and messages: the recipient and subject, read from the draft when it has them (the Sales department
  will fill these in).
- **One line of why**, read from the idea that proposed it (or the stand-up's own line), then **Approve / Change / No
  thanks**. After a decision, here or on the web, the same message loses its buttons and shows the verdict and the result
  ("Approved · Added to your tasks: ...").
- **Change** now works on any waiting draft (before, only on drafts from today's note); an ad pause has no words to change.
- **Backlog and speed.** Up to 20 new cards a sync, oldest first, the rest on the next one (was: 10 newest, the rest
  never). A card made in the server or the bot process posts within about 3 seconds (`src/discord/hub-nudge.ts`); the
  minute sync still catches everything made by other processes (the CLI, the weekly schedules). A per-business lock stops
  two processes posting the same card.
- **Today's note and the stand-up drafts** post the same way, under the note, and a stand-up draft is no longer also
  posted a second time in #approvals.
- Tests: `tests/discord/approval-cards.test.ts` (fake hub and stores, a real graph and folder for the lookups).

## What was not done

- The five live scenarios (#6) were only partly run here: onboarding from a URL, the hero question, a bad photo into a
  post, and the team noticing something on its own (stand-up drafted a Dussehra poster) ran live on `demo_growth`. "Poster
  for Insta with my logo" and "ask an unscripted question on Discord" were not run (Discord because nothing may be posted
  to the real hub). Results for #6 are still to be written to `docs/live-scenarios.md`.
- Nothing was pushed to the real hub, so the new Discord cards have only been seen through the fake ports.

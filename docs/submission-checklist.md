# Submission checklist

Deadline: **18 October 2026, 23:59 IST** (submissions close then). Everything is submitted from the team panel on
WeMakeDevs (https://www.wemakedevs.org/hackathons/falkordb). The page does not list the form fields, so have every
item below ready before opening the form.

Rules that shape the submission (from the hackathon page): FalkorDB must be the primary graph database and central
to the product; the submission and its main FalkorDB implementation must be new work from the event; a live
deployment is preferred, and a project that cannot be deployed must include complete local setup instructions and a
working demo video. Coding assistants are allowed, and the team must be able to explain what was built and why.

## 1. What to submit

Status as of 16 October 2026, evening: **done** (ready in the repo), **needs founder** (only he can do it), **later** (waiting
on a decision or on the deployment). Nothing is submitted yet, nothing is pushed, and no public repository exists.

| Item | Where it comes from | Status |
|---|---|---|
| Project name and one-line pitch | README first lines: "Founder OS: an AI team and a company brain on FalkorDB, working through the founder's own tools." | done |
| Tracks | All three, verbatim in the form: "Agents That Act on Connected Data", "Agent Memory and Coordination", "Company Brain" (README "The three tracks" and "Tracks", with what fits each and its limits) | done in README; **needs founder** in the form |
| README with setup steps | README top (60 seconds) and "Run it": no accounts in 3 commands, live in 5. **Checked on a clean copy on 16 Oct** (below) | done |
| Setup verified on a clean machine | 16 Oct, 19:25 to 20:40 IST: export, `npm install`, web build, FalkorDB, `seed-demo`, serve, the hero question live and replayed; Docker image built and run from the export. Times and what broke: "Clean-machine check" below | done |
| Graph data model | README "The data model" and "The graph data model" (Mermaid diagrams and the three patterns) | done |
| Cypher queries and graph algorithms the product depends on | [`docs/falkordb-queries.md`](falkordb-queries.md), each with file:line, held to the code by `tests/graph/queries-doc.test.ts` | done |
| The graph doing real work, visible | The lit path under the hero answer and the Brain page's "What breaks if something stops" (depth 1 vs depth 4); replayable in public mode (`seed-demo --recorded`) | done |
| AI-tool disclosure | README "AI tools and licence" and "AI tools used" (Claude Code with subagents, Claude on the subscription at runtime, Higgsfield, local embeddings; what the founder decided) | done |
| Licence | MIT, added by `scripts/export-public.sh` (the private repo has none) | done |
| The five live scenarios | [`docs/live-scenarios.md`](live-scenarios.md): what ran, when, the result, what is open | done; two items **need founder** (a Discord question from his account, the Calendar connect link) |
| Data rules (public, synthetic or own data only) | The public copy ships only the synthetic business (Shiftly). By default the export now leaves out everything that shows the real businesses: screenshots, generated posters and reels, stand-up drafts, trial notes, real-business evals (list in section 2) | done by default; **needs founder**: #12 (keep real screenshots?) and #13 (is founder-owned data allowed?) |
| Public repository URL | Section 2 below. **Not** the existing private repo. | **needs founder** (create it, then put its URL in the README clone line) |
| Live demo URL | Section 3 below (public read-only mode) | later: deployment follows; until then the README's local setup and the replayed answers stand in |
| Demo video URL | Section 4 below (YouTube, unlisted or public) | **needs founder**: he holds it until the product is ready; script ready |
| Description | README top, "The problem", "What it does", "How FalkorDB is central" | done |
| How FalkorDB is used | README "Why FalkorDB does real work", "How FalkorDB is central" and the queries doc | done |
| Team members | Every member registered in the team panel (prizes go to every member) | **needs founder** |
| Blog post (side prize) | `docs/blog-post.md`, published on a public platform (dev.to, Hashnode or Medium), link submitted | **needs founder** (publishing is his call) |
| Screenshots | `docs/demo-screens/` (the synthetic business; README uses them). The 165 real-business images in `docs/screenshots/` stay out unless he says keep | done; real ones **needs founder** (#12) |
| Submission form | WeMakeDevs team panel | **needs founder** |

### Clean-machine check (16 October 2026)

What a judge does, run from `scripts/export-public.sh` output on a Mac that had never run it (its own FalkorDB on a free port,
no founder data, no env file, the Claude subscription only):

| Step | Result | Time |
|---|---|---|
| `scripts/export-public.sh` (export, secrets scan, hygiene test, dead-link report) | one commit, no remote, secrets scan clean, hygiene passed, no dead links | 25 s |
| `npm install` and `cd web && npm install && npm run build` | clean; npm 11.16 prints "install scripts not yet covered by allowScripts" (a notice: esbuild, sharp, onnxruntime and the Agent SDK all load) | 23 s with a warm npm cache, web build included |
| `npm run typecheck` | clean | under a minute |
| FalkorDB 6.0.2, `db:check` | "ok", settings as docker-compose.yml | 4 s |
| `npm run cli -- seed-demo` | Shiftly: 52 nodes, 73 edges, 312 readings, registered | 3 s |
| `npm run cli -- serve`, then the hero question in the web app (live, on the subscription) | answered, path drawn, two cards waiting, all checks green | 64 to 102 s over four runs |
| The same in public mode, `seed-demo --recorded` | the four recorded answers replay with their work logs and lit paths; writes refused (403); an unrecorded question says live chat needs the owner's model | 2 s |
| Docker: `docker build` of the export, then the app container against a fresh FalkorDB, `seed-demo --recorded`, the optional `demo_seed` commands | healthy, public mode on, replay works | 140 s to build with the base image cached |

**What broke, and what changed.** (1) **Public mode had nothing to ask on a fresh clone**: the synthetic business had no
recorded answers, so Ask said "pick a recorded thread" and there were none. Now `seed-demo --recorded` loads four answers
recorded live (a db:export file in `src/demo/recorded/`, held to the seed by a test). (2) **`docker compose exec app tsx
scripts/seed-demo.ts demo_seed --register` failed in the image** (a second fixture was not copied in): fixed in the
Dockerfile and `.dockerignore`. (3) A recorded question typed without the hyphen ("signups") did not match "sign-ups": matching
now ignores case, spacing, punctuation and hyphens. (4) The export script could not run its hygiene test from a worktree
(no `node_modules`): fixed. (5) The README's setup now says what each command needs and what to do about npm's notice. (6) **A restarted FalkorDB
container did not come back**: after `seed-demo` (plain or `--recorded`), `docker restart` (or a reboot, the compose file says
`restart: unless-stopped`) left FalkorDB 6.0.2 exiting at start with "Diverged applying GRAPH.EFFECT ... label 'Entity' ... does not
exist here", and the volume had to be thrown away. Cause: two places registered a label with `CREATE (n:Entity) DELETE n` in one
query, which 6.0.2 writes no effects for ("produced no effects payload"), so the append-only file lacked the label that the next
index effect names. Both now use two statements (create, then delete); checked by seeding, seeding the recorded copy, stopping and
starting the container, and reading the data back; guarded by `tests/graph/aof-restart.test.ts`. This is very likely the cause of
the "corrupt AOF base" in issue 29 on local 6.0.2.
**Not verifiable on the build machine:** `docker compose` itself (its Compose plugin is missing there); the image and the
containers were run with the compose file's exact environment instead, and the compose file is unchanged since it was last run
by hand. **If FalkorDB still crashes** (6.0.2 segfaulted once under repeated drops and re-seeds on the build machine; issue 29) and
will not restart from its append-only file, `docker compose down -v` and seed again: the demo data is rebuilt in seconds.

## 2. Make the repository public (fresh history only)

**Do not switch `Ankit-Vohra/allevia` to public.** It holds the full development history (dev and main are pushed),
and early commits contain values that were later removed from the code by the hygiene work (see commit `95a1925`,
"no real infra/company identifiers in code or docs"). Commit metadata also carries a local machine name. GitHub keeps
old commits reachable by SHA after a force-push, so rewriting that repo is not enough either.

Publish a **new repository from one squashed commit** instead. `scripts/export-public.sh` does steps 3 to 6 in one go:
it exports the tracked tree of a commit into a new temporary directory, leaves out `data/`, models, env files, the
eval reports about the real businesses (`docs/evals/2026-*`, `evals/aamdani.yaml`, `evals/avs.yaml`) and the notes
written from private copies of their graphs, adds an MIT `LICENSE`, runs a secrets scan and the hygiene test on exactly
that copy, commits it once and prints what it left out. It never pushes and never touches this repository's history
(`tests/export-public.test.ts`).

**What stays out by default** (everything that shows the founder's real businesses): `docs/screenshots/` (165 images of their
screens), `docs/creative-live/` (posters, ads and a reel made for them), `docs/proactive/` (their stand-up screens), the eval
reports and sets that quote their answers (`docs/evals/2026-*-aamdani.md`, `*-avs_atelier.md`, `evals/aamdani.yaml`,
`evals/avs.yaml`, `evals/hero-aamdani.yaml`), and the notes written from their graphs and drafts (`docs/MORNING-REPORT.md`,
`content-trials.md`, `proactive-trials.md`, `skills-trials.md`, `website-checkup-trials.md`, `design-research.md`). What ships
instead is the synthetic business's evidence: `evals/hero.yaml`, `docs/evals/2026-10-16-demo_growth.md`, `docs/demo-screens/`.
`--keep-real-material` puts the pictures back, only with the founder's yes (#12). The script ends with a **dead-link report** for
README.md and docs/**/*.md; on 16 Oct it listed only `docs/research/kylon.md` and `docs/tenant-isolation.md`.

```sh
scripts/export-public.sh --ref dev                 # prints the directory, e.g. /tmp/allevia-public.XXXXXX
```

1. [ ] (open) **Rotate the Discord bot token first.** It has lived in the local env file during development and the bot has run
   on the demo server. Reset it in the Discord developer portal, put the new one in `~/.config/allevia/allevia.env`,
   and restart the bot. Do the same for any other token in that file that was ever pasted into a chat, log or
   terminal recording (the AVS Instagram token).
2. [ ] (open) **Decide the private repo's fate.** Rename it (for example `allevia-dev-history`) and keep it private, so the
   public repo can take the name `allevia`. Then point `ALLEVIA_ACTION_REPO` at a **private** repo: the `github_issue`
   executor writes business findings into issues, and issues in a public repo are public.
3. [x] (done by the export script) **Check `.env.example` has no values.** Every line must be `NAME=` followed only by spaces and a comment:
   ```sh
   grep -nE '^[A-Z_]+=[^[:space:]#]' .env.example   # must print nothing
   ```
   The comments document defaults; review them once more for anything that should not be public (a username, an SSH
   alias, a path).
4. [x] (done by the export script: MIT, unless the tree already has a `LICENSE`) **Choose a licence** for Allevia's own
   code. Vendored data keeps its own licences in `vendor/playbooks/` and `.claude/skills/brag-slim/`.
5. [x] (done by the export script; the manual steps, for reference) **Export the tree without history and commit it once:**
   ```sh
   SHA=$(git -C ~/jarvis rev-parse dev)              # the commit being published
   mkdir ~/allevia-public && git -C ~/jarvis archive "$SHA" | tar -x -C ~/allevia-public
   cd ~/allevia-public
   git init -b main
   git config user.name "Ankit Vohra"
   git config user.email "<GitHub noreply address>"   # Settings > Emails on GitHub; not a personal address
   npm ci && (cd web && npm ci)
   git add -A
   ```
   `git archive` exports tracked files only, so `data/`, `models/`, `node_modules/` and the env file cannot come
   along.
6. [x] (done by the export script) **Re-run the hygiene test on exactly what will be published** (it scans `git ls-files`, so the staged tree is what
   it checks, and it also compares against the real vault when it is on this machine):
   ```sh
   npx vitest run tests/hygiene.test.ts
   ```
   Then a manual pass: `git grep -n -i -E 'ankit@|\.local\b|aws|ssh '` and read every hit.
7. [ ] (the founder's call, #12 and #13) **Decide about the real businesses' material.** By default none of it is in the copy
   (see above): the README and the live-scenarios page show only Shiftly, and say the real businesses' screens stay private. To
   keep the 165 screenshots and the generated posters, re-run with `--keep-real-material`; the founder approved real numbers
   for the demo, and the organisers' answer on founder-owned data (#13) decides whether they can be public.
8. [ ] (**needs founder**; the export script commits, publishing is manual) **Put the repository URL in the README** (`git clone
   <repository-url>` appears twice near the top), add the demo video link under the title once it exists, then **commit and publish:**
   ```sh
   git commit -m "Allevia: Graph Hacks submission"
   gh repo create Ankit-Vohra/allevia --public --source . --push --description "A done-for-you AI growth team for small businesses, with a company brain in FalkorDB"
   ```
9. [ ] (open) Open the public repo in a logged-out browser: README renders (mermaid diagram, screenshots), no `data/` or
   `models/` folder, one commit.

## 3. Deployment (public read-only mode)

**Status: later.** The founder's direction is product and hackathon focus now; deployment follows. Until it exists, the
submission relies on the rule's other path: complete local setup instructions (README "Run it") and a working demo
video (§4, also not recorded yet). The public deployment must serve only the synthetic demo company.

The public deployment runs `ALLEVIA_PUBLIC_MODE=1`: the office, brain explorer, insights, approvals history and the
90-day card read live from the graph; every write returns 403; Ask replays the recorded showcase turns. **No live
model**: the agents run on a claude.ai subscription login, and Anthropic's consumer terms do not cover serving
strangers on a personal plan. Live answers are shown in the demo video, and the README explains how an evaluator runs
live mode with their own login.

### What the deployment needs

- The image from `Dockerfile` (verified locally: `docker build` succeeds, the container serves the web app and the
  API, reports healthy, refuses writes in public mode, and runs the demo-seed quick start; about 1.6 GB).
- FalkorDB 6.0.2 with append-only persistence and a volume, **not reachable from the internet**.
- The graphs to show, loaded into that FalkorDB:
  - `allevia_meta` (the registry), `allevia_aamdani` and `allevia_avs_atelier`, with the showcase turns marked
    (`npm run cli -- showcase <tenant>` lists them: five for Aamdani, one for AVS Atelier at the time of writing).
  - **Before exporting, `privacy-scan` must report 0 for each graph.** On 15 October `aamdani` reported 0 and
    `avs_atelier` reported 10 hits: the studio's own contact email and phone number in a crawled contact-page chunk,
    and Studio asset hashes that the scanner reads as secrets. Fix or accept each one before the AVS graph goes
    public.
  - Drop throwaway graphs (`allevia_test_*`, `allevia_demo_seed`) from the copy, not from the working server.
- Optional: the Studio's images live in the data dir (`ALLEVIA_DATA_DIR`), not the graph: `data/assets/<tenant>`
  (originals and variants), `data/studio/recorded` (the recorded generated edit) and `data/studio-demo/<tenant>` (the
  demo sample). Copy them to the deployment's `/data` volume if the Studio page should show its last run. Nothing
  else in `data/` is needed to serve the demo.

### Moving the graphs

FalkorDB stores graphs as Redis keys, so a snapshot moves them:

```sh
# snapshot the working server (read-only for it), then trim a copy; never delete graphs on the working server
docker exec allevia-falkordb redis-cli BGSAVE                 # writes dump.rdb in /var/lib/falkordb/data
docker cp allevia-falkordb:/var/lib/falkordb/data/dump.rdb ./dump.rdb
docker run -d --name fdb-trim -v "$PWD":/var/lib/falkordb/data -e REDIS_ARGS="--appendonly no" falkordb/falkordb:6.0.2
docker exec fdb-trim redis-cli GRAPH.LIST                     # then GRAPH.DELETE each graph that must not ship
docker exec fdb-trim redis-cli SAVE && docker rm -f fdb-trim  # ./dump.rdb now holds only the graphs to publish
```

On the target, start FalkorDB once with `REDIS_ARGS="--appendonly no"` and `dump.rdb` in its data directory so it
loads the snapshot, run `redis-cli CONFIG SET appendonly yes` (Redis rewrites the append-only file from memory), wait
for `INFO persistence` to show `aof_rewrite_in_progress:0`, then restart with the compose file's
`--appendonly yes`. Check with `npm run cli -- db:check` pointed at it.

### Where to host

| Option | How | Notes |
|---|---|---|
| **Railway** (spec default) | Two services from the repo: the app from `Dockerfile`, FalkorDB from the `falkordb/falkordb:6.0.2` image with a volume on `/var/lib/falkordb/data`. Set `ALLEVIA_FALKORDB_URL=redis://<falkordb service>.railway.internal:6379`, `ALLEVIA_PUBLIC_MODE=1`, `HOST=0.0.0.0`, `PORT` as Railway sets it. | Keep FalkorDB on private networking only (no public domain, no TCP proxy). Load the snapshot through the volume. |
| **Fly.io** | Two apps (or one machine with both processes), a Fly volume for FalkorDB, `.internal` networking. | Same rules; no public port for FalkorDB. |
| **A small VPS** (Hetzner, Lightsail) | `docker compose up -d` as committed, plus Caddy on the host proxying a domain to `127.0.0.1:8787` for TLS. | Simplest to reason about; the compose file already binds every port to 127.0.0.1. |

Before sharing the URL:

- [ ] `curl https://<host>/api/health` shows `"publicMode":true`.
- [ ] A `POST` to an approval returns 403; the onboarding form refuses; the Studio upload refuses.
- [ ] Ask lists only the showcase threads, and each replays to its answer and path.
- [ ] FalkorDB's port is not reachable from outside (`nc -vz <host> 6379` fails).
- [ ] No `CLAUDE_CODE_OAUTH_TOKEN`, Discord token or any other secret is set on the host.
- [ ] `ALLEVIA_WEB_URL` is the public URL if the Discord bot links to it.

## 4. Demo video

**Status: needs founder.** Not recorded yet; he holds it until the product is ready.

Script: [`docs/demo-script.md`](demo-script.md): the hero use case first, then the five live scenarios (onboard from a URL; an
unscripted question on Discord with its path; a poster with the owner's logo; a bad photo turned into good content; the team
noticing something and drafting it). What ran and what each needs is in [`docs/live-scenarios.md`](live-scenarios.md). Live
first; a recorded replay only as a labelled fallback (`seed-demo --recorded` replays the four hero-set answers).

- [ ] Recorded as a **live** run of the five scenarios; any replay is labelled on screen.
- [ ] Under 3:00, 1080p, readable at phone size; captions on.
- [ ] Shows each judging point: the graph shaping the answer (the lit path, depth 1 vs depth 4), memory that compounds
      (learned rule), onboarding a business from a URL, acting after one tap, FalkorDB under the hood.
- [ ] Any sped-up part is labelled; simulated ad data is called simulated wherever it appears.
- [ ] Frame-by-frame check: no token, email, phone, IP, private document title, terminal history or env file.
- [ ] Music, if any, is licensed for the use (or none).
- [ ] Uploaded to YouTube (unlisted is fine), link added to the README and the submission.

## 5. Final pass (18 October)

Done on 16 October on the then-current tree (the numbers are in the README): typecheck, the full suite against a throwaway
FalkorDB (`ALLEVIA_TEST_FALKORDB_URL=redis://127.0.0.1:<port>`; the tests never use the real database), the export's secrets
scan and hygiene test. Repeat after the last merge:

- [ ] `scripts/export-public.sh --ref dev` prints no secrets, no failing hygiene test and no dead link you did not expect.
- [ ] `npm run typecheck`, `npm test` against a throwaway FalkorDB.
- [ ] If the seed changed (a new department adds records to Shiftly): `tests/demo/recorded.test.ts` fails until the recorded
      answers are made again (`scripts/maint/record-demo.mjs`, about 5 minutes on the subscription), then the screenshots
      (`web/scripts/screenshots-demo.mjs`) and the thread link in the README.
- [ ] The README's test count and eval numbers match the latest run and `docs/evals/`.
- [ ] `<repository-url>` in the README is the real public URL; the demo video link is under the title.
- [ ] Hygiene test passes on the published tree; the public repo has one commit; a logged-out browser shows the README
      (Mermaid diagrams and screenshots render), no `data/` or `models/`.
- [ ] Live URL, repo URL, video URL and blog URL all open logged out.
- [ ] Submitted before 23:59 IST, with a screenshot of the confirmation.

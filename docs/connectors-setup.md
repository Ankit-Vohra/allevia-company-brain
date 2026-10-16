# Connectors: what the founder sets up

> Superseded for setup by `docs/connections-setup.md` (issue #40): Composio is the main path now, Search Console is a normal connection on the
> Connections page, and `ALLEVIA_SEARCH_CONSOLE=1` is no longer needed. The Google Cloud steps below still apply to our own Google app.

2026-10-15. Three customer data paths were built after the onboarding trials (`docs/onboarding-trials.md`, gaps 1 and 2).
Two need nothing from you. One needs a Google Cloud project, and this page lists exactly what to create.

| Path | What a customer does | What you set up |
|---|---|---|
| **Add your numbers** (spreadsheet upload) | Drops a CSV or XLSX on the growth plan card, checks "This looks like weekly enquiries. OK?", taps OK | Nothing |
| **Where a fix lands** | Nothing by default: an approved fix becomes a task inside the app. GitHub is an opt-in for a repo of their own | Nothing (the founder's own businesses keep their tracker) |
| **Connect Search Console** | Clicks Connect, signs in to their own Google account, says yes to read-only Search Console | Everything on this page |

**Parked for now (2026-10-15, founder's call: product and hackathon first).** The Search Console connector is off unless
`ALLEVIA_SEARCH_CONSOLE=1`: with it off, nothing calls Google, the daily pull does not start, and the web app shows no
Connect button. The code, tests and the steps below are kept so it can be switched on later.

Search Console was built and tested against a fake Google. **It has never talked to the real Google**, so expect a small
fix or two the first time you connect your own account (steps at the end).

## What to create in Google Cloud (about 20 minutes, once)

1. **A Google Cloud project.** Console, project picker, New project, name it `Allevia`. Any organisation is fine; "No
   organisation" works.
2. **Turn on the API.** APIs and services, Library, search for **Google Search Console API**, Enable. (Its address is
   `searchconsole.googleapis.com`.)
3. **The OAuth consent screen.** APIs and services, OAuth consent screen (Google's newer console calls it "Google Auth
   platform"). Choose **External**. Fill in:
   - App name `Allevia`, a support email, a developer contact email.
   - App home page, **privacy policy** and terms links (Google requires a privacy policy link before it lets the app be
     used by people outside your project; write one that says what we read: Search Console clicks, impressions, pages and
     searches, read-only, and that a business can disconnect at any time).
   - Authorised domain: the domain Allevia is served from.
   - **Scopes:** add exactly one, `https://www.googleapis.com/auth/webmasters.readonly`.
4. **Publish it.** While the app's status is **Testing**, Google lets only the test users you list sign in (up to 100) and
   **expires their refresh tokens after 7 days**, which would stop the daily read a week after each connection. Move it to
   **In production**. Google lists this scope as sensitive (check the scope's label in the console), so an unverified
   production app shows customers a "Google hasn't verified this app" warning and is capped at 100 users until Google
   verifies it (a review that needs the privacy policy, a verified domain and usually a short demo video; it takes days to
   weeks). Start the verification early. Until then, for your own accounts and a few friendly customers, click through the
   warning. These Google rules are from memory of the console as it was when this was written: read what it shows you.
5. **The OAuth client.** APIs and services, Credentials, Create credentials, **OAuth client ID**, type **Web
   application**, name `Allevia web`. Under **Authorised redirect URIs** add exactly:

   ```
   <the address Allevia is served from>/api/connectors/google/callback
   ```

   for example `https://app.example.com/api/connectors/google/callback`. It must match character for character (scheme,
   host, port, no trailing slash). For trying it on your own machine, `http://localhost:8787/api/connectors/google/callback`
   is allowed as well (add it as a second URI). Leave "Authorised JavaScript origins" empty. `npm run cli -- connect status`
   prints the redirect address this server will use.
6. **Copy the client ID and the client secret** from the dialog Google shows. The secret is shown again later, but treat it
   like a password.

## What to set on the server

Put these four in `~/.config/allevia/allevia.env` (mode 600; never in the repo, never in chat). `.env.example` lists them.

| Setting | What it is |
|---|---|
| `ALLEVIA_GOOGLE_CLIENT_ID` | The OAuth client ID from step 6 |
| `ALLEVIA_GOOGLE_CLIENT_SECRET` | Its secret |
| `ALLEVIA_CONNECTOR_KEY` | At least 32 random characters that lock every business's stored Google access. Make one with `openssl rand -base64 32`. **Back it up.** Lose it and every business has to connect again |
| `ALLEVIA_GOOGLE_REDIRECT_URI` | Only if it is not `<ALLEVIA_WEB_URL>/api/connectors/google/callback`. Normally leave it unset and set `ALLEVIA_WEB_URL` (the public address of the app) instead |

Restart the server. Until all of the first three are set, **Connect Search Console says, in plain words, "isn't switched
on yet"** and nothing asks Google for anything. `npm run cli -- connect status` says which of them is still missing.

## Try it with your own account

```
npm run cli -- connect status                 # set up? and the redirect address to register
npm run cli -- connect url <tenant>           # the Google address a business would be sent to
```

Open that address in a browser signed in to a Google account that owns a Search Console property for the business, say yes,
and you land back in the app. Then:

```
npm run cli -- connect status <tenant>        # connected, which website, how fresh
npm run cli -- connect pull <tenant>          # read it now
npm run cli -- capabilities <tenant>          # Search Console should read "api"
```

What to check: the Search Console line on the growth plan card reads live, and the Search clicks goal shows a number with a
"where you started" instead of "We'll know after your first full week".

## What it does

- **Connect.** `POST /api/:t/connectors/search-console/connect` returns Google's address; Google sends the owner back to
  `/api/connectors/google/callback` with a one-time code. The `state` that travels through Google is signed with the
  connector key, names the business, expires in 10 minutes and works once, so a link cannot be forged or moved to another
  business. The code becomes an access token and a refresh token.
- **Where the tokens live.** Sealed (AES-256-GCM, a key derived from `ALLEVIA_CONNECTOR_KEY` and the business's slug) in one
  file per business, `data/connectors/<slug>/search-console.sealed`, mode 600, outside git. **Never in the graph**: the graph
  only holds the Search Console System node (status, which website, when it last read). A file copied into another
  business's folder cannot be opened there.
- **The website.** The account's properties are listed; the business's own domain is picked when there is one clear match
  (a "Domain property" first), otherwise the owner chooses (`POST .../property`).
- **The daily read.** The server reads every connected business once a day (about 20 hours apart, checked hourly), and
  `connect pull --all` does the same from cron. The first read goes back 90 days; later ones re-read the last 3 days because
  Google revises them, and stop 3 days short of today because the newest days are not final. It writes, as live connector
  numbers (so the ladder reads `api`): daily clicks, impressions, click-through rate and position for the whole site (a day
  with no row from Google is written as zero clicks and zero impressions), a 28-day reading for each page the crawl already
  knows, and for the top 50 searches. A search that carries an email address, a phone number or anything else the privacy
  filter would redact is dropped.
- **When it breaks.** If Google refuses to refresh (the owner removed Allevia, or the app was in Testing for over a week), the
  connection is marked expired, the capability drops a rung, and the owner is told in words to connect again. A rate limit or
  a Google outage is recorded and retried the next day without touching the capability.
- **Disconnect.** Deletes the stored access and asks Google to revoke it. The numbers already read stay.

## Where fixes land

Before this, `github_issue` opened an issue on one repo from the server's config, Allevia's own. Each business now has its
own action target (`GET` or `POST /api/:t/actions/target`), stored on its Business node:

- **A business that chose nothing, and is a customer's: a task inside the app.** An approved fix becomes an open task; the
  card the owner approved already showed on the web and in Discord. Nothing outside Allevia is touched, not even in a live
  run.
- **Opt-in: GitHub on the business's own repo** (`owner/name`). The server's `gh` login must be able to write to it.
- **The founder's own businesses** (`src/tenant-config.ts`, plus any named in `ALLEVIA_ACTION_TENANTS`) that chose nothing
  keep filing on `ALLEVIA_ACTION_REPO`, as before. Nothing for you to do.
- **A customer's business can never be pointed at `ALLEVIA_ACTION_REPO`**: it is refused in every spelling, and a graph
  written directly with that repo still lands in tasks. Only you, from the terminal, can allow it:

```
npm run cli -- action-target <tenant>                                     # show it
npm run cli -- action-target <tenant> repo <owner/name> [--operator]      # --operator: allow Allevia's own repo
npm run cli -- action-target <tenant> app                                 # tasks, even for a founder's business
```

## What others still have to wire

- **Sign-in is already covered, with one exception by design.** Every route under `/api/:t/` (the upload, the action
  target, connect, property, pull, disconnect) sits behind the owner-link door when `ALLEVIA_AUTH=1`. Google's redirect
  back, `GET /api/connectors/google/callback`, cannot carry the owner's cookie (it arrives from another site and the cookie
  is `SameSite=Strict`), so it proves itself with the signed, expiring, single-use `state` that `connect` made. `connectors`
  was added to the reserved slugs (`src/graph/slug.ts`) so the door lets that one path through. One rough edge for whoever
  owns the cookie: the first page the owner lands on after Google may show "This business is private" until they reload,
  because the redirect chain began on another site. A tiny interstitial page, or a `Lax` cookie, fixes it.
- **Discord.** The spreadsheet path is reusable from Discord: download the attachment, call `previewUpload(g, businessId,
  {fileName, bytes})`, show `describePreview(preview)`, apply the owner's replies with `applyReply(plan, text)`, then
  `importUpload(g, businessId, file, plan, Date.now())` and show `describeResult(result)` (all in
  `src/connectors/upload/` and `src/server/routes/numbers.ts`). The Discord approval card still labels this kind "GitHub
  issue" (`src/discord/bot.ts`); for a customer it should say "a fix for your website", since the default lands in tasks.
- **A secret store.** `docs/tenant-isolation.md` lists the missing per-business secret store. Search Console's tokens use a
  small one of their own (`src/connectors/google/store.ts`: sealed files, one per business and connector). Instagram and
  Business Profile will need the same shape; reuse the `TokenStore` interface.
- **The upload's caps** (20 MB, 50,000 rows, 100 columns, 20,000 numbers a file) are constants in
  `src/connectors/upload/limits.ts`.

# Tenant isolation

This page says, in plain words, how one business's data is kept apart from every other business's in Allevia, what we
checked, what we found and fixed, and what is still open. It is written for a customer's security reviewer as much as
for us. Every claim below has a test in [`tests/security/`](../tests/security/) that tries to break it; run them with
`npx vitest run tests/security`.

**The requirement.** Each company's graph is different and every company is completely isolated from the others. The
code stays the same, but their knowledge and tweaks are different.

## In one paragraph

Every business has its own FalkorDB graph, `allevia_<slug>`, and its own folders under the data directory. A request is
bound to exactly one business by the server before any agent, tool or query runs; nothing a caller sends (a path, a
header, a tool argument, a message, a card) can change which graph is used. Everything a business can tweak (which
agents are on, how free they are, standing instructions, brand rules, learned rules, goals) is data in that business's
own graph. A new business starts from code (the roster, the industry template, public playbooks), never from a copy of
another business. With `ALLEVIA_AUTH=1`, nobody can open a business without its private owner link; only a business
marked as a public demo opens without one, and then read-only.

## What isolates what

| What | Kept apart by | Where | Test |
|---|---|---|---|
| A business's knowledge: facts, documents, numbers, notes, the team's memory, learned rules, settings, goals, approvals, Studio records | Its own graph `allevia_<slug>`. The only way a business becomes a graph name is `graphName(slug)`. | `src/graph/client.ts`, `src/graph/slug.ts` | `slug`, `http-isolation`, `graph-binding` |
| The slug itself | One rule: lowercase letters and digits joined by single `_`, at most 40 characters, and not a reserved word (`meta`, `operator`, and the API's own path words). So no tenant can be called `allevia_meta`, and no slug can carry a path, a quote or a look-alike letter. | `src/graph/slug.ts` | `slug` (33 crafted slugs against every place a tenant is named) |
| The registry (`allevia_meta`): which businesses exist, their region, the hashes of owner links, and the Discord hub's mapping and join links | Only the tenant registry, the token store and the hub's store open it. No request reads it directly; a business is shown only its own join link. It never holds a business's knowledge. | `src/graph/tenants.ts`, `src/auth/tokens.ts` | `tokens`, `slug` |
| What an agent, a tool or the MCP server can read | The graph handle is put in the request by the server (`ToolContext.graph`). No tool has an input that names a tenant, graph or database, and a forged one in the arguments is dropped before the tool runs. | `src/agent/tool.ts`, `src/mcp/server.ts` | `graph-binding` |
| The free-form `cypher` tool | Read-only three ways: a text guard, `GRAPH.RO_QUERY` (the server itself refuses a write), and bounds on time and size. It runs inside one graph; Cypher has no way to name another. | `src/agent/tools/cypher.ts` | `graph-binding` (graph-switching syntax, over thirty spellings of a write, crafted parameters) |
| Search: full-text and vector indexes | Per graph. Searching in one business cannot reach another's index. | `src/graph/indexes.ts` | `graph-binding` |
| Cached graph projections (what the graph algorithms run on) | Keyed by graph name, with a write stamp per graph. A write invalidates only its own graph's. | `src/graph/projection.ts` | `projection-cache` |
| Studio photos and videos | `data/assets/<slug>/<sha256>.<ext>`. The folder comes from a valid slug; the file name must be a 64-hex hash plus an image extension, so a key can never leave the folder, even if a graph holds a crafted one. | `src/studio/store.ts` | `slug`, `http-isolation` |
| Drafts of approved posts | `data/drafts/<slug>/<card id>.md`. The card id is reduced to a file name. | `src/actions/executors.ts` | `connectors` |
| Cached model answers (extraction, website questions, photo reading) | One folder per business: `data/cache/<kind>/<slug>/`. A key already carries the business context, so a hit across businesses needed identical text and identical context; one folder each means they never meet. | `src/util/cache.ts` | `caches`, `paths` |
| Onboarding crawl output and run reports | `data/onboard/<slug>/`, `data/runs/<slug>/`. Onboarding refuses a crafted slug before it writes anything. | `src/onboard/onboard.ts` | `paths` |
| What leaves the system when a card is approved | The GitHub repo and Discord channel in the env file are the founder's, and belong to the founder's own businesses (and any named in `ALLEVIA_ACTION_TENANTS`). Any other business's approved card is skipped, live or dry. A card cannot pick the Discord channel. | `src/actions/executors.ts` | `connectors` |
| Model calls (Claude on the subscription) | Each call is built from one business's graph through tools bound to it. The agents have no built-in tools (no shell, no files, no web), an empty working folder, and an allow-listed environment with no keys or tokens. | `src/agent/runtime.ts`, `src/agent/sdk-env.ts`, `src/ingest/llm.ts` | `graph-binding`, `tests/agent/sdk-env.test.ts` |
| Who may open a business | Owner tokens (below), when `ALLEVIA_AUTH=1`. | `src/auth/tokens.ts`, `src/server/auth.ts` | `auth`, `mcp-auth`, `cli-auth` |
| What a business's team does by default | Code: the roster, the industry template, the vendored public playbooks. Not a copy of any graph. | `shared/roster.ts`, `src/onboard/templates.ts` | `config-per-tenant` |
| Discord (the shared hub: one server, one bot, every customer) | Which business a Discord event belongs to is decided only by the channel id, looked up in a saved mapping (`allevia_meta`); channel names, message text, display names and button ids never choose one. A person must hold that business's own Discord role (Allevia staff alone do not ask a customer's team anything or decide its cards). Each business gets its own bot instance over its own graph. `#support` is people only: nothing in it reaches an agent. Join links are single-use, expire in 7 days, and give exactly one business's role. | `src/discord/hub-*.ts` | `tests/discord/hub-*.test.ts` |
| The older single-business Discord bot (`discord --tenant`) | One business, one server and one channel, fixed when it starts. Nothing in a message, command or button chooses another. | `src/discord/bot.ts` | `discord-isolation` |
| The CLI, scripts and stdio MCP | The operator's own machine: whoever can run them is the operator. They validate the slug the same way. | `src/cli/` | `slug`, `cli-auth` |

## How a request is bound to one business

1. **The path names the business, and only the path.** `/api/<slug>/...`. The slug must be a valid slug and registered;
   otherwise the answer is the same 404 (or, with `ALLEVIA_AUTH=1`, the same 401) for a business that exists and one that
   does not. A header, a cookie, a query value or a body field naming another business is ignored.
2. **The server opens that business's graph and hands it to the code.** Routes, agents and tools receive a graph handle,
   not a name. Tools have no `tenant` or `graph` input; the schema drops one if it is sent.
3. **Every query is parameterised.** Values travel as parameters; a crafted value cannot break out of its quotes. The
   few names that are put into Cypher text (labels, relationship types) come from fixed lists and are checked.
4. **Reads on the agent's behalf go through `GRAPH.RO_QUERY`**, which the database itself refuses to run if it would
   write.

## Who may open a business

### The exposure before this work

There was no login. A business is addressed by its slug, and the slug is the business's name in lowercase
(`Kestrel & Oak` is `kestrel_oak`), so it is effectively public. Anyone who could reach the server could, for any
registered business:

- read everything the API shows: the knowledge graph, notes, threads and their full work logs, approvals, goals,
  recommendations, Studio photos;
- ask questions (spending the operator's model subscription) and watch the answers;
- approve or reject cards, which runs the executors (drafts, and GitHub issues and Discord posts when live);
- change the team (switch agents off, raise their autonomy), write standing instructions and brand rules, retire learned
  rules, run the detectors, upload photos;
- list every business with its name, website and industry (`/api/tenants`), and count them (`/api/health`);
- create a business, or write into an existing one by onboarding with its slug.

The public demo mode made every write a 403, but it showed every registered business read-only, so a real customer on
the same deployment would have been readable by the world.

### The fix: an owner link, behind `ALLEVIA_AUTH=1`

- **A token per business.** `npm run cli -- auth:issue <slug>` prints a link, `https://<host>/#key=<token>`, once. The
  token is `<slug>.<secret>`; the secret is 32 random bytes (256 bits). Only its SHA-256 is stored, as an `AuthToken`
  node in the registry graph. A token cannot be looked up again, only revoked and replaced. A fast hash is right here
  because the secret is random and long; there is nothing to guess.
- **Required on every route under `/api/<slug>/`**, checked by one middleware before any body is read, as
  `Authorization: Bearer <token>` (scripts, the CLI, MCP) or as the cookie the web app gets. The token must be valid, not
  revoked, not expired, and for that business (or the operator). A test lists every route registered under a tenant and
  asserts each one is refused without a token, so a new route cannot be left out by accident.
- **The link opens the web app once.** The token is in the `#fragment`, which no server, log or `Referer` header ever
  sees. The page removes it from the address bar, posts it to `/api/auth/open`, and the server answers with a cookie
  `allevia_k_<slug>`: `HttpOnly` (scripts cannot read it), `SameSite=Strict`, `Path=/api`, `Secure` over https. The page
  never stores the token. A browser with no link is shown a plain "This business is private" page with a paste box.
- **Revocable at once.** `auth:revoke <id>` or `auth:revoke --tenant <slug>`; the next request is refused (a token is
  read from the registry on every request, never cached). `auth:list` shows ids, labels and dates, never the link.
  `--days N` makes a link expire.
- **Demo businesses.** `auth:demo <slug>` marks a business as a public demo. Without a token it opens read-only (every
  change is a 403, threads show only showcase turns), exactly as public mode did. A visitor holding a token for
  a business is its owner even on a deployment in public mode. Marking takes up to 5 seconds to apply (the server caches
  the registry that long).
- **The operator link** (`auth:issue --operator`) opens every business and is the only thing that can start onboarding
  (a business spends model time and makes a graph). Keep it off shared machines.
- **The business list** (`/api/tenants`) shows a stranger only the demos, an owner their own business and the demos, the
  operator everything. `/api/health` stops reporting the number of businesses.
- **Cross-site requests are refused** (with the flag on): a change that carries a foreign `Origin`, or is a cross-site
  fetch, is a 403. This also stops a form on another site from posting an attacker's own link to `/api/auth/open`.
- **MCP over HTTP** needs the same bearer token. stdio MCP is the operator's own process.
- **Off for local development.** Without the flag nothing is checked, as before. The server warns at start-up when it
  is open and either in public mode (every registered business is shown read-only) or listening beyond localhost.

Before the first paying customer: set `ALLEVIA_AUTH=1`, issue that customer's link and the operator's, mark only the demo
businesses with `auth:demo`, and keep the database private (see the open items).

## What we found and fixed

Ranked by how bad it would have been.

1. **A tenant called `meta` was the registry.** `graphName("meta")` returned `allevia_meta`, so onboarding with the slug
   `meta` (or `meta` as a company name), or any CLI command given `meta`, wrote a business and the tenant indexes into the
   registry graph. Fixed: one slug rule with reserved names, used by every place a tenant becomes a name, folder or file.
2. **Onboarding could be steered into someone else's business.** `POST /api/onboard` with an existing slug, or with a name
   or web address that mapped onto one, ran the onboarder against that business's graph: it renamed it and wrote another
   site's crawl into it. Fixed: an existing business is never onboarded unless the operator names it; otherwise 409 or
   the next free id. With the flag on, onboarding is operator-only.
3. **No login.** See above. Fixed behind `ALLEVIA_AUTH=1`.
4. **A customer's approved card could leave through the founder's accounts.** With live actions on, an approved
   `github_issue` was filed on the founder's repository, and a `discord_post` went to the founder's channel, or to any
   channel id written in the card. Fixed: those accounts belong to the founder's businesses only; other businesses are
   skipped, live or dry, and a card cannot choose a channel.
5. **Business list and counts were public.** Fixed under the flag.
6. **Cross-site changes with a cookie.** Found while building the cookie: a `text/plain` form post was parsed as JSON, so
   `SameSite=Strict` did not cover login-CSRF or a sibling subdomain. Fixed with the Origin / fetch-metadata check.
7. **Shared content-keyed caches.** Not exploitable (see the table), but one folder per business removes the reliance.
8. **MCP over HTTP had only a localhost guard.** With the flag on it now needs the business's token.
9. **A demo business showed its Discord join link to anyone.** The page that shows an owner their business's Discord link
   checked the deployment's public mode, not the request's, so with owner links on a visitor to a demo business (no token)
   was given a link that puts a person in that business's Discord area with its role. Fixed: only an owner is shown one.
10. **Photo caches on the Discord hub's paths.** The Studio run scoped its photo-reading cache per business, but the hub's
    revisions and video first frames called the readers directly. The readers now pick the business's own cache from the
    graph they are given, whoever calls them.

Checked and found sound (tests keep them so): the `cypher` tool and every other tool are bound to one graph and cannot
write; no tool accepts a tenant or graph argument; the MCP server is fixed to one business at start-up; parameters cannot
break out of their quotes; Studio files cannot leave their folder; the projection cache and write stamps are per graph; a
turn running for one business cannot be listed, followed, replayed or stopped through another; a Discord message, command
or button cannot be pointed at another business (the hub's own tests try forged channel names, threads, roles, buttons
carrying another business's card, and two people joining at once); photos and videos from Discord are taken only from
Discord's own hosts, size-limited and re-read as images; onboarding fetches a customer's website only at public
addresses (checked again when the name resolves, so a name that points at a private address is refused); the per-business
defaults come from code.

## What is still open (ranked)

1. **The database has no password.** FalkorDB's Redis port and the FalkorDB Browser (port 3090, which can run any query
   on any graph) are bound to localhost in `docker-compose.yml` and have no authentication. Anything that can reach them
   reads every business. Before hosting on anything but one machine: keep both on a private network, set
   `--requirepass` and put the password in `ALLEVIA_FALKORDB_URL`, and stop publishing the Browser.
2. **One process, one database user.** Isolation between businesses is enforced by the application, not by the database:
   a bug in our code could reach another graph, because the app's connection can read all of them. The next step is a
   database user per business (Redis ACL on the key pattern `allevia_<slug>*`) with the app opening one connection each.
3. **An owner link is a shared secret, not a login.** Whoever holds it has the whole business until it is revoked: there
   are no individual users, no roles, no audit trail of who did what (changes are attributed to `person:owner`), no
   rate limit on `/api/auth/open` (guessing a 256-bit token is not feasible, but each try costs a registry read), and
   links do not expire unless issued with `--days`. Put a rate limit at the reverse proxy, issue short-lived links, and
   plan real sign-in before a business has more than one person.
4. **The operator link is all-powerful** and stored the same way as an owner link. Keep it to one or two people; revoke
   and reissue when someone leaves.
5. **There is no per-business store for secrets yet.** Every token Allevia uses today (the Discord bot, the founder's Instagram
   and GitHub access, the ops box) is a single value in the founder's env file, and belongs to the founder's own
   businesses. When a customer connects their own accounts (Google, Instagram, ads), each token must be its own record: encrypted
   at rest, readable only by that business's code path, never in the env file, the graph's searchable text or a log.
   Nothing of this exists yet, so nothing is stored wrongly; the design has to come first.
6. **Discord is a shared room with a staff key.** The hub's design is sound (see the table), but: Allevia staff can read
   every customer's channels, by design, for support, so keep that role to a few people; everything said there lives on
   Discord's servers, outside our control; whoever holds a customer's role (anyone who used its join link) can ask its
   team and decide its cards, so treat a join link like the owner link; and the hub's mapping and the join links sit in
   the registry graph beside the tenant list. Without owner links (`ALLEVIA_AUTH`) anyone who knows a business id can ask
   the server for its join link (the server warns at start-up). The older `discord --tenant` bot is still one business per
   process and treats the server owner as the business owner.
7. **One model subscription serves every business.** All prompts and photos go through the same account (the provider
   treats them alike), and the limits are shared: two live questions at once, one onboarding at a time, one Studio run at
   a time, across all businesses. One busy business can slow the others. Per-business queues and limits are not built.
8. **The founder's paths are defaults for any new ingest config.** `ingest` runs only for businesses configured in
   `src/tenant-config.ts` (code, written by a developer), but one that lists the `brain` or `ops` source without its own
   path would read the founder's vault or ops box. Require an explicit path per business before adding a customer there.
9. **Recorded Studio edits are keyed by the photo's hash only.** They are demo recordings from the founder's runs; a
   customer who sent the identical file would get that edit (and its recorded prompt). Harmless today; give live
   Higgsfield jobs a per-business ledger and never reuse another business's output.
10. **One volume holds every business.** Backups of the data volume and the FalkorDB volume contain all businesses.
   Erasing one business is "drop its graph and delete its five folders" (assets, drafts, cache, onboard, runs); there is
   no single command for that yet, and no per-business export.
11. **The registry is cached for 5 seconds,** so marking a demo, or a business appearing, takes up to 5 seconds. Revoking
    a link is immediate.

## Running it

```
npm run cli -- auth:issue kestrel_oak --label "Priya's laptop" --days 90   # prints the link once
npm run cli -- auth:list [kestrel_oak]                                     # ids, labels, dates; never the link
npm run cli -- auth:revoke tok_ab12cd34ef                                  # or: auth:revoke --tenant kestrel_oak
npm run cli -- auth:demo demo_seed                                         # public read-only demo; --off to undo
npm run cli -- auth:issue --operator --label ops                           # the operator's link
ALLEVIA_AUTH=1 npm run cli -- serve
```

## The short version (for the README)

> Every business is its own graph (`allevia_<slug>`) and its own folders; a request is bound to one business by the
> server, no tool or message can pick another, and a new business starts from code, never from another's data.
> With `ALLEVIA_AUTH=1` every business needs its private owner link (random, hashed, revocable); only marked demo
> businesses open without one, read-only.
> The proof is in `tests/security/`; the open items, ranked, are in this page.

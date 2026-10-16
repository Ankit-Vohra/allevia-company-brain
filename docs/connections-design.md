# Connections: how Allevia's team connects to a business's accounts

2026-10-16, issue #31 (feeds #18 Search Console and GA4, #19 Instagram and Business Profile). A design, not code. Prices
and review rules were checked on the web on 16 October 2026 and carry their sources; anything marked *[unverified]*
could not be confirmed and must be checked before money or time is committed.

## The answer in one paragraph

**Own the connections that the growth plan is measured on, and rent the long tail.** Allevia registers its own OAuth
apps with Google and Meta (its name on the consent screen, its app reviews, tokens sealed per business in our own
store, the code path that `src/connectors/google/` already has) for Search Console, GA4, Business Profile, Calendar,
Gmail sending, Instagram, Facebook Pages and WhatsApp. Everything else a business might use (Shopify, HubSpot,
Pipedrive, Zoho, Stripe, Slack, Mailchimp and so on) goes through **Composio**, behind one `Connector` interface, with
Allevia's own OAuth credentials plugged into Composio as soon as each app is approved. For the hackathon, Composio's free
tier (managed apps, $0) gives a live Instagram connection for the demo while Google runs on our own client in Testing
mode. This is the same split Kylon runs: its subprocessor list names Composio "for some third-party integrations (not
native Google OAuth / direct Google API connections)".

## 1. What we need to connect, and why

| Platform | What the team gets from it | Capability (ladder key) | Read or write |
|---|---|---|---|
| Search Console | searches, clicks, pages not indexed | `search_console` | read |
| GA4 | visits, sources, conversions | `ga4` | read |
| Google Business Profile | calls, directions, website clicks; reviews and replies | `gbp`, `reviews` | read; reply to a review (write, with OK) |
| Gmail | send follow-ups as drafts; later read enquiries | new: `email` | send (with OK); read later |
| Google Calendar | bookings, availability for posts and calls | new: `calendar` | read |
| Instagram | reach, saves, followers, best posts; publish | `instagram_insights` | read; publish (with OK) |
| Facebook Pages | page reach, messages | new: `facebook` | read; post (with OK) |
| Meta Ads | spend and results instead of benchmarks | `ads` | read; pause (with OK) |
| WhatsApp Business | enquiries, replies, Today's note on WhatsApp (Growth plan, Phase 2) | new: `whatsapp` | send templates (with OK) |
| Shopify | orders, revenue, products | new: `shop` (feeds the "orders" goal) | read |
| HubSpot, Pipedrive, Zoho, GoHighLevel | enquiries and deals | new: `crm` (feeds "enquiries") | read; update with OK |
| Stripe | revenue, signups | new: `payments` | read |
| Slack, Discord | where the owner already talks | (surfaces, not data) | post with OK |

The spreadsheet upload (`src/connectors/upload/`) stays as the fallback for every number, and the public-data tools
stay as the rung below.

## 2. How Kylon and comparable products do it

- **Kylon** (read on its site and docs, see `docs/research/kylon.md`): a connection is one account at one provider,
  **owned by the person who connected it**. Kinds: OAuth sign-ins, hosted toolkit authorisations (Composio:
  `"backend": "composio"` on a connection in its App Connection API docs), remote MCP servers (Streamable HTTP, OAuth
  with dynamic client registration), messaging accounts (LINE), and "Custom API Services" with pasted keys. Google is
  native (its own OAuth app; Google Limited Use wording on its subprocessor page). Agents get three built-in tools,
  `list_connections`, `search_connection_tools`, `execute_connection_tool`; credentials are applied server-side and
  never enter the chat. **An agent asks for a connection with a setup card**; the authorisation call records why
  (`one_off_access`, `realtime_delivery`, `scheduled_digest`). Using a person's connection for their current request
  needs no standing grant; lasting use by an agent or an Automation is a separate grant the owner approves. Sends become
  drafts. "Built-in tools" (Apollo, Apify, Exa, media models) need no account: Kylon holds the key and charges credits.
- **Lindy** runs on Pipedream Connect and uses Pipedream's pre-approved OAuth clients to skip app reviews
  ([Pipedream](https://pipedream.com/blog/lindy/)). **Relevance AI**: its own integrations plus Pipedream Connect for
  2,000+ more ([docs](https://relevanceai.com/docs/integrations/introduction)). **Viktor**: 27 native integrations plus
  3,200+ through a managed connector *[vendor not named]* ([site](https://getviktor.com/integrations)).

The pattern across all of them: a handful of native, owned integrations for the core of the product, and a connector
platform for breadth.

## 3. The options

### A. Each platform's own OAuth, built by us

Allevia's OAuth app per provider, our token store, our API clients. We already have this for Search Console (signed,
single-use `state`; AES-256-GCM sealed file per business and connector; System node in the graph holds status, never a
token; daily pull; reconnect in words; `docs/connectors-setup.md`).

- **Coverage:** anything with an API, one provider at a time. Each one costs about 1.5 to 2 days of code
  (`docs/onboarding-trials.md`), plus upkeep when the provider changes.
- **Cost:** $0 per business. Engineering time, and the app reviews below.
- **Who owns the apps and reviews:** us. Our name on every consent screen, our verified domain, our privacy policy.
- **Tokens and isolation:** ours, per tenant, already built (`TokenStore`, `FileTokenStore`).
- **Self-host / licence:** all ours.
- **Fit:** best for the few platforms the growth plan is measured on. Too slow for 20 more CRMs and shops.

### B. Connector platforms

| | Composio | Nango | Pipedream Connect | Merge Agent Handler | Paragon | Arcade |
|---|---|---|---|---|---|---|
| Pricing | Hobby $0: 100K tool calls a month; Pro $29 a month + $0.0003 a call over 100K; connected accounts free on your own apps; managed apps: first 1K accounts free, then $0.10 each and $0.0005 a call ([pricing](https://composio.dev/pricing)) | Free: 10 connections; $50 a month incl. $50 credit, $0.29 per connection a month, $0.72 per compute hour ([pricing](https://www.nango.dev/pricing)) | Free only in development; $99 a month (annual) with 100 users, then $2 per user a month and $0.012 a credit ([pricing](https://pipedream.com/pricing?plan=Connect)) | Free 2,000 credits; Pro $1,000 a month ([pricing](https://www.merge.dev/pricing/agent-handler)) | Not published; reported five figures a year *[third party]* | Free 2,000 auths and calls; $25 a month + $0.10 an auth + $0.01 a call ([pricing](https://www.arcade.dev/pricing)) |
| Your own OAuth app | Yes ("auth configs"); recommended for production ([docs](https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app)) | Yes, the normal model | Yes; their shared clients work in production for prebuilt tools ([docs](https://pipedream.com/docs/connect/managed-auth/oauth-clients)) | Not stated | Not stated | Yes; required for some providers |
| Their shared app in production | Yes, but "Composio" shows on the consent screen and quota is shared | No | Yes | n/a | n/a | Some providers |
| Self-host, licence | No self-host; SDK licence to check | Elastic License; free self-host covers auth and proxy only ([docs](https://www.nango.dev/docs/guides/platform/self-hosting)) | No; Workday agreed to buy Pipedream (Nov 2025) ([Workday](https://newsroom.workday.com/ (press release, 19 Nov 2025))) | Enterprise on-prem | Enterprise | Framework MIT; enterprise VPC |
| TypeScript and Claude Agent SDK | `@composio/core` + `@composio/claude-agent-sdk` (tools as an in-process MCP server) ([docs](https://docs.composio.dev/docs/providers/claude-agent-sdk.md)) | Node SDK + proxy; MCP on cloud | SDK, MCP, proxy | MCP | API | MCP, Python-first |
| Token security | SOC 2 Type II, AES-256-GCM, projects isolated ([docs](https://docs.composio.dev/docs/security/overview)) | SOC 2 Type II | SOC 2 Type II | SOC 2 | SOC 2 Type II | SOC 2 Type II |

### C. MCP servers per platform

Official remote MCP servers that a SaaS can use per customer today: **HubSpot** (generally available April 2026; we
register an "MCP connector" and each business authorises its own account,
[docs](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server)),
**Stripe** (`mcp.stripe.com`, OAuth per account), **Slack** (needs a Marketplace-listed app), **Meta Ads**
(open beta, built for chat clients; per-customer use by a SaaS *[unverified]*). Google has none for GA4, Search Console
or Business Profile (Workspace MCP is a preview), and Shopify has none for the merchant admin. So MCP covers three of our
fifteen targets, each with its own auth story. Worth using where it exists (the provider maintains the tools), but it
is not a strategy on its own.

### D. Zapier and Make

Zapier MCP counts two tasks per tool call *[third party]*; self-serve plans give hundreds of tasks a month, and each
business would need its own Zapier account. Make's white-label is a sales-led OEM deal. Both are built for a person
automating their own work, not for a SaaS holding many businesses' accounts. Not a fit, except as "we work with your
Zapier" for an owner who already has one.

### Coverage

Y confirmed, P partial (sign-in or proxy only, or few actions), ? not confirmed, N no.

| Platform | Own OAuth | Composio | Nango | Pipedream | Merge AH | Arcade | Official MCP | Zapier |
|---|---|---|---|---|---|---|---|---|
| GA4 | Y | Y | Y | Y | ? | N | N | Y |
| Search Console | Y (built) | Y | P | Y | ? | N | N | Y |
| Business Profile, reviews | Y (needs Google's approval) | ? | ? | Y (reply to review) | ? | N | N | Y |
| Gmail | Y (reading needs CASA) | Y | Y | Y | ? | Y | preview | Y |
| Calendar | Y | Y | Y | Y | ? | Y | preview | Y |
| Instagram | Y (Meta review) | Y (32 tools) | P | ? | ? | N | N | Y |
| Facebook Pages | Y | Y (45) | Y | Y | ? | N | N | Y |
| Meta Ads | Y | Y (70) | ? | ? | ? | N | beta | Y |
| WhatsApp Business | Y (Tech Provider) | Y | P | P | ? | N | ? | Y |
| Shopify | Y | Y (315) | Y | Y | ? | N | N (merchant admin) | Y |
| HubSpot | Y | Y | Y | Y | Y | Y | Y | Y |
| Pipedrive, Zoho | Y | Y | Y / ? | Y | ? | N / P | N | Y |
| GoHighLevel | Y | ? | Y | Y | ? | N | N | Y |
| Stripe | Y (Stripe App) | Y (428) | Y | Y | ? | Y | Y | Y |
| Slack | Y | Y | Y | Y | Y | Y | Y (listed apps) | Y |
| Discord | Y (our bot) | Y | ? | Y | ? | Y | N | Y |

Sources: the vendors' toolkit pages, collected for this issue; Composio's Business Profile and GoHighLevel toolkits
could not be found.

### Cost at 10, 100 and 1,000 businesses

Assumptions: about 6 connections a business (60, 600, 6,000 accounts) and about 2,000 tool calls a business a month
(20K, 200K, 2M). List prices; per-call costs scale in a straight line.

| Option | 10 | 100 | 1,000 |
|---|---|---|---|
| A. Own OAuth (8 core platforms) | $0 | $0 | $0 (server and engineering only) |
| Composio on our own OAuth apps | $0 | about $30 a month | about $570 a month |
| Composio on its managed apps | $0 | about $90 | about $1,000 + account fees *[the $0.10 may be one-off or monthly]* |
| Nango cloud | $50 | about $175 + compute | about $1,740 + compute |
| Nango self-hosted (auth and proxy) | server only | server only | server only (tools are ours to write) |
| Pipedream Connect | about $220 | about $2,400 | about $25,800 |
| Arcade | about $225 | about $2,000 | about $20,000 |
| Merge Agent Handler | $1,000 | Pro or Enterprise | Enterprise |
| Gmail inbox reading (any option) | CASA audit about $540 to $6,000 a year ([providers](https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option)) | same | same |

At 1,000 businesses on Growth ($449), revenue is about $449K a month; the recommended mix costs under $1,000 a month,
about 0.2%.

## 4. Who has to approve what (the slow part)

These, not the vendor, decide when a connection can go live for customers. File them first.

| Provider | What is needed | How long |
|---|---|---|
| Google, sensitive scopes (`webmasters.readonly`, `analytics.readonly`, `calendar.readonly`, `gmail.send`) | OAuth consent screen "In production", verified domain, privacy policy with Limited Use wording, a short demo video; until verified, a warning screen and 100 users, and in Testing refresh tokens expire after 7 days ([Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)) | 3 to 10 working days |
| Gmail reading (`gmail.readonly`, restricted) | All of the above plus a CASA Tier 2 security assessment, every 12 months ([Google](https://support.google.com/cloud/answer/13463816?hl=en)) | 4 to 8 weeks; $540 to $6,000 a year |
| Business Profile API | Access request form; quota is 0 until approved, then 300 a minute; the applicant must manage a profile verified and active for 60+ days with a website ([Google](https://developers.google.com/my-business/content/prereqs)) | Days to weeks |
| Meta (Instagram, Pages, Ads) | Business Verification of our company, App Review per permission (`instagram_business_basic`, `instagram_business_manage_insights`, `pages_read_engagement`, `ads_read`), screencasts; serving other businesses means Advanced (now "Full") access ([Meta](https://developers.facebook.com/docs/instagram-platform/app-review)) | 2 to 4 weeks |
| WhatsApp Cloud API | Tech Provider onboarding: business verification, App Review with two videos, `whatsapp_business_management`; customers join through Embedded Signup v4 (v2 retired 15 October 2026) ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)) | Weeks |
| Shopify | A public app from the Dev Dashboard, protected customer data request, App Store review if listed ([Shopify](https://shopify.dev/docs/apps/launch/protected-customer-data)) | Weeks |
| HubSpot | Unlisted apps are capped at 25 installs; Marketplace listing is reviewed by hand ([HubSpot](https://developers.hubspot.com/changelog/new-marketplace-distribution-app-install-limits)) | Weeks |
| Stripe | A Stripe App for access to existing accounts ([Stripe](https://docs.stripe.com/connect/oauth-changes-for-standard-platforms)) | Review *[unverified length]* |
| Slack | Unlisted apps work, but message history is limited to 1 request a minute; listing needs 5 active workspaces ([Slack](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps)) | Weeks |
| Discord | Our bot: verification at 100 servers ([Discord](https://discord.com/blog/the-future-of-bots-on-discord)); the hub model keeps us on one server | Not needed yet |

## 5. Recommendation

**Own OAuth for the eight core platforms; Composio, on our own OAuth apps, for the long tail; one `Connector`
interface over both.**

Why this and not one platform for everything:

1. **The growth plan is measured on Google and Meta numbers.** Those connections are the product. They must show
   Allevia on the consent screen, keep working if a vendor changes its prices, and pass Google's and Meta's reviews in
   our name (which we need anyway for the site's privacy and data-deletion pages). We already have the pattern and most
   of the code for Google.
2. **Composio is the cheapest and widest way to the long tail**: free to start, about $570 a month at 1,000 businesses on
   our own apps, a first-party Claude Agent SDK adapter, SOC 2 Type II, and the widest coverage of our list (Shopify,
   HubSpot, Pipedrive, Zoho, Stripe, Slack, Instagram, Pages, Ads). Kylon, the product the founder admires, made the same
   choice.
3. **No lock-in where it matters.** Tokens for the core live in our store. Composio sits behind our interface; if its
   price or terms change, the long tail moves to self-hosted Nango (Elastic License, free for auth and proxy) without
   touching an agent.
4. **Not Pipedream or Arcade**: 40 times the cost at 1,000 businesses, and Pipedream is changing owner. **Not Merge or
   Paragon**: priced for enterprise. **Not Zapier or Make**: built for one person's automations. **MCP**: use HubSpot's
   and Stripe's official servers through the same interface when we reach them, not as the plan.

### How it plugs into Allevia

```
web Connections page ─┐                       ┌─ own: GoogleConnector (GSC, GA4, GBP, Calendar, gmail.send)
Discord /connect ─────┼─> Connector registry ─┤        MetaConnector (Instagram, Pages, Ads, WhatsApp)
agent setup card ─────┘   (one per business)  └─ rented: ComposioConnector (Shopify, HubSpot, Stripe, Slack, ...)
                                │
             TokenStore (own) / Composio connected-account id (rented); never the graph
                                │
       daily pull ─> Observations (live, src=connector) ─> capability ladder ─> goals, detectors, Today's note
       agent tools (read, free) ─────────────────────────> toolkits in shared/toolkits.ts
       agent writes (send, post, reply, pause) ─> propose_action ─> "Waiting for your OK" ─> executor (dry run until live)
```

- **One interface** (`src/connectors/registry.ts`, new): `status(tenant)`, `connectUrl(tenant, intent)`,
  `handleCallback`, `pull(tenant, since)`, `disconnect`, `tools()` and `execute(tenant, tool, args)`. Google's
  Search Console code becomes the first implementation; nothing about its behaviour changes.
- **Tokens.** Own connectors keep the sealed-file `TokenStore` (AES-256-GCM, key derived from `ALLEVIA_CONNECTOR_KEY`
  and the tenant slug, so a file copied to another business does not open). Before paying customers: the same records in
  a database table with envelope encryption (a data key per business, wrapped by a KMS key), so a stolen disk or backup
  is useless and a business can be crypto-shredded on deletion. Composio holds the long-tail tokens; we store only the
  connected-account id, sealed the same way.
- **Per-tenant isolation.** The server binds a request to one business (as now); the Composio `user_id` is an opaque id
  per business (not the slug, not an email), set by the server, never by a model; every `execute` checks the
  connected account belongs to that business before the call; no tool takes a tenant or account argument (the same rule
  as the graph tools). A test in `tests/security/` proves a tool call for business A cannot reach B's account.
- **The graph** gets a `System` node per connection (status, which account or property, connected by whom, why, last
  read, last error), `DEPENDS_ON` edges from the capabilities that read it, and the numbers as `Observation`s with
  `src` the connector. Never a token, never a refresh token, never a Composio key (`privacy-scan` already looks for
  credentials).
- **Capability ladder** (`src/capabilities/ladder.ts`, `modes.ts`): no change to the rungs. A connected, fresh source is
  `api`; an expired one is `down` and drops a rung, with the existing "Reconnect it" words. New capability keys
  (`email`, `calendar`, `facebook`, `whatsapp`, `shop`, `crm`, `payments`) are added to `CAPABILITY_KEYS` with their
  `systems` and `observes`. Their `CONNECT` hints become "Connect Shopify to count your orders" and are what the
  Connections page and the agent's setup card say.
- **Toolkits** (`shared/toolkits.ts`): connected tools get the same tags. Reads are `mode: "read"`, `cost: "free"`,
  `needsOk: false` (shop orders, CRM deals, GA4 report). Anything that sends, posts, replies or changes is
  `needsOk: true` and goes through `propose_action`: a draft the owner approves, then an executor that is a dry run
  until `ALLEVIA_ACTIONS_LIVE=1`. A delivery whose result is uncertain is parked for a person, never retried blindly
  (Kylon's rule, worth copying). New toolkits: `shop`, `crm`, `inbox`, `calendar`, `social-publish`; Composio's tool
  schemas are wrapped, not exposed raw, so each agent sees a few named tools, not 315 Shopify endpoints.
- **Asking for a connection.** When an answer would be better with a connection, the agent calls
  `propose_connection` (new, `needsOk: true`) with the provider and a reason; the owner sees a card with the reason and a
  Connect button. The reason is stored on the System node, as Kylon records a connection intent.

## 6. Phased plan

### Phase 0: hackathon demo (now to 18 October), $0

Goal: one live connection the judges see working, end to end, on a real business.

1. **Search Console and GA4 live for Aamdani or AVS Atelier** on our own Google client in **Testing** mode (the founder
   and the businesses' accounts as test users; the 7-day token expiry does not matter for a demo). Turn on
   `ALLEVIA_SEARCH_CONSOLE=1`, connect, pull, and show a goal move from "We'll know after your first full week" to a
   real number with "where you started". Add `analytics.readonly` and a GA4 pull on the same client (about a day).
2. **Instagram through Composio's free tier** (managed app; the consent screen says Composio, acceptable for a demo of
   the founder's own business): connect AVS Atelier's Instagram, pull reach and followers into Observations, and the
   `instagram_insights` capability reads `api`. *[Check before relying on it: Composio's managed Instagram app works for
   an account outside a Meta test role.]*
3. **The Connections page and `/connect` in Discord**, showing all platforms with the two that work live, the rest
   "coming soon" or "we can read your public profile meanwhile".
4. Do **not** build Gmail, WhatsApp or any write action for the demo.

### Phase 1: first paying customers (the next 4 to 6 weeks)

1. File every review in section 4 in week 1 (they run in parallel with the build).
2. Google: verification for `webmasters.readonly`, `analytics.readonly`, `calendar.readonly`, `gmail.send`; Business
   Profile API access request. Build GBP (calls, directions, reviews; reply to a review as a draft with OK).
3. Meta: business verification, App Review for Instagram insights and Pages; build `MetaConnector` on our own app; move
   Instagram off Composio's managed app.
4. Composio Pro ($29) with our own auth configs for Shopify, HubSpot and Stripe (the three that feed the orders,
   enquiries and revenue goals); `crm`, `shop` and `payments` capabilities.
5. Token table with per-business data keys; isolation tests; the trust page lists Composio and Google's Limited Use
   wording.

### Phase 2: scale (after 25 to 50 customers)

WhatsApp Business as Tech Provider (Embedded Signup v4), Gmail reading after a CASA audit when revenue justifies it,
Meta Ads read and pause, Slack and Teams as surfaces, HubSpot and Stripe official MCP servers where they beat the
Composio toolkits, Marketplace listings (HubSpot past 25 installs, Shopify App Store), and the Nango exit path tested once.

## 7. What the founder does, step by step

**This week (each step takes under an hour of your time; the waiting is the provider's):**

1. **Google Cloud** (`docs/connectors-setup.md` has the click path): project `Allevia`, enable Search Console API,
   Google Analytics Data API, Business Profile APIs and Calendar API; consent screen External with the privacy and terms
   URLs; add yourself and the Aamdani and AVS Google accounts as test users; create the Web OAuth client with the
   callback URL; put the client id and secret and `ALLEVIA_CONNECTOR_KEY` in `~/.config/allevia/allevia.env`.
2. **Publish the site's privacy, terms and data-deletion pages** on the real domain and verify the domain in Google
   Search Console (Google and Meta both need the URLs to resolve).
3. **Business Profile API access form**, from the Google account that manages AVS Atelier's or Aamdani's profile
   (it must have been verified for 60+ days and list a website).
4. **Composio**: sign up (free Hobby plan), create a project `allevia`, copy the API key into the env file. Nothing
   else for now.
5. **Meta**: a Meta Business portfolio for the Indian company, then **Business Verification** (company documents,
   domain, phone); a developer app of type Business with Instagram (Instagram Login) and Facebook Login for Business.

**Weeks 2 to 4:**

6. Submit Google verification for the sensitive scopes with a 2-minute screen recording of Connect, consent and the
   numbers appearing (we script it and record it with you).
7. Meta App Review for `instagram_business_basic`, `instagram_business_manage_insights`, `pages_show_list`,
   `pages_read_engagement`, with a screencast per permission (we script these too).
8. Shopify Partner account and a public app in the Dev Dashboard; HubSpot developer account and an app; a Stripe App.
   Each app's client id and secret go into a Composio auth config, so the consent screens say Allevia.

**Later:** Meta Tech Provider onboarding for WhatsApp; a CASA Tier 2 assessment if we read inboxes.

## 8. The Connections page, in owner words

Title: **Your accounts**. Subtitle: *Your team works better with your real numbers. Connect what you use; you can
disconnect any time.*

```
Your accounts
Your team works better with your real numbers. Connect what you use; you can disconnect any time.

  Working now
  [G] Google Search         Connected · we read it this morning              Manage
      Shows the searches that bring people to your site.

  Your team asked for these
  [ig] Instagram            Not connected                                    Connect
      Tara needs this to see which posts bring you enquiries.
      Meanwhile: we're reading your public profile only.
  [G] Google Business Profile   Not connected                                Connect
      To read calls, directions and your new reviews, and draft replies.

  More you can connect
  Website visits (Google Analytics) · Your shop (Shopify) · Your customer list (HubSpot, Pipedrive, Zoho)
  · Payments (Stripe) · Email (Gmail) · Calendar · WhatsApp (soon)

  Built in, nothing to connect
  Your website · public reviews and listings · competitors' public posts and ads · web research

  No account? Add your numbers from a spreadsheet instead.
```

Rules: one line per account, three states only ("Connected · when we last read it", "Not connected", "Needs you:
connect again"); each row says what the team does with it, in the owner's words, and who asked (the person's name);
"Manage" opens: what we read, what we never do ("we never post or send without your OK"), who connected it and when,
Disconnect. Nothing about scopes, tokens or APIs on the page; those sit behind "Show how this works".

When something breaks, Today's note says it once: *"Google stopped letting us read your searches. Connect it again
(1 minute)."*

## 9. Discord `/connect`

The hub bot (`src/discord/client.ts`) gains `/connect` with an optional `account` choice (Google Search, Website visits,
Business Profile, Instagram, Shopify, CRM, Stripe, ...).

1. `/connect` with no choice: an ephemeral message (only the owner sees it) listing the same three groups as the page,
   with a button per account.
2. `/connect instagram` or a button: the bot replies, only to that person:
   *"Connect Instagram so Tara can see which posts bring you enquiries. This link is just for you and works once, for
   10 minutes."* with a **Connect Instagram** link button.
   The link is our own short URL (`/c/<one-time code>`), which redirects to the provider's consent page; the code is
   signed, names the business, expires in 10 minutes and works once (the existing `state` rules). The bot only shows it
   to a member the hub knows is that business's owner, never in a shared channel.
3. The owner approves on Instagram's page and lands on a small "Connected. You can close this tab" page.
4. The bot posts in the business's thread: *"Instagram is connected. Tara is reading your last 90 days now; I'll tell
   you what she finds in tomorrow's note."* The capability moves to "live" and the first pull starts.
5. An agent can start the same flow: when Tara needs Instagram, she proposes a connection, and the card in Discord has
   the Connect button and her reason.

`/connect status` lists each account with its state; `/disconnect <account>` asks "Disconnect Instagram? The numbers we
already read stay." with Yes and No buttons.

## Open questions for the founder

1. Is a Composio-branded consent screen acceptable for the hackathon demo, or should Instagram wait for our own Meta
   app (weeks)?
2. Which entity and domain go on the Google and Meta apps (the Indian company, the Allevia domain)?
3. Gmail: sending drafts only (no audit) for the first customers, and reading inboxes later? This design assumes yes.

# Connections: what the founder sets up

2026-10-16, issue #40. Design: `docs/connections-design.md`. This page lists exactly what to create and what to put in
`~/.config/allevia/allevia.env` (mode 600; never in the repo, never in chat). Nothing here needs code.

**How it works now.** Composio is the main path. One integration gives a business Gmail, Calendar, Search Console, Instagram,
Facebook, Meta Ads, WhatsApp, Shopify, Stripe, HubSpot, Calendly, Mailchimp, LinkedIn, Slack, Zoho, TikTok, QuickBooks, Xero,
Sheets and the rest of Composio's catalogue (any toolkit, found from the search box). Each toolkit has Composio-managed
sign-in, so **no app of ours needs to be created or reviewed to start**. Our own Google app stays in the code for branded
consent later, and it is needed today for two things Composio cannot do (below).

## 1. Composio (about 5 minutes)

1. Sign in to Composio and open the project `allevia`.
2. **API keys: make a key with full access.** The key in the env file today is a restricted key: on 16 October it could list
   toolkits and connections but Composio refused `POST /auth_configs`, `POST /connected_accounts/link` and
   `POST /tools/execute/...` with "this key has read access". Create a new key that allows **write on auth configs, connected
   accounts and tool execution** (the "all access" choice does), and replace `COMPOSIO_API_KEY` in the env file with it.
   Until then nothing can be connected or run through Composio; the app says "isn't switched on yet" and names this setting.
3. Nothing else. Auth configs (Composio-managed OAuth) are created by the server the first time a business connects a tool.
   The consent screens a business sees say "Composio". Our own branded screens come later, per tool, from our own apps.
4. Check the tool names we use exist: `npm run cli -- connect toolkits` (all 21 existed on 16 October).

**Per business, never shared.** Every business gets its own Composio user id (a keyed hash of its slug, `al_` plus 24 hex
characters; not the slug, not an email). Allevia stores only the connected-account id, sealed. Every call re-checks the
account belongs to that business.

## 2. The settings

| Setting | Needed for | Notes |
|---|---|---|
| `ALLEVIA_CONNECTOR_KEY` | Everything | 32+ random characters. It locks every stored connection and signs the sign-in links. **Already set on this Mac** (generated 16 October). Keep a copy somewhere safe: without it stored connections cannot be opened. |
| `ALLEVIA_CONNECTOR_KEY_PREVIOUS` | Rotating the key | Comma-separated old keys. Put the old key here, set the new one in `ALLEVIA_CONNECTOR_KEY`, run `npm run cli -- connect rotate-keys`, then delete the old key. |
| `COMPOSIO_API_KEY` | Composio path | A key with write access (step 1.2). |
| `ALLEVIA_WEB_URL` | Sign-in return, posting pictures | The address the owner's browser reaches Allevia at (default `http://127.0.0.1:<port>`). Composio and Google send the owner back to `<ALLEVIA_WEB_URL>/api/connectors/google/callback`. **For posting it must be an address the internet can reach**: Instagram and Facebook fetch each picture from `<ALLEVIA_WEB_URL>/m/<signed address>`; a local address makes a post fail, plainly, before anything is sent. |
| `ALLEVIA_PUBLISH_PER_DAY` | Posting | Posts a business may make in 24 hours, all platforms together (default 10). Past it, a post is held back with a plain line and a Try again button. |
| `ALLEVIA_PUBLISH_SCHEDULE=0` | Posting | Switches off the half-minute clock that posts scheduled posts (default on; never in public mode). |
| `ALLEVIA_ACTIONS_LIVE=1` | Real sends | Until it is 1, an approved email, meeting or change is a **dry run**: the card says what would have happened and nothing leaves. Turn it on only when you have watched a few dry runs. |
| `ALLEVIA_GOOGLE_VIA` | Optional | `composio` or `own` forces every Google product one way. Default: Composio for Gmail, Calendar and Search Console, and our own app for Analytics and Ads when it is set up. |
| `ALLEVIA_GOOGLE_CLIENT_ID`, `ALLEVIA_GOOGLE_CLIENT_SECRET`, `ALLEVIA_GOOGLE_REDIRECT_URI` | Our own Google app | Section 3. |
| `ALLEVIA_GOOGLE_ADS_DEVELOPER_TOKEN`, `ALLEVIA_GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `ALLEVIA_GOOGLE_ADS_API_VERSION` | Google Ads numbers | Section 3. |
| `ALLEVIA_GMAIL_READ=1` | Reading inboxes | Only after Google's restricted-scope review (section 3). Off: Gmail is send-only. |
| `ALLEVIA_SEARCH_CONSOLE=0` | Old switch | Search Console used to be parked behind `=1`. It is on now; `=0` switches the old route off. |

`npm run cli -- connect status [<tenant>]` prints what is still missing and how each connection stands.

## 3. Our own Google app (only for what Composio cannot do, and for branded consent)

**What Composio cannot do (checked against its catalogue on 16 October).** Its Google Analytics toolkit has four actions (list
accounts, get account, list audiences, create data set): **no report, so no visits, sources or conversions**. Its Google Ads
toolkit has five (campaign lookups and customer lists): **no spend, clicks or conversions report**. Daily numbers for those two
need our own Google app. Everything else Google (Gmail, Calendar, Search Console) works on Composio.

1. **Google Cloud project** named `Allevia` (any organisation, or none).
2. **Enable APIs:** Google Analytics Data API, Google Analytics Admin API, Google Ads API, Google Calendar API, Gmail API,
   Google Search Console API.
3. **OAuth consent screen:** External. App name `Allevia`, support and developer emails, the home page, **privacy policy** and
   terms links (the policy must carry Google's Limited Use wording), authorised domain.
4. **Scopes** (each connection asks only for its own, never all at once):

   | Product | Scopes | Google's class | Verification |
   |---|---|---|---|
   | Sign-in identity | `openid`, `email` | non-sensitive | none |
   | Calendar | `calendar.freebusy`, `calendar.events` | sensitive | verification, demo video |
   | Gmail (send) | `gmail.send` | sensitive | verification, demo video |
   | Gmail (read inbox, opt-in) | `gmail.readonly` | **restricted** | verification **and** a CASA security assessment (about 4 to 8 weeks, $540 to $6,000 a year) |
   | Analytics | `analytics.readonly` | sensitive | verification |
   | Search Console | `webmasters.readonly` | sensitive | verification |
   | Google Ads | `adwords` | sensitive | verification, **and** an Ads developer token (below) |

   Until verified, an app in production shows "Google hasn't verified this app" and is capped at 100 users. In **Testing**
   mode only listed test users can sign in and refresh tokens **expire after 7 days**: fine for a demo, not for customers.
   Publish to production and start verification early (it takes days to weeks).
5. **OAuth client:** type Web application, name `Allevia web`. Authorised redirect URI exactly
   `<ALLEVIA_WEB_URL>/api/connectors/google/callback` (add `http://localhost:8787/api/connectors/google/callback` to try it on
   this Mac). Put the id and secret in the env file. `npm run cli -- connect status` prints the address this server uses.
6. **Google Ads developer token:** in a Google Ads manager account, API Center, apply for a developer token. Test accounts work
   with the "test" level at once; real customers' accounts need **Basic access**, which Google reviews (days to weeks).
   Set `ALLEVIA_GOOGLE_ADS_DEVELOPER_TOKEN`; if the manager account is the login account set `ALLEVIA_GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
   The Ads API version is `v23` unless `ALLEVIA_GOOGLE_ADS_API_VERSION` says otherwise (Google retires old versions; check the
   current one).

## 4. What a business sees and can do

- **Your tools** page (web) and **Connect your tools** step in setting up a business: logos, one line per tool, "Read only" or
  "Read and act", and a working Disconnect. Discord: `/connect` lists them with one-time links only the owner sees (10 minutes,
  once). The page promises: no posting, sending, spending or booking without the owner's OK; data stays in the business's own space.
- Agents see which tools a business has connected at the start of each turn. A tool they need that is not connected makes them
  say so and give the owner a "Connect <tool>" link. Reads run at once; anything that sends, posts, books, spends or pauses is a
  card in **Approvals** and in Discord's **#approvals** with the full content, and only the OK runs it (a dry run until
  `ALLEVIA_ACTIONS_LIVE=1`).
- Every call is in the business's own audit log (`npm run cli -- connect audit <tenant>`, or Your tools' audit), without secrets.
  Calls are limited to 30 a minute and 2,000 a day per business and tool. `npm run cli -- connect revoke <tenant>` disconnects
  everything a business has and forgets what is stored.

## 4b. Posting to the owner's own accounts (issue #20)

When the business has Instagram, a Facebook Page or LinkedIn connected (through Composio's managed login), what the team makes for
that channel becomes a **post card** instead of a draft card: **"Post to Instagram (your account @cafe)"**, with the picture
options, the exact words, when it goes, and Approve, Change and No thanks. Without the connection the card stays a draft and says
how to connect. The owner can also ask for a post in words ("put the new menu on our Page at 7 on Tuesday"): the team proposes it
with `publish_post`, and `publish_status` and `publish_cancel` list and cancel what is scheduled.

- **What approving does.** It posts, or sets it for the time given (in the business's own time zone, cancellable until then). The OK
  is on that exact content: the platform, the account, the words, the one picture or video and the time are hashed when the OK is
  given and checked again at the moment of posting; a post that changed since is never sent. Every post waits for the owner at every
  autonomy level: nothing here posts by itself, and "always ask before posting" is a standing instruction the owner can give.
- **Dry run.** Until `ALLEVIA_ACTIONS_LIVE=1`, the card says it **would have posted** and nothing leaves (not even a look at the
  account). A scheduled post whose time comes in a dry run says so and posts nothing.
- **The actions used** (read from Composio's own tool lists on 16 October 2026; `npm run cli -- connect publish-check` asks again,
  read only, and says which action or argument has gone missing; the executor checks the same list before every post):
  Instagram `INSTAGRAM_GET_USER_INFO`, `INSTAGRAM_CREATE_MEDIA_CONTAINER`, `INSTAGRAM_GET_POST_STATUS`, `INSTAGRAM_CREATE_POST`,
  `INSTAGRAM_GET_USER_MEDIA`; Facebook `FACEBOOK_GET_USER_PAGES`, `FACEBOOK_CREATE_PHOTO_POST`, `FACEBOOK_CREATE_VIDEO_POST`,
  `FACEBOOK_CREATE_POST`; LinkedIn `LINKEDIN_GET_MY_INFO`, `LINKEDIN_CREATE_LINKED_IN_POST` (**text only**: the toolkit has no
  picture upload, and the card says so).
- **Pictures.** Neither Instagram nor Facebook takes an upload through Composio: each fetches a public address. The server serves one
  picture of one business at `/m/<token>`, signed with the connector key and valid for an hour; a PNG is served as a JPEG for
  Instagram. Instagram feed pictures must be 4:5 to 1.91:1 (a Story shape is refused on the card); a reel is a 9:16 video.
- **When it goes wrong** the owner reads a plain sentence (what Instagram said, in words; or "stopped letting us in, connect it
  again") and taps **Try again** (web, or Discord's button). A post that **may** have gone out (the line dropped on the last step)
  is never repeated by itself: the owner is asked to look first, and Instagram's retry carries on with the same container, so a
  second post cannot be made. A crash half way is treated the same way.
- **Where it is recorded.** A `Content` node per post (platform, account, words, picture, time, status scheduled, publishing,
  published, failed or cancelled, the post's address and time), `PUBLISHED_ON` the channel, `USES_ASSET` the picture, `RESULTED_IN` from
  the card's Action. The card shows the result on the web (Home, Approvals, "Your posts") and in Discord (the closed card, plus a
  note when a scheduled post goes out or fails).

## 5. Not yet proven against the live services

Everything is built and tested against fakes. Against the real services only these were checked: the toolkit names, the
tool names and their argument lists for Calendar and Gmail (read from Composio's published schemas), that a restricted key is
refused, and the posting actions and arguments for Instagram, Facebook and LinkedIn (`connect publish-check`, against Composio's own
tool lists; **no post was made**). **Never run live yet:** the connect link, the callback, tool execution, and the response shapes the first reads parse
(Search Console rows, Instagram followers, Stripe balance, Shopify orders, Calendar events, Gmail profile), and what a **real post**
returns on each platform (the account lookups, the container and post ids, the post's address, LinkedIn's id), which the posting code
reads by name and tolerates missing (a post with no address still counts as posted, and says so). The first connection of
each tool may need a small fix. The proof script does the first one for you:

```
npx tsx scripts/connections-proof.ts demo_growth
```

It prints a Google Calendar connect link for that business, waits for you to open it once, then reads free times and proposes a
booking as an approval card. **It sends and books nothing.**

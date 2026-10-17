# Allevia: Founder OS

This page restates what we are building and for whom, where it stands today, and the order we build the rest in. It is
the founder's direction from 16 October 2026. It supersedes older plans where they disagree, and `docs/owner-words.md`
still governs every word an owner reads.

## Who it is for

A founder whose business already works: it has customers, revenue and a reputation (0 to 1 is done). They want the next
leap (1 to 100) and lack the time and the know-how for marketing, numbers, a better website, sales follow-ups and the
rest. They are not marketers or engineers. They read Allevia on a phone between jobs.

Markets: the US, UK, UAE and Australia first. The business is run from India. Pricing is in USD.

## What it is

**One place where a founder runs the business with an AI team.**

- **One brain.** Each business has its own company brain: a FalkorDB graph of everything the team learns from the
  website, the founder's connected tools, uploads and conversations. Every fact keeps its source and its date. Nothing
  is shared between businesses.
- **One team.** Twelve AI staff, each in a department, each with their own tools and skills. They plan together, check
  each other's work, and remember.
- **One place to work.** The founder asks anything (chat or Discord), sees what is waiting for OK, connects their tools,
  and watches the team in the office.
- **The founder's own tools.** Their tools become the team's hands: Google Ads, Gmail, Calendar, Search Console,
  Analytics, Business Profile, Instagram, WhatsApp, Shopify and their CRM. For example, Sales books a call with a
  client on the founder's calendar and drafts the follow-up email.
- **The founder steers.** Anything that spends money, goes public or contacts someone waits for the founder's OK.
  Each person can be given more autonomy over time.

## The jobs it does, with the department behind each

| The founder's need | Who | What they do, using which connection |
|---|---|---|
| "Why did X drop? What should we do?" | Meera, Kabir, Zoya, Imran, Arjun, Sara | Trace it through the brain (the hero use case) and draft the fix |
| More customers from search and maps | Rohan, Kabir, Arjun | Website check-up, Search Console, Business Profile; drafted fixes and replies to reviews |
| Better ads for the same money | Rohan | Google Ads and Meta Ads, read first; budget changes as cards for OK |
| Posts, posters and reels that sell | Tara, Dev, Nisha | Brand library, Studio, Instagram; drafts for OK, scheduled after OK |
| Follow up every lead and book the call | **Sales (new)** | Gmail and Calendar: reply to new enquiries, propose times, book the meeting, send the reminder |
| Know the numbers every morning | Isha, Kabir | Analytics, uploads and Shopify or Stripe feed Today's note |
| Nothing falls through the cracks | Vikram | Tasks, follow-ups, invoices to chase, "waiting on you" |
| The app or site is broken | Zoya, Imran, Arjun | Error alerts, releases, uptime |

## Connections: the first set

We list the top connections and ask the founder to connect the ones they use. Each connection says in one line what the
team will do with it. Each is per business, encrypted, revocable, and read-only where read is enough.

1. Google: Gmail (send, and read when approved), Calendar, Search Console, Analytics (GA4), Business Profile, Google
   Ads.
2. Meta: Instagram, Facebook Page, Meta Ads, WhatsApp Business.
3. Commerce and money: Shopify, Stripe.
4. Customers: HubSpot (or Pipedrive or Zoho), with a spreadsheet as the fallback.
5. Team: Slack, Discord (the hub already works).

How: our own Google and Meta apps for the connections the growth plan is measured on, and a connector platform
(Composio) for the rest. The details and costs are in `docs/connections-design.md`.

## Where it stands (16 October 2026)

Working:

- the brain on FalkorDB Cloud;
- onboarding from a website (fixed today);
- chat with the team or one person;
- the living office;
- Discord hub;
- the hero use case (5/5 live);
- Today's note with the proactive stand-up;
- Studio and posters;
- posting to the owner's own Instagram, Facebook Page and LinkedIn after their OK (issue #20): a "Post to Instagram (your account
  @cafe)" card with the picture and words, now or at a time in the business's own time zone, cancellable, a dry run until
  `ALLEVIA_ACTIONS_LIVE=1`, a daily limit, a plain reason and a Try again when it fails. Built and tested on a fake Composio; the
  action names and arguments were checked against Composio's real tool lists, and **no real post has been made** (`docs/connections-setup.md`, 4b);
- the website check-up;
- the Apify public data;
- spreadsheet upload;
- tenant isolation;
- nightly backups;
- a Sales department (issue #41): Neel, the Sales Lead, reads new enquiries, drafts the reply with three real times from the
  calendar, books the call and sends the invite after the OK, reminds before it and follows up after it, nudges deals that
  went quiet, and adds new leads from the inbox. Leads, deals, meetings and messages are in the business's own brain with
  every stage change kept, so "what moved this week" is a question. Everything that goes out is a card waiting for the OK
  (`gmail_send`, `calendar_book`); the demo business `demo_growth` has a sample inbox and calendar, so the whole flow runs
  without a real customer. The stand-up includes Sales.

Missing for the Founder OS:

- connections beyond upload and Apify (the layer is built; each business still has to connect its tools);
- ~~one founder workspace that ties chat, waiting-for-OK, connections, the plan and the team together~~ (Home, #43; see
  "Home and Discord" below);
- an end-to-end check that every screen and flow works.

## Home and Discord

Home (`/`, web app) is what a busy founder reads in five seconds: a greeting and one status line ("3 things need you ·
Weekly signups up 18%"), the ask box, the living brain, "Needs your OK" as compact rows, one row of small tiles, and a "Set
up" chip row only while something is not set up. The office, the team and the tools have their own pages. The tiles are
data (`web/src/pages/home-cards.tsx`), so a new area (Sales, #41) adds one entry and the layout does not change. Nothing on
Home is web-only unless it is listed as a gap.

| On Home | What the owner does there | The same on Discord |
|---|---|---|
| Ask box | Types a question; the team's chat opens and the question is sent | `/ask`, or a message in the channel |
| Needs your OK | Up to three rows (what it is, who made it, how big) with OK, and Look, which opens the real content in a sheet (poster options and our pick, the email and who gets it, the meeting and when, the words of a post or a fix) with Approve, Change or No thanks | The same card, with the same content and the same three buttons (#approvals, and under Today's note) |
| Today's note tile | One line; a tap opens the full note on "What we noticed" | `/brief`, and the daily post |
| Goals tile | "2 of 3 going well" with a small bar per goal (week one says "First reading next week"); a tap opens the growth plan | Today's note carries the goals. **Gap:** saying OK to the suggested goals, or changing a number, is on the growth plan page only |
| Credits tile | Credits left this month; a tap opens Plan and credits | When credits run out, the same sentence with its two buttons as links to the plan page |
| Set up chips | Only while something is not set up: "OK your goals", "Connect Gmail" (or "Reconnect" a tool that stopped working); Connect opens the provider's page and returns to Home | `/connect` (a link only the owner sees) |

Check my website lives on the growth plan page (`/checkup` on Discord); the team strip lives in the office.

Deciding a draft from Home is the same call as the Approvals page and the Discord buttons (`POST /api/:t/approvals/:id`),
so an edit becomes a habit the team keeps on every door.

## Order of work

1. **Everything works as expected.** A full product audit: every page, flow and command, live, fixed until it holds.
   The five live scenarios pass.
2. **Founder OS.**
   - The connections framework and the Connections page plus `/connect`.
   - Google first: Calendar, Gmail send, Search Console, GA4, Ads read.
   - The Sales department.
   - Agents acting through connections, behind approvals.
   - One founder workspace.
3. **Hackathon deliverables.** The hero use case with the public twin, the README, the queries, the setup and the
   public repo.
4. **Then present it.** The website (v3, #37) and a launch video, once the product is what we envisioned.

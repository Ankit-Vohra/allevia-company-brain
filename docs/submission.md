# Hackathon submission (draft for the founder's OK)

Graph Hacks: Context for AI Agents (FalkorDB). Deadline 18 October 2026, 23:59 IST. The form was updated on 18 October;
every field below is in its order, ready to paste.

## Part 1: Project details

### Project title

Allevia: the company brain for founders, built on FalkorDB

### Description ("What problem does your project solve, and who is it for?")

Being a founder means holding the whole business in your head. Hundreds of things land on your plate every day, and
your inbox, analytics, ads and website don't talk to each other, so every "why" comes back to you. Allevia is for
founders of small, growing businesses. It turns the business into one company brain, a FalkorDB graph per business, and
gives the founder an AI team of 13 that works from it. Nothing goes out without the founder's OK.

**Why a graph:**
- **Every fact keeps its source and its date.** Facts that stop being true are closed, not deleted, so the brain
  remembers what changed and when.
- **Answers follow real links.** "Why did online orders drop this week?" walks from the orders to the checkout release
  and the UPI payment errors. The path is shown lit on the map.
- **Every team learns from the others.** Ads, content and website read the same brain: on Blue Tokai, the costliest ad
  campaign was sending people to a broken checkout, so the team proposed pausing it while content and website got their
  own next steps.
- **The brain is efficient.** On our own startup, an agent reading the graph used 8× fewer tokens than pasting the
  documents into a prompt (75k against 604k), and answered faster.

**What we built:**
- One graph per business, with provenance on every edge, and a shared reference graph for general know-how.
- 13 agents in departments that plan, check each other and remember.
- A live map of the brain, with "watch it grow".
- Approvals on the web and in Discord.
- Connections through Composio (over 1,600 tools in its catalogue): Gmail, Calendar, Analytics, Search Console and
  Instagram connected for real, plus public data from Apify.
- FalkorDB, self-hosted with nightly backups.

**The live demo has three businesses:**
- **Blue Tokai Coffee:** a known brand, with real public data and labelled sample numbers.
- **Aamdani:** our own startup; Allevia grew out of running it.
- **AVS Atelier:** an architecture and interiors studio.

### Track ("Select all applicable tracks")

Tick all three:
- [x] Company Brain (the closest fit: one graph per business that every agent reads first)
- [x] Agent Memory and Coordination (13 agents that plan, review each other and remember, with facts over time)
- [x] Agents That Act on Connected Data (agents act on connected tools, every action waits for the founder's OK)

### Repository

Today: https://github.com/Ankit-Vohra/allevia-company-brain (a clean export with a short history).
Founder's decision on 18 October: publish the full build history instead (over 800 commits from 15 October), once the
history audit is clean. See the audit report before switching.

### Demo video (public or unlisted YouTube link)

The demo is ready to upload (under the 3-minute limit), with a title, a description with chapters and a thumbnail in
`/Users/ankit/allevia-video/v2/upload/`. The founder uploads it, then the link goes here and in the form.

### Live demo or deployment

https://13-232-139-42.sslip.io

### How did you use FalkorDB in your project?

See `docs/submission-falkordb-answers.md`, answer 1 (ready to paste).

### Blog link

Draft: `docs/blog/allevia-company-brain-on-falkordb.md`. Where to publish is the founder's call:
- **Our website:** the page is built and checked locally (`site/proto/blog/`, desktop and phone). Publishing it is one run
  of the site's publish step, giving https://ankit-vohra.github.io/allevia-site/blog/.
- **The founder's own dev.to, Medium or Hashnode account:** paste the Markdown and upload the six images from
  `docs/blog/images/`.

## Part 2: Feedback

### What did you like about FalkorDB?

See `docs/submission-falkordb-answers.md`, answer 2.

### What improvements would you like to see in FalkorDB?

See `docs/submission-falkordb-answers.md`, answer 3.

# Pending — every open item, with an owner

Last edited 2026-10-09 by the lead agent. Owners: **founder** (needs the founder's own hands), **agent** (any agent can
take it), or a named agent. Setup items point at GitHub issues in `Acme-Org/widget-brain` (#n). To close an item, strike
it through and add the date; closed items are archived at month end.

SYNTHETIC FIXTURE: same shapes as a real PENDING file, invented content. Nothing here is a real task, id or person.

## Founder only — NOW (agents cannot do these)
| # | action | why |
|---|---|---|
| N9 | **Renew the widget licence (2026-10-14):** open the vendor portal → Billing → Renew, then paste the receipt id into `~/Documents/widget-secrets/receipt.txt` | the sales dashboard stops without it |
| N10 | ~~Upload the new product photos~~ DONE 2026-10-15 by the lead agent through the marketplace API, after the founder said yes: all 3 regions now show them; checked afterwards. Old photos kept at `~/widget-agent-work/listings-old.md` | the marketplace reviews them within a day |
| N11 | **Review request (2026-10-16, updated):** filed by the founder on 2026-10-16 under Support → Seller verification; the vendor said it answers within two working days (by 2026-10-18). Expect a form; keep the incorporation certificate (CIN U12345MH2020PTC123456) and D-U-N-S 987654321 at hand | blocks the store launch |
| N12 | **Card payments:** the provider's checks wait until the business account is open (2026-10-11, founder); then the returns page (website PR #29) and the test keys | no card payments until then |
| N13 | ~~Merge app PR #58, then #61, into `staging`~~ — DONE 2026-10-04 (the lead agent merged them once the founder said yes) | both change the staging data |
| N14 | **Analytics login for the agents (2026-10-12):** run `analytics login`, then add the read-only role. See [[20-growth/channels/newsletter]], app #734 | lets agents read the traffic numbers |
| N15 | Reply to the partner email thread (see `Acme-Org/widget-brain#42`) | partner is waiting |

## AUDIT FIXES — SECOND PASS, DONE 2026-10-09 (founder: "ship it")
- Live database: changes 41 and 42 applied — 6/6 read-only checks pass, rows intact (orders 58, products 23).
- Shop main 5c1d9e7a (#88: #85 #86 #87); 4 functions redeployed.
- Audit tally: 21 closed, 5 open. Two of the open ones need the founder (app #61, website #19), one waits on the store launch (#70).

## Needs the founder — left over from the audit (2026-10-09)
| # | action | reason |
|---|---|---|
| A1 | ~~Website deploy~~ — DONE 2026-10-09 by the lead agent (founder: "yes, ship it") | the website is live |
| A2 | Confirm the address that alert emails go to (optional for now) | alerts already reach the chat channel |
| A3 | **Webhook secret:** run the rotation script on staging, then on the live shop, then update the gateway | needs your access token |

## Needs the founder (something waits on it)
| # | item | why | waits on it |
|---|---|---|---|
| F1 | Approve the cookie banner wording (#10) | tracking needs consent first | M1, M3 |
| F2 | ~~Push~~ DONE 2026-10-04; ~~merged~~ DONE 2026-10-06 (marketing PR #17, founder "ok"). Was: **Publish the newsletter templates branch.** Branch `templates-2026-09-29` has 4 commits | the templates are not live | M2 |
| F3 | Decide: offer gift wrapping at checkout ("wrap it" → +$4 per order) | 12 customers asked for it last month | Shop agent |

## Conflicting facts — the founder picks one (docs check 2026-10-05)
| # | question | the sources say |
|---|---|---|
| T1 | ~~Product page says "hand-poured"~~ — **founder, 2026-10-06: "fine as is"** — keep the wording; no need to bring it up again. | closed |
| T2 | Which sale date is right: 2026-11-20 or 2026-11-27? | the plan says one, the calendar the other |

## Risks spotted in the docs check (2026-10-05)
| # | risk | owner |
|---|---|---|
| R1 | ~~Nobody gets an alert when an order fails~~ — **DONE 2026-10-07:** alerts now go to the chat channel | agent |
| R2 | One machine runs every scheduled job | ops |

## Expiring credentials
| name | expires on | stored in | next step |
|---|---|---|---|
| Repo token `widget-bot` (read/write issues) | **2026-12-01** | `~/.config/widget/ops.env` | founder renews it a week ahead |
| Shop API key | ~2027-06-30 | `~/.config/widget/shop.env` | rerun the setup command |

## Agent work — the roadmap (milestones; issues on GitHub)
- **M0 Setup** (#1–#4): repo ✓ 2026-10-05, shop facts, product sheets, supplier list (agents drafting them now),
  synced to the shared drive every night.
- **M1 Order tracking** (#6–#9): order source on the website; a landing page per region; consent banner.
- **M5 First ads** (#32): $300 on search ads + $200 on a holiday video, 2 weeks.

## Docs keeper — needs check (2026-10-13 pass; only the commit log was read)
- ~~Shop migrations **31–36**: not described in the docs~~ — done 2026-10-13 (second pass, read from the files).
- Was **free shipping over $50** switched on in the live shop on the morning of 14 Oct? (the changelog says "13 Oct, late")
  (owner: agent; just look at `shop_settings`, change nothing).
- Shop ADR-012 says "not live yet" while the changelog says it shipped — ask the shop lead
  to fix the ADR (owner: keeper).
- The scheduler list came back empty — probably a read error (owner: ops).

## Done 2026-10-04
- ~~Order lookup tools for the assistant (phase B)~~ — live 2026-10-04 (#43, #44): orders, refunds, stock.
- The shared drive was moved to the bigger plan.

## RELEASE NOTES — 2026-10-08 evening (narrative log, not a task list)
- **Website:** the main branch now matches staging (website #23): tracking stays off until the ids are set.
- **Checkout (prod):** cart v12, payment v12, receipts v12.

## Known gaps (written down, not fixed yet)
- Order source: tracked on the website (2026-10-06); the marketplace shop needs its own tag.
- Gift cards are off — no gift card numbers until the provider says yes.

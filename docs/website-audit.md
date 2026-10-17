# Website audit, 2026-10-17 (issue #37)

Method: DEGRADED, single context. One reviewer (Claude) judged the site from screenshots of every page at 1440, 1024 and 390 px, the
source, and scripted checks, applying the `impeccable` audit and critique references and `design-taste-frontend`. The critique's
two isolated sub-agents were not used. Headless Playwright only (Chromium, and installed Chrome for video and the 3D hero); the
shared browser pane was not touched. Nothing was published.

Scope was set by the founder's last word: the site is good, keep its direction, fix only what is broken, missing, confusing or against
the rules, and write the rest down. This page is that list.

## Result in one paragraph

Impeccable audit score 15 of 20 (good): accessibility 3, performance 3, responsive 3, theming 3, integrity 3. The home page's biggest
problem was the hero: the brain jumped when the 3D scene started (layout shift 0.2 at 1440, 0.5 at 1024) and on a laptop or tablet the
orbits ran across the headline. Fixed. The Product page said how the product is set up but not what the team does (Sales calls, posters
and reels, posting, the website check-up, the stand-up). Fixed. Every Snapshot button landed on a page that did not match its label.
Fixed. The rest is below, ranked.

## Fixed (ranked by impact, one commit each unless noted)

| # | Finding | Fix |
|---|---|---|
| 1 | Hero: still brain moved and resized when the 3D scene loaded (CLS 0.198 at 1440, 0.536 at 1024, 0.109 at 390); at 1024 the orbit chips and lines crossed the headline and the sub line | One layout rule shared by the first paint and the scene (`site/proto/a/hero-layout.ts`); glow, floor and still move with translate and scale; the brain moves or shrinks only as far as needed to keep clear of the words. CLS now 0.001, 0.009, 0. Commit 6034fe0 |
| 2 | Every "Get a free Brain Snapshot" button landed on "Let's talk", with the Snapshot as the second box, mailto buttons and a yellow `TODO(founder)` mark on the page | All Snapshot buttons go to `/contact/#snapshot`; Contact leads with a two-field form (website, email) that opens the visitor's email with the message written; the TODO mark is gone (the Discord box shows once a link is set); fields pass AA. Commit 56ae8c2 |
| 3 | Product page did not show Sales and booked calls, content (posters, reels), posting after OK, the website check-up, the morning stand-up, trusted numbers, the memory | New section "What your team gets done" (six one-line promises with their portraits). Commit 6ecf34e |
| 4 | Office clip had no labels, so a visitor could not tell the zones apart | Eleven pills set in the page over the clip (Chief of Staff, Numbers, Analytics, Marketing, Content Studio, Sales, Tech, Operations, Library, Cafeteria, Game room), placed from the app's own floor plan, on the wall side of each zone so they stay off the people; a swipeable strip on a phone. Commit a140a71 |
| 5 | Prototype switcher pill on every page; a second home page at `/b/`; "Draft pricing, to finalise later" on Pricing and home; "Logos provided by Logo.dev" in the footer and hot-linked logo.dev images | Switcher and `/b/` removed (`/` now goes to the home page; the diagram lives on Product); the draft note is gone; no logo.dev: every tool is a Simple Icons mark drawn inline, no third-party request on any page (checked on four pages); the logo.dev path only runs with `ALLEVIA_SITE_LOGO_DEV=1`. Commit 596c260 |
| 6 | "Today's note" screen was unreadable (text about 7 px) and showed a private repository name; "What your team knows" showed a raw `TypeError` line | Left column only, larger text, second card cut; the other crop ends before the error line. `app-home-note.webp`, `brain-knows-crop.webp` |
| 7 | FAQ: "day-30 delivery promise" (jargon the owner words forbid), a posting answer that contradicted the product, no answer to "what is it", "how long", "which tools" | Nine questions in plain words |
| 8 | Copy: "Best at" followed by a first-person sentence; "It may Pauses an ad" (broken grammar on 20 tool cards); Growth and Pro listed numbers without saying what they add; "stay as they are" (a note to us) on Pricing; "4 hops, every time" (an overclaim); bold lead-ins and a "Kept in a graph" line | "Reads" and "Acts" labels; "Everything in Starter / Growth" lines; "Posters, ads and reels start on Growth"; plain sentences about the brain; "The answer is 4 hops away" |
| 9 | Accessibility: pricing h1 jumped to h3; Team page had no `main` landmark; no skip link; "Going well" green was 4.37:1; menu button 41 px; unlit flow cards at 45% opacity | h2 for plan names; `main` on Team; skip link on every page; green #276b45 (5.3:1); 44 px; 60% |
| 10 | Rule check: olive avatar dots in the noise scene and a pink-peach dashed line (not in the two-colour palette) | Warm browns and tan |
| 11 | Stale tests: `tests/site/site.test.ts` counted `proto/` pages as unregistered; `tests/hygiene.test.ts` rejected the `.glb` brain; my own placeholder email tripped the identifier scan | Test lists updated; placeholder is `you@example.com`. 65 of 65 pass |

## Left for later (ranked; none of it blocks the founder's review)

1. **Posting after OK is described more strongly than the product delivers.** The app can post to Instagram, a Facebook Page and
   LinkedIn after an OK (`docs/connections-setup.md` section 4b), but it is a dry run until `ALLEVIA_ACTIONS_LIVE=1` and has never run
   against the real services. The Product page promises it, the FAQ says drafts until switched on, and the OK picture says "Draft
   saved. Nothing was posted." Decide what to claim; a real post card as the picture would settle it.
2. **Product screens are in the app's indigo ink** (navy text, a blue focus ring on the OK card, purple and teal nodes in the setup clip,
   a green notice). Rule check says warm only for the site; honest check says the customer will see indigo. Recommend changing the app's own
   `--color-ink` and `--color-focus` tokens to the warm brown, then recapturing, so site and product match.
3. **Four screenshots are soft on a retina screen** (`shot-ok-before/after` 720 px shown at 690, `brain-knows` 1000 at 628, the
   Your tools crop 1060 at 628). Recapture at 2x from the demo business on a server of our own; the old captures came from a live server
   run (`site/scripts/record-live.mjs`), which I did not start (shared database, Mac load).
4. **Security page is four lines.** Add, briefly and only with facts from `docs/tenant-isolation.md` and `docs/connections-setup.md`: each
   business has its own FalkorDB graph; tools connect through Composio's own sign-in so your team never sees a password; every action is in an
   audit log; calls are rate limited. Composio is not named anywhere on the site today.
5. **Sample data speaks to India** (Shiftly, rupees, Pune, Diwali, Dussehra, Hindi) while the buyer is in the US, UK, UAE and Australia.
   The clips and screens are real, so this is a content choice for the next recording.
6. **Pricing model is two models.** Starter, Growth and Pro on the site; Essentials, Pause and a three-month plan in `shared/plans.ts` and in
   the FAQ and the fine print. Starter exists only in `page-sections.ts`.
7. **Contact has no backend.** The form opens an email; the address is `ankit@allevia-ai.in` (a personal name on the footer of every page); the
   Discord invite link in `site/src/company.ts` is empty, so that box is hidden.
8. **Phone.** The problem scene shows a plain list and cards instead of the noise-to-calm story; Integrations is one very long column of 20
   cards (two columns would halve it); the Product diagram has an empty band under the question box until an answer arrives; Team is 13,570 px.
9. **Product page rhythm.** Five split sections in a row (steps, brain, growth, note, plan). The new section breaks it up; folding the note and
   the plan into one band would finish the job.
10. **The "R" in the founder badge** (problem scene) is unexplained next to "You".
11. **Autoplay loops with no pause button** (office clip, reel, hero orbits, integrations drift). They stop for reduced motion and data saver, but
    WCAG 2.2.2 wants a control for loops over five seconds.
12. **Tool data** (`shared/connection-map.ts`): Calendly is "Read only" yet "sends your booking link"; QuickBooks and Xero, HubSpot and Zoho share
    one sentence each.
13. **Decorative dots** (flow list, plan bullets) are a taste-rule tell; harmless.
14. **Slack is a 96 px local picture and LinkedIn is left out.** Simple Icons no longer carries either. A vector Slack mark and the LinkedIn
    "In" bug from their brand pages would complete the set; that needs a download someone approves.
15. **Not tested:** Safari, Firefox, a real iPhone, a screen reader. `noindex` is on every page (right for now). No social image for the new pages.
16. **Names:** `site/proto/b/` now holds only the Product diagram's files (`b.css`, `hero2d.ts`); rename the folder when convenient.

## What the checks found

| Check | Result |
|---|---|
| Links | Every link and button on 8 pages returns 200 (footer About, Privacy, Terms, Cookies and Data deletion served by the local main-site build); `#problem`, `#snapshot`, `#demo`, `#grow`, `#main` all exist |
| Console and network | 0 errors and 0 failed requests on all 8 pages at 390 and 1440 (headless GL prints a "GPU stall" warning that real GPUs do not) |
| Horizontal overflow | None at 390, 1024 or 1440 |
| Contrast (band-aware, every text element) | 0 failures after the green fix (the detector's 1:1 findings are false: it cannot see the dark band) |
| Palette | No blue, purple or pink text; no off-palette section backgrounds; product screens excepted (item 2) |
| Layout shift | Home 0.198 to 0.001 at 1440; the other pages under 0.04 |
| Weight at 1440 after a full scroll | Home 2.8 MB (clip 776 KB, 3D chunk 658 KB, brain mesh 315 KB; the chunk loads when idle and the clip when scrolled to); Product 1.2 MB; Integrations 0.65 MB; Team 0.5 MB; Pricing, Security, FAQ, Contact 0.33 MB |
| Detector (impeccable) | 163 raw findings, almost all false positives (the cream palette is the brief; dark-band contrast; the app's own absolute layers). Real: one skipped heading (fixed), one 10 px "APP" badge in the Discord picture (left), the marquee (one per page, paused for reduced motion) |
| Tests | `tests/site` and `tests/hygiene.test.ts`: 65 of 65. `tsc` clean. Not run: the whole suite |

## Does the site show the product? (coverage after the fixes)

| Topic | Where |
|---|---|
| A Founder OS: one company brain plus an AI team that works in your tools | Home hero and FAQ "What is Allevia?" |
| The company brain that grows (FalkorDB) | Home "One brain", Product brain and growth sections |
| Onboarding from a website | Product steps (pinned), FAQ "How long does setup take?" |
| Connecting tools | Product step 3, Integrations (20 tools, what each reads and acts on) |
| The team and what each does | Team page, Product "What your team gets done", office zone labels |
| Sales booking calls | Product work section, Team (Neel), home flow |
| Content: posters, photo to premium ad, reels | Home slider and reel, Product work section |
| Posting after OK | Product work section, FAQ (see item 1 above) |
| Discord and the web app | Home and Product OK sections (same card in both) |
| Approvals | Home and Product "You tap OK" |
| Today's note and the stand-up | Product "Today's note" and work section |
| Website check-up | Product work section, Brain Snapshot offer |
| Growth plan | Product "Your plan moves" |
| Security and privacy | Security page (thin: item 4), Integrations "You stay in control", FAQ |

## Before and after

`docs/screenshots/`: `site-audit-hero-1024.webp`, `site-audit-contact-1440.webp`, `site-audit-pricing-1440.webp`,
`site-audit-office-1440.webp` (before and after); `site-audit-office-390.webp`, `site-audit-product-work-1440.webp`,
`site-audit-logos-1440.webp` (after).

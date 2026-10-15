# Allevia website v4: brief

**Self-authored under explicit creative delegation.** The coordinator's brief (on the founder's behalf, 2026-10-15) set
the journey, the asset rule and the constraints below; every other decision here is authored and labelled as such. No
user quotations are invented. Evidence comes from the repository: `docs/owner-words.md`, `site/src/company.ts`,
`site/src/content.ts`, the memory notes on the buyer and the office, and the running app in its demo mode.

## The eight topics

1. **Vibe (authored):** the office after hours, lit from the desks; calm, warm, competent; a little playful because of the
   dogs. References: a night-shift newsroom seen through glass, a pixel-art management game's overview screen, the
   app's own dark theme (navy, gold, Newsreader).
2. **Journey (given, verbatim order):** paste your website, meet your team in the living office, ask anything (web or
   Discord), the team makes posts and fixes, you tap OK, your growth plan moves.
3. **Energy (authored):** quiet open, a held breath, the loudest moment is the office, then steadily calmer and more
   concrete, ending still.
4. **Feeling and the one moment (authored):** see the curve and the peak below.
5. **The thing no site does (authored):** a courier. The office dog Fluffy carries whatever you typed as "your
   website" down the page, stop by stop, and gets a treat at each one. It is the product's own pet-courier idea, and it
   is also the page's navigation.
6. **Range (authored):** premium-minimal is not asked for. Editorial with a playful accent: real type and real screens,
   one pixel character. The palette is the app's own (deep navy, gold), not the cream-and-brass default; the gold is
   the brand's wordmark underline and the app's OK button, so it is named by the brand.
7. **One world or scenes (authored):** distinct scenes. The product is several screens, and pretending it is one place
   would be dishonest. The courier route is what joins them.
8. **Assets (given):** real product footage only. Recorded from the running web app in its demo mode (sample numbers,
   two sample businesses) with `site/scripts/record-footage.mjs`: onboarding reading a website, the office mid-question,
   an answer arriving with its path, the approvals card before and after OK, the plan. Plus the real Studio trial
   photos and the real posters the team made in `docs/creative-live/`. No generated imagery is needed for the story; any
   Higgsfield use is capped and logged in `docs/higgsfield-spend.md`.

## Facts and rules carried over

`docs/owner-words.md` wins on words: no "agent", "Day 0", "baseline"; "Waiting for your OK"; "sample numbers" said
wherever numbers are made up. Company facts from `site/src/company.ts`, prices from `shared/plans.ts`, the team from
`shared/roster.ts`. Nothing on the page says Allevia posts anything: an approved post is saved as a draft.

## Journey beats

```
1  Recognition  "my website is the starting point, and I do nothing else"     (paste)
2  Pause        "something is being set up for me"                             (quiet)
3  Turn         "there is a whole team, and I can watch it work"               (office)
4  Substance    "they answer my real questions, with sources"                  (ask, web or Discord)
5  Range        "they make actual things: posts, photos, website fixes"        (make)
6  Control      "nothing goes out without me"                                  (OK)
7  Proof        "it moves my numbers, and it says so plainly"                  (plan)
8  Commitment   "send your website for a free Brain Snapshot"                  (close)
```

## The feeling curve (home)

```
1  Curiosity     a real address field with a blinking caret; as you scroll, the app reads a website and its picture grows
2  Anticipation  an almost empty screen, one line: the setup is done and the lights are about to come on (AUTHORED SILENCE)
3  Delight       the office fills the screen and the reader scrubs a working morning: desks light, dogs carry papers
4  Confidence    the question, then the answer assembling line by line, each claim with its source; Discord as the second door
5  Appetite      the things the team made slide past, each labelled like an exhibit: who made it, and that it waits for you
6  Relief        one card, one tap: the card wipes to "Draft saved. Nothing was posted."
7  Pride         three goals move from where the sample business started to where it is now
8  Calm          the price and three straight answers, set plainly (administrative, compressed)
9  Resolve       the courier arrives with your website; one button, the page stops
```

**The peak:** act 3. *"The office lit up and I scrolled through their morning, with the dogs carrying papers between
desks."* It gets the best footage, the silence of act 2 in front of it, and the largest span on the page.

**It's the site where** a little pixel dog carries your website down the page and gets a treat at every stop.

**Authored silence:** act 2 (one line on an empty ground, about 0.8 of a screen). The verification pass should read it
as intended, not as dead scroll.

## Grammar: "Courier route" (a new grammar), home page

**What a section is:** a stop on a delivery route through the product. Each stop shows one real thing the owner would
see in the app, in that thing's own footage.

**Chrome:** the route strip, fixed to the bottom edge: six named stops on a dotted line, each a link to its stop, with
the courier walking it as the reader scrolls and a treat stamped on every stop she has reached. The masthead stays (the
site's shared navigation), quiet and dark.

**Hero:** the field that starts the route (a real input; what you type stays on the page) beside the first footage.

**Close:** arrival. The courier sits at the last stop; the one call to action sits there with your website in the
sentence.

**Forbids:** any generated or div-built picture of the product; section numbers or counters; an eyebrow on every
section; centred copy in more than one act; more than two scrub acts; a stop without real product evidence; a counter
on a number that is not the app's own (sample numbers labelled as such); the courier doing anything that is not
delivering (no idle tricks).

**Why the other seven lost:**
- *Filmic one-shot:* the brief is six discrete stops, and hiding the seams between different screens would blur what
  each one is.
- *Chaptered editorial:* it bans a scrub hero, and the owner needs to see the product move before reading about it.
- *Live surface:* the app cannot run inside a static site honestly (no server, no data), and its honesty rule points
  to real footage instead.
- *Continuous world:* there is no geography; the product is screens, not a place you travel through.
- *Typographic poster:* the asset here is the product, not a sentence.
- *Gallery / catalog:* right for the product tour (an index of screens), so it is used there instead.
- *Split stage:* there is no two-sided argument; before and after appears only in one stop.
- *Rhythmic cutlist:* the buyer is a busy owner who wants calm, not pulse.

## Grammar: Gallery / catalog, product tour

The tour is a room of real screens. Each screen is an object with the same label schema (*what it is · who works on
it · what you do · data*), the nav is an index of screens that jumps, the hero is screen one already labelled, and the
close is an inquiry plate typeset like a label. Its one scrub is the answer arriving with its path. Its signature move:
**the label line you are reading lights the part of the screen it describes** (scroll or focus a line, and a frame
appears on the real screenshot where that thing is).

## Score (home)

| Beat | Device | Why this one |
|---|---|---|
| Paste | `scrub` + `parallax` (layered hero) | The website being read under the reader's hand is the product's first minute; three planes give depth |
| Pause | `flow` | Silence before the peak; nothing moves on purpose |
| Office (peak) | `scrub`, largest span, dwell | The reader drives the office clock; the frame pushes in |
| Ask | `pin` + cues | The answer assembles while the frame holds, like it does in the app |
| Make | `pan` | Lateral travel reads as "the range of things they make" |
| OK | `reveal` | A wipe is a change of state, which is exactly what tapping OK is |
| Grow | `pin` + `count` (sample numbers) | The bars move from where the sample business started to now |
| Cost, questions | `flow` + `in` | Administrative, compressed |
| Close | `pin`, short | The courier arrives and the page holds still |

Device families: scrub, flow, pin, pan, reveal, count, parallax: seven. No family twice in a row; two scrubs.

## Mobile and reduced motion (authored)

Below 861px, and whenever the reader asks for reduced motion, the page does not pin or scrub. It becomes a plain
vertical story: the same stops, the footage recorded on a 390px phone as short muted loops that play only in view (with
a pause button), the posters as the first paint, every line of copy visible. Scroll-scrubbing on phones is the part a
headless check cannot prove on a real iPhone, so the phone gets the version that cannot freeze.

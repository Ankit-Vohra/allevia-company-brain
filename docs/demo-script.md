# Demo video script (3 minutes)

Nine scenes, about 450 words of narration at a calm pace. Recorded locally in live mode on the real Aamdani and AVS
Atelier graphs, 1440×900, light theme. Times are targets; the narration for each scene fits its time when read
aloud. Anything sped up in the edit gets an on-screen "2× speed" tag, so nothing on screen pretends to be faster than
it is (a multi-desk answer takes 30–60 s).

## Before recording

- [ ] FalkorDB up, `npm run cli -- db:check` lists `aamdani` and `avs_atelier`; `npm run cli -- privacy-scan aamdani`
      and `privacy-scan avs_atelier` both report 0.
- [ ] Web app built (`cd web && npm run build`), server in **live** mode: `npm run cli -- serve` (not `--public`).
      Claude Code is logged in with the claude.ai account; nothing else is using the subscription during the take.
- [ ] Executors stay dry runs (`ALLEVIA_ACTIONS_LIVE` unset): approving a card records it, nothing is posted.
- [ ] Rehearsal threads exist for the "why" question (showcase `turn:2026-10-15-41ee662e`), so a failed live take
      can fall back to **Replay last request**, which replays the stored work log at real pace.
- [ ] An AVS Atelier content draft is pending with a word the owner would change. In rehearsal: "villa", which the
      owner edits to "home". Check with `npm run cli -- approvals avs_atelier`.
- [ ] Studio: the demo sample (a degraded copy of the studio's own website photo of Retreat, made by
      `scripts/studio-demo.ts rough`) and the recorded generated variant are in the data dir. Set
      `ALLEVIA_STUDIO_CACHE_ONLY=1` so Tara's and Nisha's recorded answers replay and no model is called.
- [ ] For scene 5, onboard AVS Atelier into a **fresh slug** (for example `avs_atelier_demo`) so the real tenant is
      untouched, or play back the earlier onboarding recording.
- [ ] Browser zoom 100%, notifications off, bookmarks bar hidden. FalkorDB Browser open in a second tab on
      `http://127.0.0.1:3090`.
- [ ] Nothing on screen shows a token, an email address, a phone number or a server address (terminal history
      cleared, env file closed).

## Scenes

### 1. The problem (0:00–0:15)

**On screen:** the marketing site hero (`site/`, home), then a slow push-in on the line "One setup. A whole team.
Better every week."

**Narration:** "Most small business owners have tried AI. Very few have AI doing a job in their business. In the US,
three in four engaged owners use it; one in seven has it running their operations. The missing piece isn't the
model. It's someone setting it up and keeping it running."

### 2. The office (0:15–0:30)

**On screen:** Aamdani's office. Pan across the eight rooms; hover Meera, then click Isha to open her profile drawer
(role, tools, what she knows, recent findings). Close it.

**Narration:** "This is Allevia: twelve AI staff in eight departments, set up for one business. Meera runs the office.
Isha checks every number. Each of them is a node in this company's own graph in FalkorDB, so what they know and what
they've done is something you can look at."

### 3. Ask "why", and the path lights up (0:30–1:05)

**On screen:** type "Why did we pause daily stories and image posts?" in the office's ask box. Meera's bubble:
"Recalling what we know". The plan appears; Sara (Library) starts typing at her desk; tool chips stream in the work log
(`trace_decision`, `search`). Cut to Ask: the answer streams with citation chips, the checks row turns green, and
the path behind the answer lights up gold in the graph: founder → decision → the evidence it was based on. Click
one citation chip to open the source document. Optional two-second flash: the same question asked in Hindi,
answered in Hindi.

**Narration:** "Ask why something happened. Meera plans who should answer, Sara traces the decision, and every
claim cites a node in the graph. The server checks that each citation was actually read in this turn and that every
number came from a tool result. If anything doesn't check out, the answer says 'unverified'. And this is the path
through the graph that proves it: who decided, based on what, and when."

### 4. It learns you: "villa" becomes "home" (1:05–1:30)

**On screen:** Approvals for AVS Atelier. Open the pending content draft, change "villa" to "home", approve. The card
shows "Approved with your edits" and the chip "Learned: say 'home', not 'villa' · applied to future drafts". Cut to
the office: a new book appears on Sara's shelf; click it to show the rule's `LEARNED_FROM` path to this approval.
Back on the 90-days card: first-pass approvals and "Rules learned 1".

**Narration:** "When the owner edits a draft, the edit becomes a rule, linked to the approval it came from. The next
draft uses it without being told. We track one number for this: the share of drafts approved without an edit. It
should climb every week, and the owner can see exactly why."

### 5. Onboarding from a URL (1:30–1:55)

**On screen:** "Add a business", type "AVS Atelier" and `avsatelier.in`, start. The stages stream (reading pages,
brand kit, SEO checks, understanding, goals, baseline, capabilities) while the graph grows on the right. End on
"What we did for you" with the counts. *2× speed tag during the crawl.*

**Narration:** "Any business starts from its website. Allevia reads it politely, picks out the brand, runs search
checks, maps services, audiences and what they need, and sets three goals with a Day-0 baseline. Nothing is posted or
changed anywhere. AVS Atelier, an architecture studio, got its whole team from this one URL."

### 6. Studio: enhance, never invent (1:55–2:20)

**On screen:** AVS Studio. Drop the dark, tilted phone photo of Retreat with the note "the pool and the arched guest
rooms". Tara's boxes appear on the original (tilt, exposure, clutter). Variant A (straightened, relit locally) and
variant B (generated edit) side by side. Nisha's badge on B: **changed**, listing what she found added, including an
air-conditioner unit that isn't in the photo. Variant A: **unchanged**. Dev's caption under A. Approve A.

**Narration:** "Owners send phone photos. Tara plans the post, the studio makes two versions, and Nisha, our fact
checker, compares each one with the original. Here the AI version looks better, but Nisha caught it adding things
to a real building, including an air conditioner that isn't there. So we recommend the honest version. Enhance,
never invent."

### 7. The 90-day scorecard (2:20–2:35)

**On screen:** Aamdani's office, the "Your 90 days" card: Day N of 90, checkpoints at 30, 60 and 90, goals against
their Day-0 baselines with the owning agent beside each, the first-pass curve, rules learned, and "What your team can
see" (each source's access mode).

**Narration:** "Every business runs a 90-day program. Goals are locked against real Day-0 numbers. Nothing is
backfilled. Each goal has an owner on the team, and every data source says honestly how it's connected."

### 8. Pricing and the black box (2:35–2:45)

**On screen:** `site/pricing`, toggle USD → GBP → AED → AUD. Rest on Allevia 90 and Growth.

**Narration:** "Allevia 90 is a done-for-you start at fourteen ninety, then a monthly plan. One setup, a team in India
that keeps it running, and an owner who should need about ninety seconds a day."

### 9. FalkorDB under the hood (2:45–3:00)

**On screen:** FalkorDB Browser: the graph list (`allevia_meta`, `allevia_aamdani`, `allevia_avs_atelier`), then
`allevia_aamdani` with a decision and its `BASED_ON` evidence expanded. Overlay three lines, one at a time: "One graph
per business", "Facts with valid time and sources", "Paths, PageRank, communities as agent tools". End card: Allevia
logo, repo URL, "Built on FalkorDB".

**Narration:** "Under the hood, every business is its own graph in FalkorDB. Facts carry when they were true and
where they came from, and the agents' tools are graph queries and graph algorithms. That's why every answer can show
its path. Allevia: a growth team with receipts."

## After recording

- [ ] Watch it once with the sound off: every claim on screen should be readable without the narration.
- [ ] Freeze-frame check for identifiers: no email, phone, token, address or private document title in any frame.
- [ ] Export 1080p, under 3:00, captions burned in or as an `.srt`.
- [ ] Upload unlisted first, then add the link to the submission and the README.

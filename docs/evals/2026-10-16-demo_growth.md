# Eval: demo_growth, 2026-10-16

Live run of `evals/hero.yaml` through `ask()` with the real wiring (`src/agent/wiring.ts`): the Claude Agent SDK on the founder's subscription and the graph tools on `allevia_demo_growth`. Every question is a new thread; its Turn (answer, checks, full event log) is saved in the graph.

Model: roster default. Questions run: 5 of 5 in the set. Answers below are the first 300 characters, citation markers removed.

<!-- notes -->
<!-- /notes -->

## Summary

| | First run | Latest (after re-runs) |
|---|---|---|
| Questions | 5 | 5 |
| Turns that finished | 5 of 5 (100%) | 5 of 5 (100%) |
| Passed (every check and expectation) | 3 of 5 (60%) | 3 of 5 (60%) |
| Expectations hit | 34 of 36 (94%) | 34 of 36 (94%) |
| citations valid | 100% | 100% |
| numbers grounded | 100% | 100% |
| simulated disclosed | 100% | 100% |
| freshness disclosed | 100% | 100% |
| mode disclosed | 100% | 100% |
| Mean latency | 54.4 s | 57.7 s |
| Median / max latency | 52.1 s / 73.3 s | 52.1 s / 86.9 s |
| Mean tool calls | 21.2 | 21.4 |

Expectation hits by kind: cite 7/7 · match 13/13 · tool 3/3 · agent 3/3 · path 4/5 · propose 2/2 · forbid 1/2 · simulated 1/1.

Agents (turns worked on): Meera 5 · Imran 4 · Zoya 3 · Kabir 2 · Sara 2 · Isha 2 · Arjun 2.

## Questions

| # | id | tags | result | checks | hits | latency | agents | tool calls | turn |
|---|---|---|---|---|---|---|---|---|---|
| 1 | hero-why-signups-drop | hero, why, multi-desk, memory | PASS (re-run) | ok | 20/20 | 86.9 s | Meera, Kabir, Zoya, Imran, Sara, Isha, Arjun | 46: use_skill, metric_trend, search, cypher, trace_decision, get_entity, history, find_paths, impact_of, propose_action, show_path | `turn:2026-10-16-173fe6e8` |
| 2 | hero-ads-red-herring | hero, why, trap | PASS | ok | 5/5 | 52.1 s | Meera, Kabir, Zoya, Imran, Isha | 30: use_skill, search, metric_trend, get_entity, show_path | `turn:2026-10-16-057c98b4` |
| 3 | hero-not-in-records | hero, trap | FAIL | ok | 1/2 | 42.0 s | Meera, Imran | 13: use_skill, search, get_entity, cypher, propose_action, show_path | `turn:2026-10-16-1483e943` |
| 4 | hero-depth-contrast | hero, impact | FAIL | ok | 4/5 | 73.3 s | Meera, Arjun, Imran | 8: search, use_skill, impact_of, cypher, get_entity, show_path | `turn:2026-10-16-f433e0d8` |
| 5 | hero-memory | hero, memory, library | PASS | ok | 4/4 | 34.0 s | Meera, Sara, Zoya | 10: use_skill, trace_decision, search, metric_trend, get_entity, show_path | `turn:2026-10-16-58427e24` |

## Answers and failures

### 1. hero-why-signups-drop: PASS (re-run)

**Q:** Why did sign-ups drop this week, and what should we do?

> Sign-ups fell because the new phone number field crashes the sign-up screen. It came in with app version 2.8.0 on 7 Oct. The fix is built but not live. I'm confident in this cause. The crash is recorded on that screen, and 2.8.0 is recorded as the release that added the field. What happened, in…

- Attempt 1: PASS (`turn:2026-10-16-7c625f90`, 70.4 s)
- Attempt 2: PASS (`turn:2026-10-16-b96a0d54`, 103.0 s)
- Attempt 3: PASS (`turn:2026-10-16-bbeb4287`, 85.8 s)
- Attempt 4: PASS (`turn:2026-10-16-dd0c6a85`, 69.2 s)

### 2. hero-ads-red-herring: PASS

**Q:** Did pausing the Meta ads cause the sign-up drop?

> No, the Meta pause very likely didn't cause the drop. Sign-ups fell on 2026-10-07, three days before the ads were paused on 2026-10-10 (sample numbers). The likely cause is a crash in the new phone field on the sign-up screen. - New accounts averaged about 238 a day before 2026-10-07 and about 51…

### 3. hero-not-in-records: FAIL

**Q:** What did people say about the new phone-number box in their store reviews?

> Store review text since 7 October isn't recorded, so I can't tell you what people said about the phone-number box. What your records do show: - Release 2.8.0 replaced the plain phone box on the sign-up screen with a field that picks the country code on its own. It reached everyone on Android on 7…

- Forbidden `"[^"]{12,}"` matched: ""TypeError... reading 'country' in PhoneInput""

### 4. hero-depth-contrast: FAIL

**Q:** What else breaks if the sign-up screen keeps crashing?

> If the crash keeps going, 8 more steps break after the sign-up screen, and 2 of them are on the employer side. That is the phone step plus 7 steps below it. Only the phone step has a recorded owner. Each step depends on the one before it: 1. Phone step, one step away. Neha owns it. 2. OTP…

- Missed path `page:screen/app/auth/sign-up` (got: feature:seekers-signup-sign-up-screen-viewed, feature:seekers-signup-phone-number-entered, feature:seekers-signup-otp-verified, feature:seekers-signup-profile-completed, feature:employer-applicant-inbox)

### 5. hero-memory: PASS

**Q:** What did we decide last time about the sign-up crash, and where does it stand?

> You decided on 10 October to ship a fix (2.8.1) and keep 2.8.0 live instead of rolling back. The fix isn't live yet, so the crash is still happening. **Why you chose that** - A rollback would also have removed the new job feed, so you fixed the phone number field instead. - Farhan, Android…

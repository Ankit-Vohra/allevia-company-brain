# Eval: demo_growth, 2026-10-16

Live run of `evals/hero.yaml` through `ask()` with the real wiring (`src/agent/wiring.ts`): the Claude Agent SDK on the founder's subscription and the graph tools on `allevia_demo_growth`. Every question is a new thread; its Turn (answer, checks, full event log) is saved in the graph.

Model: roster default. Questions run: 1 of 5 in the set. Answers below are the first 300 characters, citation markers removed.

<!-- notes -->
<!-- /notes -->

## Summary

| | First run | Latest (after re-runs) |
|---|---|---|
| Questions | 1 | 1 |
| Turns that finished | 1 of 1 (100%) | 1 of 1 (100%) |
| Passed (every check and expectation) | 0 of 1 (0%) | 0 of 1 (0%) |
| Expectations hit | 19 of 20 (95%) | 18 of 20 (90%) |
| citations valid | 100% | 100% |
| numbers grounded | 100% | 100% |
| simulated disclosed | 0% | 100% |
| freshness disclosed | 100% | 100% |
| mode disclosed | 0% | 100% |
| Mean latency | 95.9 s | 95.8 s |
| Median / max latency | 95.9 s / 95.9 s | 95.8 s / 95.8 s |
| Mean tool calls | 47.0 | 41.0 |

Expectation hits by kind: cite 3/3 · match 5/5 · tool 2/2 · agent 3/3 · path 3/4 · propose 1/2 · forbid 1/1.

Agents (turns worked on): Meera 1 · Kabir 1 · Zoya 1 · Imran 1 · Sara 1 · Isha 1 · Arjun 1.

## Questions

| # | id | tags | result | checks | hits | latency | agents | tool calls | turn |
|---|---|---|---|---|---|---|---|---|---|
| 1 | hero-why-signups-drop | hero, why, multi-desk, memory | FAIL (re-run) | ok | 18/20 | 95.8 s | Meera, Kabir, Zoya, Imran, Sara, Isha, Arjun | 41: search, trace_decision, use_skill, metric_trend, history, get_entity, impact_of, propose_action, show_path | `turn:2026-10-16-a8811fc6` |

## Answers and failures

### 1. hero-why-signups-drop: FAIL (re-run)

**Q:** Why did sign-ups drop this week, and what should we do?

> Phone sign-ups fell because of the new phone number field in version 2.8.0. The dates match, so this is likely, not proven. The fix, 2.8.1, is built but not live yet, so nothing has recovered. **What happened, in order** 1. Version 2.8.0 reached everyone on Android on 7 Oct. It swapped the plain…

- Missed path `event:release-shiftly-2-8-0` (got: feature:seekers-signup-phone-number-entered, page:screen/app/auth/sign-up, event:sentry-issue-shiftly-41, recommendation:get-android-2-8-1-signed-off-and-chase-iphone-app-store-review, document:release-notes-2-8-0, person:farhan)
- Missed propose `content_draft` (got: github_issue)
- Attempt 1: FAIL (`turn:2026-10-16-ba18310e`, 95.9 s): Missed path `event:release-shiftly-2-8-0` (got: feature:seekers-signup-phone-number-entered, page:screen/app/auth/sign-up, event:sentry-issue-shiftly-41, recommendation:get-android-2-8-1-signed-off-and-chase-iphone-app-store-review, document:release-notes-2-8-0, person:farhan); Check failed: simulated; Check failed: mode

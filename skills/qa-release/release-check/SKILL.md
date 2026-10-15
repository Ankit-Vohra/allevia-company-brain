---
id: release-check
name: Release readiness check
when: "Is this app release safe to send out: what changed, what must be tried first, go or hold"
agents: [qa-release]
tools: [history, get_entity, search, metric_trend]
output: reads
needs_ok: false
---

## Method

1. Find what is in the release: `history` on the app or release entity for changes since the last release, and `search` for tickets or decisions tied to it. List the flows each change touches.
2. Pick the two or three flows customers use most (sign-up or login, the main action such as booking or paying) and say each must be tried on a real phone, not just a computer, before it goes out. Add any flow the change touched.
3. Check last release's health as a baseline: `metric_trend` on crash-free rate or crashes, groupBy day, so you know what normal looks like when you judge this one.
4. Run the release manager's list against the record: the build passes; version number and notes updated; store listing, permissions and privacy answers still true; a staged rollout planned (start at about 5 to 10% of users); a rollback plan and a person on call after release (`get_entity` for the owner).
5. Make the call: go (all boxes ticked), go slowly (ticked except something small, with a staged rollout), hold (a main flow untested or an unknown crash cause). Name what turns hold into go.
6. If something is not recorded (no test results, no rollback plan), say "not recorded" rather than assume it passed.

## House style

The call first, then what is checked and what is not.

> Hold: the update is not safe to send yet. Booking and login were not tried on a phone, and no rollback plan is recorded. Everything else checks out. Send it once both are done: about 30 minutes. Plan a 10% rollout first.

## Done well

- [ ] The call is go, go slowly or hold, with the one thing that changes it.
- [ ] The main flows are named and marked as tried on a phone or not.
- [ ] A staged rollout and a rollback plan are present or called missing.
- [ ] Last release's normal crash level is the reference.
- [ ] Nothing unrecorded is assumed passed.

## Common mistakes

- Treating a green build as proof the app works.
- Skipping a phone test for the main action.
- Releasing to everyone at once.
- No one named for after the release.

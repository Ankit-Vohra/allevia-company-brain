---
id: what-breaks-if
name: What breaks if this stops
when: "What would stop working if a login, token, service or page failed or expired, and what to do before it does"
agents: [tech-lead]
tools: [search, impact_of, get_entity, neighbors]
output: reads
needs_ok: false
---

## Method

1. Find the right thing to test. A token or a login fails together with the system that uses it, so `search` for that system first (the Instagram connector, not "the token"), and confirm it with `get_entity`.
2b. For a broken screen, release or crash, run `impact_of` twice on the thing that is broken: depth 1 and depth 4. Depth 1 is what a simple lookup shows (the next step, the campaign sending people in); depth 4 is the knock-on the owner would not think of (later steps, the alerts and employer features that need them). Report the two lists side by side, with the link that pulls each far item in, and say how many more things depth 4 finds.
2. Run `impact_of` on it, depth 3. It returns what depends on it and what it affects, by number of steps away, with the connection that links each. Step 1 things break at once; step 2 and 3 things break by knock-on.
3. Put the effects in the order a customer meets them: what customers see (the booking form, the shop, the Instagram feed on the site) first, then what the team sees (a report, a sync), then what nobody notices for weeks.
4. For each, give the owner (`get_entity` on the affected thing) and, if the record has a date (an expiry), when it hits. Use `neighbors` to check a doubtful link.
5. State what the owner or team can do before it breaks: renew, add a fallback, tell someone, and how long it takes.
6. When the map is thin (few connections recorded), say so: the answer is what is recorded, not everything that could break.

## House style

Answer first: what breaks, how soon. Then at most five effects, customer-visible first, then what to do before it happens.

> If the Instagram connection stops, your website's feed and the weekly post report stop (2 things depend on it; Arjun owns both). It expires on 30 Oct, so you have about two weeks. Renewing takes about 10 minutes.

## Done well

- [ ] The thing tested is the system that uses the token or login, not the token.
- [ ] Customer-visible effects come first.
- [ ] Each effect has an owner and a date where one exists.
- [ ] A before-it-breaks action with a time is given.
- [ ] A thin map is admitted.

## Common mistakes

- Treating a token as a system and finding nothing.
- Listing 20 knock-on effects with no order.
- Claiming something would not break because it was not recorded.
- No date, no action: just a list of fears.

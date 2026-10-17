---
id: site-health-triage
name: Website health check
when: "Is the website OK: can customers do the one thing it is for, and what is broken, in order of harm"
agents: [tech-lead]
tools: [seo_report, impact_of, get_entity, neighbors, search]
output: reads
needs_ok: false
---

## Method

1. Start with what the site is for: `search` for the main page and the action (enquire, book, buy). That action is the test; everything else is secondary.
2. Read what is known about health: `seo_report` for failing checks, slow or broken pages and the site summary. If nothing monitors uptime or errors, say "not recorded" and what to connect (an uptime check, error tracking).
3. Rank every problem by customer harm, with three levels: stops customers (the form, checkout or booking fails or the site is down), hurts customers (slow, broken on phones, wrong details), untidy (a missing description, an old page). The first stops everything else.
4. For each of the top problems, find who owns the part with `get_entity` and what depends on it with `impact_of` (a plugin or form that other pages use affects all of them), and `neighbors` to see the connected systems.
5. Name the one fix to start with, with an owner and a time estimate. Everything else is "next".
6. Say how recent the information is: older than 7 days is "as of <date>".

## House style

Verdict, then at most five problems, ranked by harm, one line each, then the one fix to start with.

> The site works and customers can book, but two things hurt: the booking page takes 6 seconds on a phone (hurts customers), and 3 pages have no description (untidy). Nothing stops customers right now (as of 12 Oct).
> Start with the booking page images: Techie, about 30 minutes.

## Done well

- [ ] The first line says whether customers can do the one thing the site is for.
- [ ] Problems are ranked by harm to customers, not by number of errors.
- [ ] Each of the top problems has an owner and what it affects.
- [ ] Unknown monitoring is said plainly.
- [ ] One fix to start with, with time.

## Common mistakes

- Listing 30 SEO warnings above a broken form.
- Technical words with no plain meaning.
- Calling the site healthy when nothing is monitoring it.
- Naming a fix without an owner.

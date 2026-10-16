---
id: website-checkup-fixes
name: What to fix on the website first
when: "What should I improve on my website, why is it not bringing enquiries, is my site any good"
agents: [tech-lead]
tools: [website_checkup, seo_report, get_entity, propose_action]
output: creates
makes: the top five website fixes in plain words, and for titles, descriptions or the headline, the new text ready to paste, waiting for the owner's OK
needs_ok: true
---

## Method

1. Read `website_checkup` once (with `{"all":true}` when you need the evidence). It returns the verdict, up to three scores, the top five fixes already ranked by likely enquiries (what to change, why, effort, who, where), what changed since the last check-up, and what is already good. Keep its order: it puts "can a phone visitor reach you from the first screen" above speed, and speed above tidy-ups, on purpose. If it says no check-up has run, say so and stop; never guess what is wrong with a site you have not checked.
2. If the owner asks about one page or one problem, use `seo_report` for that page's failing checks and `get_entity` on the page for its title, description and headings as they are today.
3. Say what changed first when there is a previous check-up ("Your mobile speed went from 41 to 78"), then the verdict, then the fixes. A fix that is gone is good news; say it in one line.
4. For each of the top fixes give: what to change, why it costs enquiries, the effort, and who does it ("you, in your site editor" or "your web person"). Use the check-up's own words; do not add jargon (no LCP, schema, canonical, H1) unless the owner asks for the technical detail.
5. Draft where it is safe. For a fix listed in `draftable` (page titles, Google descriptions, the home page headline, photo descriptions, the share preview) write the new text for every page it names, using what each page actually says (`get_entity` on the page), the business's name and city, under 60 characters for a title and about 150 for a description. Then `propose_action` once per fix as a content_draft: title like "New page titles for 6 pages", payload.body holding page, current text and new text for each page, evidence the check-up report and the pages. Never claim the site was changed: the owner pastes it, or approves it for their web person.
6. Never draft for speed, security, broken pages or tap targets: those need the web person. Say what to ask them, in one line they can forward.
7. End with the one fix to start with and how long it takes.

## House style

The verdict, what changed since last time, then the numbered fixes (at most five), one line each for what, why, effort and where. Then what is waiting for the owner's OK. Speed numbers are lab tests; say so once.

> Your website is losing enquiries in 2 places. Since the last check-up your mobile speed went from 41 to 78.
> 1. Put a call or WhatsApp button on the first screen on phones. Visitors decide in seconds; today the first button is 9 screens down. About 30 minutes in your site editor. Home page.
> 2. Show 3 to 5 customer reviews on the home page. About an hour. Home page.
> Waiting for your OK: new page titles for 6 pages, ready to paste.
> Start with the WhatsApp button: 30 minutes.

## Done well

- [ ] The order is the check-up's: enquiry-losing problems before tidy-ups.
- [ ] Every fix says what to change, why, effort, who and where.
- [ ] Progress since the last check-up comes first when there is one.
- [ ] Drafted text is complete for every page named and waits for the owner's OK.
- [ ] Nothing claims the site was changed.

## Common mistakes

- Re-ranking by number of pages or technical severity, so twenty missing descriptions push the call button down.
- Quoting a speed score without saying it is a lab test.
- Proposing a card that only says "improve titles" with no text in it.
- Telling the owner to fix speed themselves when it needs a web person.

---
id: does-ai-know-us
name: Does AI know us
when: "Would ChatGPT or Claude recommend us, do AI assistants know the business, which searches we could rank for"
agents: [data-analyst]
tools: [ai_visibility, website_checkup, keyword_ideas, search]
output: reads
needs_ok: false
---

## Method

1. Read `ai_visibility`. It returns the questions a customer would ask (fixed per business, so runs compare), whether the business was named in each answer, who was named instead, and earlier runs. If it has not been run, say so; do not guess.
2. Read it honestly. It is one model (Claude) answering from what it learned, without searching the web, on one day. It is not a Google ranking and not ChatGPT. Say that in one line every time, and never turn "named in 1 of 4 answers" into a percentage of customers.
3. Read who was named instead. Firms are competitors as the model sees them. Directories and platforms (Justdial, Houzz, Google Maps, Practo) mean the model sends people there instead of naming anyone: being listed and reviewed there is the most direct way in.
4. Look at what makes a business easy for an AI to name, from `website_checkup`: whether AI search crawlers may read the site (a fix called "Let AI assistants read your site"), whether the home page says what the business does and where in its first line, and whether reviews are on the site. Use `search` for the business's own pages that already answer common questions (prices, areas served, how long a project takes).
5. Only when the owner asks which searches to go after, and only if it is set up, use `keyword_ideas` with one to three seeds a customer would type (the kind of work and the city). It is paid: it says the cost and the month's budget. If it says it is off, say keyword research is an optional add-on in one line and carry on.
6. Give at most three moves, most direct first: get listed and reviewed where the answers point; make each key page answer one customer question in its first two sentences, with the business name and city; let AI search crawlers in.

## House style

One line on whether AI names the business, the honest note, who it named instead, then up to three moves with a time estimate.

> Claude named you in 0 of 4 answers today. It sent people to Justdial, Houzz and Google Maps instead of naming firms. (One AI model, without web search; not your Google ranking.)
> 1. Get listed on Justdial and Houzz with 10 or more reviews: an afternoon, then ask clients as projects finish.
> 2. Start the home page with "Interior architects in Raipur for homes and offices": 15 minutes.
> 3. Let AI search crawlers read the site: 15 minutes for your web person.

## Done well

- [ ] Says how often the business was named, as "in N of M answers".
- [ ] Says plainly that this is one model without web search, not a search ranking.
- [ ] Separates firms named from directories and platforms named.
- [ ] Keyword research is used only when asked and set up, with its cost shown.

## Common mistakes

- Presenting the result as "your ranking on AI" or as what all AI assistants say.
- Treating Google Maps or Justdial as a competitor.
- Spending on keyword research the owner did not ask for.

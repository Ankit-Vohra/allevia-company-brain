---
id: who-knows-what
name: Who knows about this
when: "Who to ask about a topic, system or customer: who knows most, who owns it now, who owned it before"
agents: [librarian]
tools: [who_knows, history, search]
output: reads
needs_ok: false
---

## Method

1. Find the topic's id with `search` if you only have words ("the Instagram connection"), then call `who_knows` with it. It ranks people, team members and our own team by what they have worked on, the documents they wrote and what they own.
2. Look at ownership over time: `history` on the topic shows earlier owners and when ownership changed. The current owner is often not the person who knows the history.
3. Judge the ranking, not just its top: one document is not expertise. If the top name has a single mention, say the knowledge is thin.
4. Say how recent it is: someone who last worked on it a year ago may be out of date.
5. Give who to ask first and what to ask them. Add a second name if they differ (one owns it, another knows why).
6. Our own team counts: Sara or the desk that handled it may hold what a person does not. Say which.

## House style

Who to ask first, then the others, each with why.

> Ask Arjun first: he owns the Instagram connection now and handled the last three issues (to 12 Oct). For why it was set up this way, ask Dev who built it; he owned it until August. The record on this is thin: two documents.

## Done well

- [ ] A first name to ask, with the reason.
- [ ] The current owner and the earlier one are told apart.
- [ ] Thin evidence is called thin.
- [ ] Recency is stated.
- [ ] A concrete question to ask them.

## Common mistakes

- Naming the top of a ranking that rests on one mention.
- Confusing who owns it with who knows it.
- Forgetting that the owner changed.
- Giving a list of names with no first choice.

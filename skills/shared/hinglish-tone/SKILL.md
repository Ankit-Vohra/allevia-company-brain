---
id: hinglish-tone
name: Hindi and Hinglish tone
when: "Writing or checking a post, message or ad in Hindi, or Hindi mixed with English"
agents: [content-strategist, copy-editor]
tools: [playbook, search]
output: reads
needs_ok: false
---

## Method

1. Find out what the brand does before judging anything. Look up its voice rules with `playbook` (topic "voice", and "language" or "hindi" if it returns nothing). Note three things: formal "aap" or friendly "tum/tu", Devanagari or Roman script, and how much English is normal. If the rules are silent, read two or three of the brand's own posts with `search` and copy their register. If the brand posts only in English, say so and stop: this skill does not apply.
2. Check register and agreement. One register through the whole text: "aap" goes with "kijiye, dekhiye, aaiye" and never "karo, dekho". Verbs agree with the speaker: a business speaks as "hum" (plural), so "hum banate hain", not "main banata hoon". Gendered forms must match the person addressed only when known; if not, prefer wording that avoids it ("aapka order tayyar hai").
3. Cut stiff translation. Words nobody says aloud: "सूचित करते हुए हर्ष हो रहा है", "तत्पश्चात", "उक्त". Replace with what a shopkeeper says: "ख़ुशख़बरी:", "फिर", "यह". English nouns that people really use stay English (order, delivery, offer, booking, discount, appointment); do not translate them into heavy Sanskrit words.
4. Check the mix. Hinglish works when the sentence skeleton is Hindi and the nouns are English, or the reverse, but not when each sentence flips language halfway. One language per sentence for a headline; mixing inside the body is fine if it sounds like the owner talking.
5. Check numbers and money. Indian format groups 2-digit after the first thousand: 1,25,000 and 12,50,000. Say lakh and crore in Hindi text ("1.5 लाख") and keep the rupee sign with the number (₹1,499). Never convert or round a price; copy it. Dates: day month year, month in words.
6. Check festival and greeting lines against the real date from the record (`search`), and against the brand's habit (some greet with "शुभ दीवाली", some with "Happy Diwali"). Never guess a date.
7. Mark what you cannot judge. If a phrase might be regional or you are not sure it is natural, say "not sure this reads naturally" and quote it; do not rewrite it into something you would not say yourself.

## House style

Short notes, one issue per line, quoted, with the fix: "Line 2: 'सूचित करते हुए हर्ष है' sounds like a notice. Say: 'आपके लिए ख़ुशख़बरी:'". When writing new copy, write in the script the brand uses, use the register it uses, and give a one-line Roman transliteration only if the owner reads Roman script. Keep hashtags in the language the brand's audience searches in.

> Line 1 mixes "tum" and "aap". Keep "aap": 'अपना ऑर्डर आज ही बुक कीजिए'.
> Line 3: price written as 150000. Write ₹1,50,000.

## Done well

- [ ] One register ("aap" or "tum") and one script, the brand's own, from start to end.
- [ ] No stiff translated phrases; common English nouns left in English.
- [ ] Verbs agree with who is speaking and who is addressed.
- [ ] Prices and numbers are in Indian format and exactly as recorded.
- [ ] Anything uncertain is flagged, not silently rewritten.

## Common mistakes

- Machine-translating an English caption word for word, which gives a notice, not a post.
- Switching between "aap" and "tum" in one message.
- Writing Hindi in Roman letters for a brand that posts in Devanagari, or the reverse.
- Changing a price, a date or a name while "improving" the tone.

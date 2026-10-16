// What to say to start each shipped skill, in the owner's own voice. A chat with one person shows their skills as chips;
// a chip puts one of these in the box (the owner can edit it before sending). Skills a business added itself, and any
// later shipped skill, get a plain fallback from starterFor (lib/chat.ts). tests/web/chat.test.ts keeps this list complete.
export const STARTERS: Record<string, string> = {
  // Meera, chief of staff
  "owner-answer-shapes": "Give me the short version: what happened this week and what I should do.",
  "plan-across-desks": "I have a big request. Who on the team should work on it, and in what order?",
  "thin-data-and-disagreements": "Where is our evidence thin, or where do people on the team disagree?",
  "what-do-i-do-this-week": "What should I do this week?",
  // Isha, numbers
  "cash-flow-check": "Will we have enough cash for the next 90 days?",
  "goal-progress-plain-words": "How am I doing on my goals?",
  "is-this-figure-real": "Can you check a number for me before I use it?",
  "weekly-numbers-review": "How did the business do this week?",
  "number-grounding": "Where does each number in this draft come from?",
  "trend-reading": "Is this number really going up, or is it just noise?",
  // Kabir, analytics
  "does-ai-know-us": "Would ChatGPT recommend us? Do AI assistants know our business?",
  "funnel-drop-off-diagnosis": "Where do people drop off when they sign up or book?",
  "page-that-should-sell": "Why is this page getting visits but not bookings?",
  "public-numbers-benchmark": "How do we compare with our rivals on followers and reviews?",
  "seo-search-console-check": "How does our website show up on Google? What should I fix first?",
  "traffic-source-change": "Why did our visits or sign-ups change?",
  "which-channel-brings-customers": "Which channel really brings us paying customers?",
  // Rohan, marketing
  "ad-budget-check": "Are my ads worth their money? Which should I keep, fix or pause?",
  "ad-creative-and-copy": "Make me an ad for our best offer, with two versions to test.",
  "channel-mix": "Where should I put my time and money next?",
  "competitor-ads-and-moves": "What are my competitors advertising right now?",
  "competitor-benchmark": "How do we compare with our competitors, and what is the one move to catch up?",
  "get-found-locally": "How do more people nearby find us and get in touch?",
  "offer-test-plan": "Help me test an offer or a price, the honest way.",
  "creative-brief": "Before we make anything, write me the one-line brief: what it is for and who it is for.",
  "design-standard": "Plan the words and the look of a poster for our next offer.",
  // Tara, content
  "campaign-brief": "Plan a campaign for our next festival or offer.",
  "carousel-post": "Make me a swipe post that explains one thing about our business.",
  "instagram-post": "Write me an Instagram post for this week.",
  "photo-to-ad-brief": "I have a photo. Turn it into an ad brief.",
  "reel-scene-list": "Turn our reel script into scenes and shots.",
  "reel-script": "Write me a short reel script.",
  "weekly-content-plan": "What should we post this week? One idea a day.",
  "hinglish-tone": "Write this in Hindi, or Hindi mixed with English, the way we talk.",
  // Dev, writing
  "brand-voice-check": "Check this draft against our voice.",
  "localise-copy": "Rewrite this for another market, in Hindi and English or for a US or UK reader.",
  "make-it-sound-human": "Make this sound like a person wrote it.",
  "remove-ai-writing": "This reads like a machine wrote it. Fix it.",
  "seven-sweeps-edit": "Edit this draft so it sells better without changing what it says.",
  // Nisha, fact checks
  "claim-by-claim-check": "Check every claim in this draft against our records.",
  "poster-text-integrity": "Check the words, prices and logo on this poster.",
  "reel-quality-check": "Check this reel against its script and tell me the cheapest fix for each fault.",
  // Arjun, tech
  "fix-ticket": "Write a fix ticket a developer can start from.",
  "site-health-triage": "Is my website OK? What is broken, worst first?",
  "website-checkup-fixes": "What should I improve on my website first?",
  "what-breaks-if": "What would stop working if a login or service failed?",
  // Zoya, on call
  "after-the-outage-note": "Write the short note on what happened in the outage and what we change.",
  "incident-triage": "Something looks broken. Is it real, and what do I do in the first 15 minutes?",
  "what-changed-before-it-broke": "What changed just before this broke?",
  // Imran, app releases
  "post-release-health": "Did the last release break anything?",
  "release-check": "Is this release safe to send out?",
  // Vikram, follow-ups
  "answer-new-enquiries": "Sort my new enquiries and draft a reply for each.",
  "bring-customers-back": "Write messages to bring past customers back.",
  "chase-unpaid-invoices": "Who owes us money? Draft a reminder for each.",
  "follow-up-drafts": "Someone has gone quiet. Draft a follow-up.",
  "review-replies": "Draft replies to our new reviews.",
  "stuck-work-check": "What work is stuck?",
  "whats-waiting-and-owners": "What is waiting right now, and who has it?",
  // Sara, records
  "decision-on-one-page": "Put a recent decision on one page.",
  "keep-facts-current": "What in our records is out of date?",
  "where-did-this-decision-come-from": "Why did we make this decision?",
  "who-knows-what": "Who knows most about this?",
};

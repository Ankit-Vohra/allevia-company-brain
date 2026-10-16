// The shipped skills of each person, in plain words, for the sample mode (generated from skills/ by the chat work; the live
// server reads the real packs). Name, when to use it, what it makes, and whether it waits for the owner's OK.
import type { SkillView } from "@shared/contracts";

export const MOCK_SKILLS: Record<string, Array<Pick<SkillView, "id" | "name" | "when" | "makes" | "needsOk">>> = {
  "chief-of-staff": [
    {
      "id": "owner-answer-shapes",
      "name": "Write the answer the owner reads",
      "when": "Writing the final answer for the owner, especially a why question, a status question, bad news, or a post to use",
      "makes": "the answer the owner reads, with a draft waiting for their OK when one is called for",
      "needsOk": true
    },
    {
      "id": "plan-across-desks",
      "name": "Plan a request across the team",
      "when": "A request that might need more than one person, or whose owner is not obvious, before anyone starts work",
      "needsOk": false
    },
    {
      "id": "thin-data-and-disagreements",
      "name": "When the evidence is thin or the team disagrees",
      "when": "Notes from the team conflict, are partial or were not fully checked, or the records have little on the question",
      "needsOk": false
    },
    {
      "id": "what-do-i-do-this-week",
      "name": "What to do this week",
      "when": "The owner asks what to do, focus on or fix this week, in their own words and with no particular topic",
      "makes": "a short ranked plan for the week, with drafts waiting for their OK where the team has made some",
      "needsOk": true
    }
  ],
  "coe-lead": [
    {
      "id": "cash-flow-check",
      "name": "Cash for the next 90 days",
      "when": "Will we have enough cash: rent, wages or a big bill coming up, who owes us, and the next 30, 60 and 90 days",
      "needsOk": false
    },
    {
      "id": "goal-progress-plain-words",
      "name": "Goal progress in plain words",
      "when": "Where the owner stands on each goal: where they started, where they are now, and what we are doing",
      "needsOk": false
    },
    {
      "id": "is-this-figure-real",
      "name": "Is this figure real?",
      "when": "Checking a number before the owner sees it: right meaning, right period, fresh, not a sample or too small to read",
      "needsOk": false
    },
    {
      "id": "weekly-numbers-review",
      "name": "Weekly numbers review",
      "when": "How the business did this week: the few numbers that matter, what moved, and what to do",
      "needsOk": false
    },
    {
      "id": "number-grounding",
      "name": "Number grounding",
      "when": "Tracing every figure in a draft or an analysis back to the record, with its period, source and date",
      "needsOk": false
    },
    {
      "id": "trend-reading",
      "name": "Reading a trend honestly",
      "when": "Saying whether a number is really up, down or flat, and how sure we are",
      "needsOk": false
    }
  ],
  "data-analyst": [
    {
      "id": "does-ai-know-us",
      "name": "Does AI know us",
      "when": "Would ChatGPT or Claude recommend us, do AI assistants know the business, which searches we could rank for",
      "needsOk": false
    },
    {
      "id": "funnel-drop-off-diagnosis",
      "name": "Where people drop off",
      "when": "Why fewer people finish a sign-up, booking or enquiry, and at which step they leave",
      "needsOk": false
    },
    {
      "id": "page-that-should-sell",
      "name": "Why a page is not turning visits into bookings",
      "when": "A landing page, booking page or offer page gets visits but few bookings, sign-ups or enquiries: what to change first",
      "needsOk": false
    },
    {
      "id": "public-numbers-benchmark",
      "name": "Numbers from public profiles",
      "when": "No account is connected yet, or the owner wants to compare with rivals: the public follower, rating and review numbers",
      "needsOk": false
    },
    {
      "id": "seo-search-console-check",
      "name": "Search visibility check",
      "when": "How the website shows up on Google: which pages to fix first for more visits",
      "needsOk": false
    },
    {
      "id": "traffic-source-change",
      "name": "Why visits or sign-ups changed",
      "when": "Visits or sign-ups went up or down and the owner wants to know which source explains it",
      "needsOk": false
    },
    {
      "id": "which-channel-brings-customers",
      "name": "Which channel really brings customers",
      "when": "Which of Instagram, Google, ads, WhatsApp or word of mouth brings paying customers, when the numbers from each place disagree",
      "needsOk": false
    },
    {
      "id": "trend-reading",
      "name": "Reading a trend honestly",
      "when": "Saying whether a number is really up, down or flat, and how sure we are",
      "needsOk": false
    }
  ],
  "growth-marketer": [
    {
      "id": "ad-budget-check",
      "name": "Ad budget check",
      "when": "Whether the ads are worth their money, which campaign to keep, fix or pause",
      "makes": "a proposal to pause or change an ad (when one is needed), waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "ad-creative-and-copy",
      "name": "Ad creative and copy",
      "when": "A paid ad, boosted post or poster: the picture, the headline, the copy and two versions to test",
      "makes": "an ad with picture direction, headline, copy and a second version to test, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "channel-mix",
      "name": "Where to put effort and money",
      "when": "Which channel to focus on next, what to stop, and what to test, for a small team",
      "needsOk": false
    },
    {
      "id": "competitor-ads-and-moves",
      "name": "What competitors are advertising",
      "when": "The owner asks what a rival is advertising or doing to win customers, or wants to watch two or three rivals",
      "needsOk": false
    },
    {
      "id": "competitor-benchmark",
      "name": "Competitor and industry benchmark",
      "when": "How the business compares with its competitors or its industry, and the one catch-up move",
      "needsOk": false
    },
    {
      "id": "get-found-locally",
      "name": "Get found by local customers",
      "when": "How do more people nearby find us on Google, Maps and AI assistants, and contact us",
      "needsOk": false
    },
    {
      "id": "offer-test-plan",
      "name": "Offer test plan",
      "when": "Trying an offer, price or message honestly: one question, one change, a clear way to judge it",
      "makes": "a one-page test plan for an offer or message, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "creative-brief",
      "name": "Purpose first (the one-line brief)",
      "when": "Before any post, reel, ad, poster or campaign: what it is for, what it sells, to whom, and the one action",
      "makes": "a one-line brief stating what the piece is made to do, and up to three quick questions when something that matters is unknown",
      "needsOk": true
    },
    {
      "id": "design-standard",
      "name": "Posters, ads and reels to an agency standard",
      "when": "Planning the words, the pictures and the layout of any poster, ad, story or reel before it is made, and judging one after",
      "makes": "a creative plan (the words, the real pictures to use, the layout and why) ready for the poster or reel tool, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "trend-reading",
      "name": "Reading a trend honestly",
      "when": "Saying whether a number is really up, down or flat, and how sure we are",
      "needsOk": false
    }
  ],
  "content-strategist": [
    {
      "id": "campaign-brief",
      "name": "Festival or offer campaign plan",
      "when": "A plan for a festival, season, launch or offer (Diwali, Eid, Christmas, Black Friday, Mother's Day): timeline, offer, posts, what to measure",
      "makes": "a campaign plan with an offer, a day-by-day timeline, a posting rhythm, the pictures and copy needed, and how to judge it",
      "needsOk": true
    },
    {
      "id": "carousel-post",
      "name": "Swipe post (carousel) craft",
      "when": "A post people swipe through, slide by slide: steps, a list, a before and after, or myth versus fact",
      "makes": "a slide-by-slide swipe post with the text for each slide, a caption and hashtags",
      "needsOk": true
    },
    {
      "id": "instagram-post",
      "name": "Instagram post craft",
      "when": "A caption for an Instagram photo or carousel post that sounds like the brand and fits what has worked before",
      "makes": "a ready-to-post caption with hashtags and a line describing the photo",
      "needsOk": true
    },
    {
      "id": "photo-to-ad-brief",
      "name": "Photo-to-ad brief",
      "when": "The owner sends a photo (product, finished project, dish, room) and wants an ad or poster made from it",
      "makes": "a one-page ad brief a designer or the studio can build from, with headline, offer, sizes and what must not change in the photo",
      "needsOk": true
    },
    {
      "id": "reel-scene-list",
      "name": "Reel scenes and shot list",
      "when": "Turning an approved reel script into scenes and shots: who, where, what each shot shows, and the words put on screen",
      "makes": "a scene-by-scene shot list with the set, the people, the on-screen words and the real screens to insert",
      "needsOk": true
    },
    {
      "id": "reel-script",
      "name": "Reel script craft",
      "when": "A short video script (15 to 45 seconds) with timed beats, words, on-screen text and what to film",
      "makes": "a timed reel script with on-screen text, filming directions, a caption and an audio note",
      "needsOk": true
    },
    {
      "id": "weekly-content-plan",
      "name": "A week of posts (content plan)",
      "when": "What to post this week or this month: themes, one idea per day, the hook for each, and which format, from what has worked here",
      "makes": "a day-by-day posting plan for a week with the theme, format, hook and caption line for each post",
      "needsOk": true
    },
    {
      "id": "creative-brief",
      "name": "Purpose first (the one-line brief)",
      "when": "Before any post, reel, ad, poster or campaign: what it is for, what it sells, to whom, and the one action",
      "makes": "a one-line brief stating what the piece is made to do, and up to three quick questions when something that matters is unknown",
      "needsOk": true
    },
    {
      "id": "design-standard",
      "name": "Posters, ads and reels to an agency standard",
      "when": "Planning the words, the pictures and the layout of any poster, ad, story or reel before it is made, and judging one after",
      "makes": "a creative plan (the words, the real pictures to use, the layout and why) ready for the poster or reel tool, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "hinglish-tone",
      "name": "Hindi and Hinglish tone",
      "when": "Writing or checking a post, message or ad in Hindi, or Hindi mixed with English",
      "needsOk": false
    }
  ],
  "copy-editor": [
    {
      "id": "brand-voice-check",
      "name": "Brand voice check",
      "when": "Checking a draft (post, caption, script, message) against this business's own voice rules",
      "needsOk": false
    },
    {
      "id": "localise-copy",
      "name": "Localise copy for the market",
      "when": "Copy for a different language or market: Hindi and English together, or US, UK, UAE or Australian readers",
      "needsOk": false
    },
    {
      "id": "make-it-sound-human",
      "name": "Make it sound human",
      "when": "Any text the owner or their customers will read (an answer, a caption, a note, poster text) sounds machine-written",
      "needsOk": false
    },
    {
      "id": "remove-ai-writing",
      "name": "Remove AI-sounding writing",
      "when": "A draft reads like a machine wrote it: stock openers, padded lists, big empty words",
      "needsOk": false
    },
    {
      "id": "seven-sweeps-edit",
      "name": "Seven-sweep copy edit",
      "when": "Making a draft sell better without changing what it says: a page, an offer, an email, an ad or a caption that reads flat or vague",
      "needsOk": false
    },
    {
      "id": "hinglish-tone",
      "name": "Hindi and Hinglish tone",
      "when": "Writing or checking a post, message or ad in Hindi, or Hindi mixed with English",
      "needsOk": false
    }
  ],
  "fact-checker": [
    {
      "id": "claim-by-claim-check",
      "name": "Claim-by-claim fact check",
      "when": "Checking every name, date, number and claim in a draft against what the business's records hold",
      "needsOk": false
    },
    {
      "id": "poster-text-integrity",
      "name": "Poster text and logo check",
      "when": "Checking the words, prices, contact details and logo on a poster, ad or generated image before the owner sees it",
      "needsOk": false
    },
    {
      "id": "reel-quality-check",
      "name": "Reel quality check and repair plan",
      "when": "A reel or video cut is ready: check it against its script and say the cheapest fix for each fault",
      "needsOk": false
    },
    {
      "id": "number-grounding",
      "name": "Number grounding",
      "when": "Tracing every figure in a draft or an analysis back to the record, with its period, source and date",
      "needsOk": false
    }
  ],
  "tech-lead": [
    {
      "id": "fix-ticket",
      "name": "Write a fix ticket",
      "when": "A problem needs a developer: write a ticket they can start from without asking questions",
      "makes": "a fix ticket with the problem, evidence, owner and how to know it is fixed, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "site-health-triage",
      "name": "Website health check",
      "when": "Is the website OK: can customers do the one thing it is for, and what is broken, in order of harm",
      "needsOk": false
    },
    {
      "id": "website-checkup-fixes",
      "name": "What to fix on the website first",
      "when": "What should I improve on my website, why is it not bringing enquiries, is my site any good",
      "makes": "the top five website fixes in plain words, and for titles, descriptions or the headline, the new text ready to paste, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "what-breaks-if",
      "name": "What breaks if this stops",
      "when": "What would stop working if a login, token, service or page failed or expired, and what to do before it does",
      "needsOk": false
    }
  ],
  "oncall-engineer": [
    {
      "id": "after-the-outage-note",
      "name": "After an outage, what happened and what we change",
      "when": "The site or app was down or broken and is fixed: a short, blame-free note on what happened, who was hit, why, and what changes",
      "makes": "a one-page note on an outage with a timeline, the cause, and dated follow-ups with owners, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "incident-triage",
      "name": "Triage an error or outage",
      "when": "A new error, crash spike or outage: is it real, how big, who owns it, and what to do in the first 15 minutes",
      "needsOk": false
    },
    {
      "id": "what-changed-before-it-broke",
      "name": "What changed before it broke",
      "when": "Tie a problem to the change that came just before it: a release, a setting, a token, an owner",
      "needsOk": false
    },
    {
      "id": "fix-ticket",
      "name": "Write a fix ticket",
      "when": "A problem needs a developer: write a ticket they can start from without asking questions",
      "makes": "a fix ticket with the problem, evidence, owner and how to know it is fixed, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "trend-reading",
      "name": "Reading a trend honestly",
      "when": "Saying whether a number is really up, down or flat, and how sure we are",
      "needsOk": false
    }
  ],
  "qa-release": [
    {
      "id": "post-release-health",
      "name": "Did the last release break anything?",
      "when": "After an app update: did crashes, errors or ratings get worse, and whether to hold, hotfix or roll back",
      "needsOk": false
    },
    {
      "id": "release-check",
      "name": "Release readiness check",
      "when": "Is this app release safe to send out: what changed, what must be tried first, go or hold",
      "needsOk": false
    },
    {
      "id": "fix-ticket",
      "name": "Write a fix ticket",
      "when": "A problem needs a developer: write a ticket they can start from without asking questions",
      "makes": "a fix ticket with the problem, evidence, owner and how to know it is fixed, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "trend-reading",
      "name": "Reading a trend honestly",
      "when": "Saying whether a number is really up, down or flat, and how sure we are",
      "needsOk": false
    }
  ],
  "ops-manager": [
    {
      "id": "answer-new-enquiries",
      "name": "Answer new enquiries fast",
      "when": "New enquiries from the website, WhatsApp, Instagram or email are waiting: sort them and have a reply ready for each before they go cold",
      "makes": "a sorted list of new enquiries with a short reply ready for each, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "bring-customers-back",
      "name": "Bring customers back (email, WhatsApp, referrals)",
      "when": "Getting past customers to come again or bring a friend: welcome, thank-you, win-back and refer-a-friend messages by email, WhatsApp or text",
      "makes": "a short series of follow-up messages (email, WhatsApp or text) with when each one goes out, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "chase-unpaid-invoices",
      "name": "Chase unpaid invoices",
      "when": "Who owes us money and a reminder for each, in the right tone: gentle for good payers, firm for repeat late payers",
      "makes": "a list of who owes what with one reminder per customer, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "follow-up-drafts",
      "name": "Follow-up message drafts",
      "when": "A customer, supplier or teammate has gone quiet and the owner wants a follow-up message ready to send",
      "makes": "a short follow-up message ready to send, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "review-replies",
      "name": "Replies to customer reviews",
      "when": "New Google, Facebook or app store reviews, or a complaint: a short reply to each in the owner's voice, and what the reviews keep saying",
      "makes": "a short public reply for each review and the two or three things customers keep mentioning, waiting for the owner's OK",
      "needsOk": true
    },
    {
      "id": "stuck-work-check",
      "name": "Find stuck work",
      "when": "What has stalled: no owner, no movement for too long, or blocked by something else that is stuck",
      "needsOk": false
    },
    {
      "id": "whats-waiting-and-owners",
      "name": "What is waiting and who owns it",
      "when": "What is pending right now, who has it, how long it has waited, and what costs most to leave",
      "needsOk": false
    }
  ],
  "librarian": [
    {
      "id": "decision-on-one-page",
      "name": "A decision on one page",
      "when": "Setting out a past or recent decision in a standard shape: the question, the options, what was chosen and why, and what it costs",
      "needsOk": false
    },
    {
      "id": "keep-facts-current",
      "name": "Keep facts current",
      "when": "What in our records is out of date, contradicts something else or has no source, and what to confirm with the owner",
      "needsOk": false
    },
    {
      "id": "where-did-this-decision-come-from",
      "name": "Where did this decision come from",
      "when": "Why did we pause, stop, choose or change something: the story, the evidence, who decided, and whether it still holds",
      "needsOk": false
    },
    {
      "id": "who-knows-what",
      "name": "Who knows about this",
      "when": "Who to ask about a topic, system or customer: who knows most, who owns it now, who owned it before",
      "needsOk": false
    }
  ]
};

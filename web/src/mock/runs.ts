// Scripted runs for mock mode. Timed so a whole run takes ~20–32 s at 1×, like a real multi-agent turn.
import type { ScriptSpec } from "./script";

const D007 = "decision:007-pause-daily-posts-and-stories";
const OBS_SP = "observation:ig-stories-posts-reach-2026-09-28";
const OBS_REELS = "observation:ig-reels-reach-share-2026-09-28";
const OBS_HOOKS = "observation:hook-performance-90d-2026-10-14";

export const storiesRun: ScriptSpec = {
  tenant: "aamdani",
  key: "stories",
  question: "Why did we pause daily stories, and what should we post instead?",
  match: /stor|post|reel|content|instagram|hook|brief|idea/i,
  build: (s) => {
    const meera = s.track("chief-of-staff", 300);
    meera
      .emit({
        type: "recall",
        brief: "Earlier thread (2 Oct): 'How many reels a week can we sustain?' settled on 3 a week. The owner prefers Hindi-first captions.",
        ids: ["turn:2026-10-02-reel-cadence", "memory:prefers-hindi-first"],
      })
      .start("Read the request and plan who does what", 400)
      .status("Reading the question and what we already know", 200)
      .tool("search", { q: "pause daily stories" }, 800, "4 matches: decision 007, Instagram and 2 observations from 28 Sep", [D007, "channel:instagram", OBS_SP, OBS_REELS], 600)
      .status("Splitting the work: history to Memory Keeper, numbers to Data Detective, briefs to Miss Influencer", 400)
      .emit({
        type: "plan",
        by: "chief-of-staff",
        rationale: "A 'why' plus a 'what next'. The Library traces the decision, Analytics finds which hooks work, the Content Studio turns that into briefs, and the CoE checks every figure.",
        steps: [
          { agent: "librarian", task: "Trace decision 007: who paused daily posts and stories, when, and on what evidence" },
          { agent: "data-analyst", task: "Rank our reel hooks by reach over the last 90 days" },
          { agent: "content-strategist", task: "Write 3 reel briefs for job seekers and employers from what worked", after: ["librarian", "data-analyst"] },
          { agent: "copy-editor", task: "Voice check on the 3 briefs", after: ["content-strategist"] },
          { agent: "fact-checker", task: "Check every claim in the briefs against the graph", after: ["content-strategist"] },
          { agent: "coe-lead", task: "Confirm every figure before it reaches the owner", after: ["data-analyst", "fact-checker"] },
        ],
      }, 700)
      .handoff("librarian", "Why did we pause daily posts and stories?", 300)
      .handoff("data-analyst", "Which hooks worked over the last 90 days?", 120)
      .done(3400, 300);

    s.track("librarian", 4300)
      .start("Trace decision 007: who paused daily posts and stories, when, and on what evidence")
      .status("Opening decision 007 in the vault")
      .tool("trace_decision", { id: D007 }, 1400,
        "Decided 28 Sep 2026 by the founder. Based on 2 Instagram observations (24 accounts per story or post; reels 97% of reach). Affects Instagram. Nothing supersedes it.",
        [D007, "person:founder", OBS_SP, OBS_REELS, "channel:instagram", "document:vault-decision-007", "document:ig-insights-2026-09-28"], 600)
      .status("Checking nothing has changed since", 400)
      .tool("history", { id: "channel:instagram" }, 900,
        "Instagram status went from 'daily posts, stories and reels' to 'reels-only' on 28 Sep 2026; followers 702 → 1,184.",
        ["channel:instagram", D007, "document:vault-marketing-strategy"], 400)
      .finding("f-sara-007",
        `On 28 Sep 2026 the founder paused daily feed posts and stories and kept reels only [[${D007}]]. Stories and posts were reaching about 24 accounts each [[${OBS_SP}]], while reels brought 97% of Instagram reach [[${OBS_REELS}]]. Nothing has superseded the decision.`, undefined, 600)
      .handoff("content-strategist", "Reels only since 28 Sep; stories reached ~24 accounts", 400)
      .done(5300, 300);

    s.track("data-analyst", 4400)
      .start("Rank our reel hooks by reach over the last 90 days")
      .status("Pulling reach and saves for every reel since July")
      .tool("content_performance", { channel: "channel:instagram", window: "90d", by: "hook" }, 1800,
        "18 reels across 4 hook formulas. Salary reveal 3.4× median reach; day in the life 2.1×; question to camera 0.6×. Median reach 2,140.",
        [OBS_HOOKS, "rule:hook-salary-reveal", "rule:hook-day-in-the-life", "rule:hook-question-to-camera", "content:reel-2026-09-12-forklift-salary", "content:reel-2026-10-03-delivery-salary", "content:reel-2026-09-20-warehouse-day", "content:reel-2026-09-25-interview-question", "channel:instagram", "document:content-report-2026-10-14"], 700)
      .status("Comparing with weekly reach", 500)
      .tool("metric_trend", { metric: "reach", subject: "channel:instagram", weeks: 6 }, 900,
        "Weekly Instagram reach rose to 18,420 in week 41.", ["observation:ig-reach-wk41", "metric:reach", "channel:instagram"], 400)
      .finding("f-kabir-hooks",
        `Over 90 days (18 reels), salary-reveal hooks got 3.4× our median reach and day-in-the-life hooks 2.1×; question-to-camera hooks got 0.6× [[${OBS_HOOKS}]] [[rule:hook-salary-reveal]] [[rule:hook-day-in-the-life]]. Our best reel opens on a salary figure [[content:reel-2026-09-12-forklift-salary]].`, undefined, 800)
      .handoff("content-strategist", "Lead with salary reveal and day in the life", 300)
      .handoff("coe-lead", "Hook figures for a numbers check", 120)
      .done(5900, 200);

    s.track("content-strategist", 10700)
      .start("Write 3 reel briefs for job seekers and employers from what worked")
      .status("Reading who our audiences are and what they need")
      .tool("neighbors", { id: "audience:employers", rels: ["HAS_NEED", "TARGETS"], hops: 2 }, 900,
        "Employers need to fill a role within a week and see only screened candidates. Seekers need the real salary and jobs near home.",
        ["audience:employers", "audience:job-seekers", "need:employers-fast-hiring", "need:employers-screened", "need:seekers-real-salary", "need:seekers-nearby-jobs", "feature:ai-screening-call", "product:aamdani-app"], 400)
      .tool("playbook", { topic: "instagram hooks", industry: "jobs" }, 800,
        "4 hook formulas and 3 brand rules apply: plain Hinglish, no fake urgency, real workers only.",
        ["playbook:instagram-hooks", "rule:hook-salary-reveal", "rule:hook-day-in-the-life", "brandrule:voice-plain-hinglish", "brandrule:no-fake-urgency", "brandrule:real-workers"], 300)
      .status("Drafting 3 briefs: 2 for seekers, 1 for employers", 300)
      .finding("f-tara-briefs",
        `1. Seekers · Salary reveal: "₹18,000 + PF: a forklift operator's real month" [[content:reel-2026-09-12-forklift-salary]]. 2. Seekers · Salary reveal: "What a delivery partner takes home" [[need:seekers-real-salary]]. 3. Employers · Day in the life: "From job post to a screened shortlist", one employer and the AI screening call [[feature:ai-screening-call]] [[need:employers-screened]].`,
        ["f-sara-007", "f-kabir-hooks"], 2600)
      .handoff("copy-editor", "3 briefs for a voice check", 300)
      .handoff("fact-checker", "3 briefs for a claim check", 100)
      .done(6200, 200);

    s.track("copy-editor", 17100)
      .start("Voice check on the 3 briefs")
      .status("Holding the briefs to plain Hinglish")
      .tool("playbook", { topic: "brand voice" }, 700,
        "Voice rules: plain Hinglish, no fake urgency, real workers only; 24 AI-writing patterns to strip.",
        ["brandrule:voice-plain-hinglish", "brandrule:no-fake-urgency", "brandrule:real-workers", "playbook:avoid-ai-writing", "document:brand-voice"], 300)
      .status("Swapped 'unlock your dream job' for 'naukri jo ghar ke paas ho'", 900)
      .review("f-tara-briefs", "ok", "Voice holds. One hook line rewritten; no AI-sounding phrases left.", 1000)
      .done(3300, 200);

    s.track("fact-checker", 17200)
      .start("Check every claim in the briefs against the graph")
      .status("Listing the claims: 4 across 3 briefs")
      .tool("find_paths", { from: "content:reel-2026-09-12-forklift-salary", to: "rule:hook-salary-reveal", max: 3 }, 900,
        "Every claim traces to a reel, an observation or a feature: 4 of 4 grounded.",
        ["content:reel-2026-09-12-forklift-salary", "rule:hook-salary-reveal", OBS_HOOKS, "feature:ai-screening-call", "need:employers-screened"], 500)
      .status("₹18,000 + PF matches the forklift reel", 800)
      .review("f-tara-briefs", "ok", "All 4 claims trace to the graph.", 1000)
      .done(3600, 200);

    s.track("coe-lead", 21100)
      .start("Confirm every figure before it reaches the owner")
      .status("Re-reading the 90-day hook numbers")
      .tool("metric_trend", { metric: "reach_multiple", subject: "rule:hook-salary-reveal", window: "90d" }, 900,
        "Salary reveal 3.4×, day in the life 2.1×, question to camera 0.6× of the 2,140 median. Reels were 97% of reach and stories 24 accounts on 28 Sep.",
        [OBS_HOOKS, OBS_REELS, OBS_SP, "metric:reach"], 400)
      .review("f-kabir-hooks", "ok", "3.4×, 2.1× and 0.6× match the 90-day observation.", 400)
      .review("f-sara-007", "ok", "24 accounts and 97% match the 28 Sep snapshot.", 300)
      .done(2500, 200);

    s.track("chief-of-staff", 23900)
      .start("Write the answer from 3 checked findings")
      .status("Writing the answer", 300)
      .stream(
        `**We paused daily posts and stories on 28 Sep 2026 because almost no one saw them.** Stories and feed posts reached about 24 accounts each, while reels brought 97% of our Instagram reach [[${D007}]] [[${OBS_SP}]] [[${OBS_REELS}]].

**Post reels that open on a real salary or follow a real shift.** Over the last 90 days (18 reels), salary-reveal hooks got 3.4× our median reach and day-in-the-life hooks 2.1×. Question-to-camera hooks got 0.6×, so drop them [[${OBS_HOOKS}]] [[rule:hook-salary-reveal]].

Three briefs, checked by Wordsmith for voice and Fact Checker for facts:

1. **Seekers · "₹18,000 + PF: a forklift operator's real month."** Open on the payslip, then the shift. Same hook as our best reel [[content:reel-2026-09-12-forklift-salary]].
2. **Seekers · "What a delivery partner takes home."** Salary reveal, Hindi first, English captions [[need:seekers-real-salary]].
3. **Employers · "From job post to a screened shortlist."** A day with one employer and the AI screening call [[feature:ai-screening-call]] [[need:employers-screened]].

**Next:** approve the content draft below and the reel pipeline will script all three. Figures as of 14 Oct 2026.`,
        55, 300)
      .tool("show_path", { ids: ["person:founder", D007, OBS_REELS, "channel:instagram", "content:reel-2026-09-12-forklift-salary", "rule:hook-salary-reveal", OBS_HOOKS] }, 300,
        "Path of 7 nodes linked.", ["person:founder", D007, OBS_REELS, "channel:instagram", "content:reel-2026-09-12-forklift-salary", "rule:hook-salary-reveal", OBS_HOOKS], 300)
      .path(["person:founder", D007, OBS_REELS, "channel:instagram", "content:reel-2026-09-12-forklift-salary", "rule:hook-salary-reveal", OBS_HOOKS], 100)
      .emit({ type: "proposal", agent: "chief-of-staff", recommendationId: "rec:salary-reveal-reels", approvalId: "appr:content-3-reels", title: "Draft 3 reels: two salary reveals and a day with the screening call", kind: "content_draft" }, 400)
      .done(8100, 300);
  },
};

const GSC = "observation:gsc-jobs-clicks-2026-10";

export const seoRun: ScriptSpec = {
  tenant: "aamdani",
  key: "seo",
  question: "Which pages are losing search clicks, and why?",
  match: /seo|search|google|page|click|rank|traffic|website/i,
  build: (s) => {
    s.track("chief-of-staff", 300)
      .start("Read the request and plan who does what")
      .status("Reading the question and what we already know", 200)
      .tool("search", { q: "search clicks pages" }, 700, "Search Console export from 13 Oct and 5 job pages", [GSC, "page:www.aamdani.ai/jobs", "document:gsc-export-2026-10-13"], 500)
      .emit({
        type: "plan", by: "chief-of-staff",
        rationale: "Numbers from Analytics, the technical cause from Tech, and a second look at the figures from the CoE.",
        steps: [
          { agent: "data-analyst", task: "Find which pages lost search clicks in the last 28 days" },
          { agent: "tech-lead", task: "Audit the losing pages against the SEO checks" },
          { agent: "coe-lead", task: "Confirm the click figures", after: ["data-analyst"] },
        ],
      }, 600)
      .handoff("data-analyst", "Which pages lost clicks?", 300)
      .handoff("tech-lead", "Why are job pages slipping?", 120)
      .done(2600, 200);

    s.track("data-analyst", 3400)
      .start("Find which pages lost search clicks in the last 28 days")
      .status("Comparing the last 28 days with the 28 before")
      .tool("seo_report", { pages: "/jobs/*", window: "28d", compare: "previous" }, 1700,
        "job pages: 1,930 clicks vs 2,610 (−26%). Impressions steady at 214,000; CTR 0.9%. The drop starts after the 18 Sep core update.",
        [GSC, "observation:gsc-jobs-clicks-prev", "page:www.aamdani.ai/jobs", "page:www.aamdani.ai/jobs/raipur/driver", "page:www.aamdani.ai/jobs/bhilai/security-guard", "query:driver-job-raipur", "query:security-guard-job-near-me", "event:google-core-update-2026-09", "document:gsc-export-2026-10-13"], 600)
      .finding("f-kabir-gsc",
        `The job pages lost 26% of search clicks: 2,610 → 1,930 in 28 days, while impressions held at 214,000 [[${GSC}]] [[observation:gsc-jobs-clicks-prev]]. People still see us; fewer click. The slide starts after Google's 18 Sep core update [[event:google-core-update-2026-09]].`, undefined, 900)
      .handoff("coe-lead", "Click figures for a check", 300)
      .done(4200, 200);

    s.track("tech-lead", 3500)
      .start("Audit the losing pages against the SEO checks")
      .status("Opening /jobs/raipur/driver")
      .tool("get_entity", { id: "page:www.aamdani.ai/jobs/raipur/driver" }, 900,
        "No meta description; title shared with 37 other city pages.",
        ["page:www.aamdani.ai/jobs/raipur/driver", "rule:seo-meta-description-missing", "rule:seo-duplicate-title", "page:www.aamdani.ai/jobs"], 500)
      .tool("impact_of", { id: "rule:seo-meta-description-missing" }, 1100,
        "38 job pages fail this check; they carry 71% of /jobs impressions. Issue #41 is open and unassigned.",
        ["rule:seo-meta-description-missing", "page:www.aamdani.ai/jobs/raipur/driver", "page:www.aamdani.ai/jobs/bhilai/security-guard", "task:github-41-jobs-meta", "playbook:open-seo-audit"], 400)
      .finding("f-arjun-meta",
        `38 city × role pages have no meta description and share one title, so Google writes its own snippet [[rule:seo-meta-description-missing]] [[page:www.aamdani.ai/jobs/raipur/driver]]. They carry 71% of /jobs impressions. Issue #41 is open but unassigned [[task:github-41-jobs-meta]].`, undefined, 900)
      .handoff("chief-of-staff", "Fix: unique titles and meta descriptions", 300)
      .done(4600, 200);

    s.track("coe-lead", 8400)
      .start("Confirm the click figures")
      .tool("metric_trend", { metric: "clicks", subject: "page:www.aamdani.ai/jobs", window: "56d" }, 900,
        "2,610 → 1,930 clicks (−26%), impressions 214,000, CTR 0.9%: matches the 13 Oct export.", [GSC, "observation:gsc-jobs-clicks-prev", "metric:clicks"], 400)
      .review("f-kabir-gsc", "ok", "−26% and 214,000 impressions match the export.", 500)
      .done(1900, 200);

    s.track("chief-of-staff", 10700)
      .start("Write the answer from 2 checked findings")
      .status("Writing the answer", 300)
      .stream(
        `**The job pages are losing clicks, not rankings.** Clicks fell 26% (2,610 → 1,930) over the last 28 days while impressions held at 214,000 [[${GSC}]] [[observation:gsc-jobs-clicks-prev]].

**Why:** 38 city × role pages have no meta description and share one title, so Google writes a generic snippet and fewer people click [[rule:seo-meta-description-missing]] [[page:www.aamdani.ai/jobs/raipur/driver]]. The slide began after the 18 Sep core update [[event:google-core-update-2026-09]].

**Next:** approve the GitHub issue below. It assigns #41 with a title and description template for all 38 pages [[task:github-41-jobs-meta]]. Figures as of 13 Oct 2026.`, 70, 300)
      .path(["event:google-core-update-2026-09", "channel:google-search", "page:www.aamdani.ai/jobs", "page:www.aamdani.ai/jobs/raipur/driver", "rule:seo-meta-description-missing"], 400)
      .emit({ type: "proposal", agent: "chief-of-staff", recommendationId: "rec:jobs-meta", approvalId: "appr:gh-jobs-meta", title: "Unique titles and meta descriptions for 38 job pages", kind: "github_issue" }, 400)
      .done(6200, 300);
  },
};

export const pendingRun: ScriptSpec = {
  tenant: "aamdani",
  key: "pending",
  question: "What is waiting on me this week?",
  match: /pending|waiting|owner|own|approv|todo|task|week/i,
  build: (s) => {
    s.track("chief-of-staff", 300)
      .start("Read the request and plan who does what")
      .status("Reading the question", 200)
      .emit({
        type: "plan", by: "chief-of-staff", rationale: "Ops knows what's open; Analytics says which item costs the most.",
        steps: [
          { agent: "ops-manager", task: "List everything the owner owns that is still open" },
          { agent: "data-analyst", task: "Size the cost of each open item", after: ["ops-manager"] },
        ],
      }, 900)
      .handoff("ops-manager", "What's open on the founder?", 300)
      .done(1700, 200);

    s.track("ops-manager", 2200)
      .start("List everything the owner owns that is still open")
      .status("Reading PENDING and open GitHub issues")
      .tool("who_owns", { person: "person:founder", status: "open" }, 1200,
        "3 open items: employer reel series (PENDING), sign-up code fallback to WhatsApp (PENDING), #41 jobs meta descriptions.",
        ["person:founder", "task:pending-employer-reels", "task:pending-otp-fallback", "task:github-41-jobs-meta"], 500)
      .finding("f-vikram-open",
        `3 things wait on you: the employer reel series [[task:pending-employer-reels]], the sign-up code fallback to WhatsApp [[task:pending-otp-fallback]], and issue #41 [[task:github-41-jobs-meta]].`, undefined, 700)
      .handoff("data-analyst", "Which of these costs the most?", 300)
      .done(3000, 200);

    s.track("data-analyst", 5800)
      .start("Size the cost of each open item")
      .tool("metric_trend", { metric: "funnel_drop", subject: "product:aamdani-app" }, 1100,
        "41% of signups drop at the sign-up code step this week; 312 signups in week 41.",
        ["observation:funnel-otp-drop-2026-10", "observation:signups-wk41", "product:aamdani-app", "task:pending-otp-fallback"], 500)
      .finding("f-kabir-otp", `The sign-up code step loses 41% of people who start signing up [[observation:funnel-otp-drop-2026-10]]; 312 still finished in week 41 [[observation:signups-wk41]].`, undefined, 700)
      .handoff("chief-of-staff", "sign-up code fallback first", 300)
      .done(2900, 200);

    s.track("chief-of-staff", 9100)
      .start("Write the answer")
      .stream(
        `**Three things wait on you; do the sign-up code fallback first.** 41% of people who start signing up drop at the sign-up code step [[observation:funnel-otp-drop-2026-10]] [[task:pending-otp-fallback]].

- Employer reel series, still in PENDING [[task:pending-employer-reels]]
- Issue #41, unique meta descriptions for job pages [[task:github-41-jobs-meta]]

As of 12 Oct 2026.`, 70, 300)
      .path(["person:founder", "task:pending-otp-fallback", "observation:funnel-otp-drop-2026-10", "product:aamdani-app"], 400)
      .done(4200, 300);
  },
};

const AVS_GSC = "observation:gsc-architect-raipur-2026-10";
const HOME = "page:avsatelier.in/";

export const avsRun: ScriptSpec = {
  tenant: "avs-atelier",
  key: "avs-seo",
  question: "Why don't we show up when people search 'architect in Raipur'?",
  match: /.*/,
  build: (s) => {
    s.track("chief-of-staff", 300)
      .emit({ type: "recall", brief: "Onboarded today from avsatelier.in. No earlier threads.", ids: ["document:crawl-avsatelier-2026-10-15"] })
      .start("Read the request and plan who does what", 300)
      .status("Reading the question and what we already know", 200)
      .tool("search", { q: "architect in raipur" }, 700, "The query, the home page and a Search Console observation", ["query:architect-in-raipur", HOME, AVS_GSC], 500)
      .emit({
        type: "plan", by: "chief-of-staff",
        rationale: "Analytics measures where we stand, Tech finds what the page is missing, Marketing turns it into ranked fixes; the CoE and the fact checker check them.",
        steps: [
          { agent: "data-analyst", task: "Where do we rank for 'architect in raipur', and how many people see us?" },
          { agent: "tech-lead", task: "Audit the home page against the SEO checks" },
          { agent: "growth-marketer", task: "Rank the fixes by expected effect", after: ["data-analyst", "tech-lead"] },
          { agent: "coe-lead", task: "Check the search figures", after: ["data-analyst"] },
          { agent: "fact-checker", task: "Check the fixes' claims", after: ["growth-marketer"] },
        ],
      }, 700)
      .handoff("data-analyst", "Where do we rank?", 300)
      .handoff("tech-lead", "What is the home page missing?", 120)
      .done(3000, 200);

    s.track("data-analyst", 3700)
      .start("Where do we rank for 'architect in raipur', and how many people see us?")
      .status("Reading Search Console for the last 28 days")
      .tool("seo_report", { query: "architect in raipur", window: "28d" }, 1500,
        "1,240 impressions, 5 clicks, average position 18.6: page 2 of Google.", [AVS_GSC, "query:architect-in-raipur", HOME, "document:gsc-avs-2026-10-14"], 600)
      .finding("f-kabir-avs", `We sit on page 2 for "architect in raipur": average position 18.6, 1,240 impressions and 5 clicks in 28 days [[${AVS_GSC}]] [[query:architect-in-raipur]].`, undefined, 800)
      .handoff("growth-marketer", "Page 2, position 18.6", 300)
      .handoff("coe-lead", "Figures for a check", 120)
      .done(4000, 200);

    s.track("tech-lead", 3800)
      .start("Audit the home page against the SEO checks")
      .status("Crawling avsatelier.in")
      .tool("get_entity", { id: HOME }, 1100,
        "Title is 'Home', no H1, no LocalBusiness schema; mobile LCP 3.8 s.",
        [HOME, "rule:seo-missing-h1", "rule:seo-generic-title", "rule:seo-no-localbusiness-schema", "rule:seo-slow-lcp", "observation:lcp-home-2026-10", "document:crawl-avsatelier-2026-10-15"], 500)
      .finding("f-arjun-avs", `The home page fails 4 checks: the title is "Home", there is no H1, no LocalBusiness schema, and mobile LCP is 3.8 s [[rule:seo-generic-title]] [[rule:seo-missing-h1]] [[rule:seo-no-localbusiness-schema]] [[observation:lcp-home-2026-10]].`, undefined, 900)
      .handoff("growth-marketer", "4 failing checks on the home page", 300)
      .done(3600, 200);

    s.track("growth-marketer", 8600)
      .start("Rank the fixes by expected effect")
      .status("Weighing each fix against local search")
      .tool("playbook", { topic: "local seo", industry: "architecture" }, 900,
        "Open SEO audit: title and H1 first for local intent; LocalBusiness schema with a verified Google Business Profile next; speed last.",
        ["playbook:open-seo-audit", "rule:seo-generic-title", "rule:seo-missing-h1", "rule:seo-no-localbusiness-schema", "channel:google-business-profile", "task:avs-gbp-verify"], 500)
      .finding("f-rohan-avs", `Fix in this order: 1) title and H1 "Architects in Raipur · AVS Atelier" [[rule:seo-generic-title]]; 2) LocalBusiness schema and verify the Google Business Profile [[channel:google-business-profile]]; 3) compress the hero image to get LCP under 2.5 s [[rule:seo-slow-lcp]].`, ["f-kabir-avs", "f-arjun-avs"], 1400)
      .handoff("fact-checker", "Ranked fixes for a claim check", 300)
      .done(3600, 200);

    s.track("coe-lead", 8200)
      .start("Check the search figures")
      .tool("metric_trend", { metric: "search_performance", subject: "query:architect-in-raipur" }, 800, "Position 18.6, 1,240 impressions, 5 clicks: matches the 14 Oct export.", [AVS_GSC, "query:architect-in-raipur"], 400)
      .review("f-kabir-avs", "ok", "18.6 and 1,240 match the export.", 400)
      .done(1800, 200);

    s.track("fact-checker", 12600)
      .start("Check the fixes' claims")
      .tool("find_paths", { from: HOME, to: "rule:seo-no-localbusiness-schema" }, 800, "Each fix links to a failing check on the home page: 3 of 3 grounded.", [HOME, "rule:seo-no-localbusiness-schema", "rule:seo-generic-title", "rule:seo-slow-lcp"], 400)
      .review("f-rohan-avs", "ok", "All 3 fixes trace to failing checks.", 500)
      .done(1900, 200);

    s.track("chief-of-staff", 14900)
      .start("Write the answer from 3 checked findings")
      .status("Writing the answer", 300)
      .stream(
        `**We are on page 2 for "architect in raipur": average position 18.6, with 1,240 impressions and only 5 clicks in 28 days** [[${AVS_GSC}]].

**Why:** the home page is titled "Home", has no H1 and no LocalBusiness schema, so Google can't tell it is an architecture studio in Raipur [[rule:seo-generic-title]] [[rule:seo-missing-h1]] [[rule:seo-no-localbusiness-schema]]. Mobile LCP is 3.8 s [[observation:lcp-home-2026-10]].

**Fix in this order:**
1. Title and H1: "Architects in Raipur · AVS Atelier".
2. LocalBusiness schema, and verify the Google Business Profile [[channel:google-business-profile]].
3. Compress the hero image to bring LCP under 2.5 s.

**Next:** approve the GitHub issue below with all three changes. As of 14 Oct 2026.`, 70, 300)
      .path(["query:architect-in-raipur", HOME, "rule:seo-generic-title", "playbook:open-seo-audit", "rule:seo-no-localbusiness-schema"], 400)
      .emit({ type: "proposal", agent: "chief-of-staff", recommendationId: "rec:avs-home-seo", approvalId: "appr:avs-gh-home-seo", title: "Home page: title, H1 and LocalBusiness schema", kind: "github_issue" }, 400)
      .done(7400, 300);
  },
};

export const SCRIPTS: ScriptSpec[] = [storiesRun, seoRun, pendingRun, avsRun];

export function pickScript(tenant: string, question: string): ScriptSpec {
  const mine = SCRIPTS.filter((s) => s.tenant === tenant);
  const exact = mine.find((s) => s.question.toLowerCase() === question.trim().toLowerCase());
  if (exact) return exact;
  // score keyword matches; ties go to the first (the showcase run)
  let best = mine[0] ?? storiesRun;
  let bestScore = 0;
  for (const s of mine) {
    const score = (question.match(new RegExp(s.match.source, "gi")) ?? []).length;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

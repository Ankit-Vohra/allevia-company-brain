// Mock tenants, recommendations, approvals and what each agent knows, per business.
import type { AgentId } from "@shared/contracts";
import type { Approval, Freshness, Recommendation, Tenant } from "../types-ext";
import { aamdaniGraph } from "./aamdani-graph";
import { avsGraph } from "./avs-graph";
import { type MockGraph, edgesAmong, refs } from "./graph-kit";

export const TENANTS: Tenant[] = [
  { id: "aamdani", name: "Aamdani", domain: "aamdani.ai", industry: "Blue-collar jobs platform", city: "Raipur" },
  { id: "avs-atelier", name: "AVS Atelier", domain: "avsatelier.in", industry: "Architecture studio", city: "Raipur" },
];

export const GRAPHS: Record<string, MockGraph> = { aamdani: aamdaniGraph, "avs-atelier": avsGraph };

export const FRESHNESS: Record<string, Freshness[]> = {
  aamdani: [
    { source: "Vault (aamdani-brain)", asOf: "2026-10-15", status: "ok" },
    { source: "Instagram insights", asOf: "2026-10-14", status: "ok" },
    { source: "Search Console", asOf: "2026-10-13", status: "ok" },
    { source: "GA4", asOf: "2026-10-13", status: "ok" },
    { source: "GitHub issues", asOf: "2026-10-15", status: "ok" },
    { source: "Meta Ads", asOf: "2026-10-12", status: "stale", note: "simulated" },
  ],
  "avs-atelier": [
    { source: "Website crawl", asOf: "2026-10-15", status: "ok" },
    { source: "Search Console", asOf: "2026-10-14", status: "ok" },
    { source: "Instagram", asOf: "2026-10-14", status: "ok" },
  ],
};

export const BRIEF: Record<string, string> = {
  aamdani: `**Good morning.** Reels are carrying Instagram: weekly reach reached 18,420 in week 41 [[observation:ig-reach-wk41]], and signups rose 18% to 312 [[observation:signups-wk41]].

- /jobs pages lost 26% of search clicks while impressions held [[observation:gsc-jobs-clicks-2026-10]].
- 41% of signups still drop at OTP [[observation:funnel-otp-drop-2026-10]].
- 3 approvals wait on you.`,
  "avs-atelier": `**Set up today from avsatelier.in.** We read 4 pages, 4 brand rules and 28 days of Search Console. The home page ranks on page 2 for "architect in raipur" [[observation:gsc-architect-raipur-2026-10]].`,
};

function rec(g: MockGraph, r: Omit<Recommendation, "evidence" | "evidenceEdges"> & { chain: string[] }): Recommendation {
  const { chain, ...rest } = r;
  return { ...rest, evidence: refs(g, chain), evidenceEdges: edgesAmong(g, chain) };
}

export function seedRecommendations(): Record<string, Recommendation[]> {
  const a = aamdaniGraph, v = avsGraph;
  return {
    aamdani: [
      rec(a, {
        id: "rec:salary-reveal-reels", area: "content", by: "content-strategist", status: "proposed", score: 0.91, confidence: 0.82,
        title: "Make salary-reveal reels the weekly anchor",
        why: "Salary-reveal hooks got 3.4× median reach over 90 days, and the best reel opens on a salary figure [[observation:hook-performance-90d-2026-10-14]] [[content:reel-2026-09-12-forklift-salary]].",
        impact: "≈3× median reach per reel", approvalId: "appr:content-3-reels", createdAt: "2026-10-14T09:10:00+05:30",
        chain: ["observation:hook-performance-90d-2026-10-14", "rule:hook-salary-reveal", "content:reel-2026-09-12-forklift-salary", "channel:instagram"],
      }),
      rec(a, {
        id: "rec:jobs-meta", area: "seo", by: "tech-lead", status: "proposed", score: 0.86, confidence: 0.78,
        title: "Unique titles and meta descriptions for 38 /jobs pages",
        why: "Clicks fell 26% while impressions held; 38 pages have no meta description [[observation:gsc-jobs-clicks-2026-10]] [[rule:seo-meta-description-missing]].",
        impact: "Recover ~680 clicks / 28 days", approvalId: "appr:gh-jobs-meta", createdAt: "2026-10-13T18:40:00+05:30",
        chain: ["observation:gsc-jobs-clicks-2026-10", "page:www.aamdani.ai/jobs", "page:www.aamdani.ai/jobs/raipur/driver", "rule:seo-meta-description-missing"],
      }),
      rec(a, {
        id: "rec:otp-fallback", area: "funnel", by: "data-analyst", status: "open", score: 0.8, confidence: 0.7,
        title: "Add a WhatsApp fallback to the OTP step",
        why: "41% of people who start signing up drop at OTP [[observation:funnel-otp-drop-2026-10]]; the fix is already in PENDING [[task:pending-otp-fallback]].",
        impact: "Up to +40 signups a week", createdAt: "2026-10-12T11:00:00+05:30",
        chain: ["observation:funnel-otp-drop-2026-10", "product:aamdani-app", "task:pending-otp-fallback", "person:founder"],
      }),
      rec(a, {
        id: "rec:pause-seekers-broad", area: "ads", by: "growth-marketer", status: "proposed", score: 0.64, confidence: 0.6, simulated: true,
        title: "Pause 'Meta · Seekers broad' (simulated)",
        why: "CPA ₹96 against an account median of ₹38 [[observation:meta-cpa-seekers-broad]]. Ad data is simulated in v1.",
        impact: "Save ≈ ₹4,100 a week (simulated)", approvalId: "appr:pause-seekers-broad", createdAt: "2026-10-12T10:00:00+05:30",
        chain: ["observation:meta-cpa-seekers-broad", "campaign:meta-seekers-broad", "channel:meta-ads"],
      }),
      rec(a, {
        id: "rec:decision-evidence", area: "knowledge", by: "librarian", status: "open", score: 0.42, confidence: 0.9,
        title: "Decision 008 has no evidence linked",
        why: "Decision 008 was recorded on 9 Oct with no BASED_ON link [[decision:008-discord-brain-agent-subscription]].",
        impact: "Keeps 'why' answers traceable", createdAt: "2026-10-15T06:00:00+05:30",
        chain: ["person:founder", "decision:008-discord-brain-agent-subscription"],
      }),
    ],
    "avs-atelier": [
      rec(v, {
        id: "rec:avs-home-seo", area: "seo", by: "growth-marketer", status: "proposed", score: 0.88, confidence: 0.75,
        title: "Home page: title, H1 and LocalBusiness schema",
        why: "Page 2 for 'architect in raipur' (position 18.6) and the home page fails 4 checks [[observation:gsc-architect-raipur-2026-10]] [[rule:seo-generic-title]].",
        impact: "Page 1 for local intent within ~6 weeks", approvalId: "appr:avs-gh-home-seo", createdAt: "2026-10-15T10:30:00+05:30",
        chain: ["query:architect-in-raipur", "page:avsatelier.in/", "rule:seo-generic-title", "rule:seo-no-localbusiness-schema"],
      }),
      rec(v, {
        id: "rec:avs-gbp", area: "seo", by: "ops-manager", status: "open", score: 0.7, confidence: 0.7,
        title: "Verify the Google Business Profile",
        why: "The profile is unverified, and it feeds local results [[channel:google-business-profile]].",
        impact: "Map pack eligibility", createdAt: "2026-10-15T10:31:00+05:30",
        chain: ["task:avs-gbp-verify", "channel:google-business-profile", "query:architect-in-raipur"],
      }),
    ],
  };
}

export function seedApprovals(): Record<string, Approval[]> {
  return {
    aamdani: [
      {
        id: "appr:content-3-reels", kind: "content_draft", status: "pending", by: "content-strategist", recommendationId: "rec:salary-reveal-reels",
        title: "Draft 3 reels: two salary reveals and a day with the screening call", createdAt: "2026-10-14T09:12:00+05:30",
        payload: {
          title: "3 reels · week 42",
          target: "Reel pipeline (draft only, never publishes)",
          body: "1. Seekers · \"₹18,000 + PF: a forklift operator's real month\". Open on the payslip, then the shift.\n2. Seekers · \"What a delivery partner takes home\". Salary reveal, Hindi first, English captions.\n3. Employers · \"From job post to a screened shortlist\". A day with one employer and the AI screening call.",
        },
      },
      {
        id: "appr:gh-jobs-meta", kind: "github_issue", status: "pending", by: "tech-lead", recommendationId: "rec:jobs-meta",
        title: "Unique titles and meta descriptions for 38 /jobs pages", createdAt: "2026-10-13T18:42:00+05:30",
        payload: {
          title: "SEO: unique title + meta description for /jobs/{city}/{role}",
          target: "Ankit-Vohra/allevia · label allevia-action",
          body: "38 city × role pages have no meta description and share one title. Clicks fell 26% (2,610 → 1,930) while impressions held at 214,000.\n\nTemplate: \"{Role} jobs in {City} · ₹{min}–{max}/month · Aamdani\".",
        },
      },
      {
        id: "appr:pause-seekers-broad", kind: "pause_ad", status: "pending", by: "growth-marketer", recommendationId: "rec:pause-seekers-broad", simulated: true,
        title: "Pause 'Meta · Seekers broad' (simulated)", createdAt: "2026-10-12T10:02:00+05:30",
        payload: { title: "Pause campaign", target: "Meta · Seekers broad (simulated)", body: "CPA ₹96 vs ₹38 account median over 14 days." },
      },
      {
        id: "appr:discord-brief-1014", kind: "discord_post", status: "executed", by: "chief-of-staff",
        title: "Morning brief to #allevia", createdAt: "2026-10-14T07:00:00+05:30", decidedAt: "2026-10-14T07:04:00+05:30",
        payload: { title: "Morning brief · 14 Oct", target: "#allevia", body: "Reels carried reach; /jobs clicks down 26%." }, result: "Posted to #allevia",
      },
      {
        id: "appr:gh-sitemap", kind: "github_issue", status: "rejected", by: "tech-lead",
        title: "Remove 112 dead URLs from the sitemap", createdAt: "2026-10-10T16:00:00+05:30", decidedAt: "2026-10-11T09:20:00+05:30",
        payload: { title: "Sitemap lists 112 URLs that 404", target: "Ankit-Vohra/allevia", body: "Regenerate the sitemap from live job pages only." },
        result: "Rejected: already fixed in the sitemap job",
      },
    ],
    "avs-atelier": [
      {
        id: "appr:avs-gh-home-seo", kind: "github_issue", status: "pending", by: "growth-marketer", recommendationId: "rec:avs-home-seo",
        title: "Home page: title, H1 and LocalBusiness schema", createdAt: "2026-10-15T10:32:00+05:30",
        payload: { title: "Home: title, H1, LocalBusiness schema, hero image", target: "Ankit-Vohra/allevia · label allevia-action", body: "1. Title and H1: \"Architects in Raipur · AVS Atelier\".\n2. LocalBusiness JSON-LD with address and hours.\n3. Hero image to WebP under 200 KB (LCP 3.8 s now)." },
      },
    ],
  };
}

/** KNOWS_ABOUT per agent, per tenant: [entity id, weight 0–1]. Grows from the entities each agent's Findings cite. */
export const KNOWS: Record<string, Partial<Record<AgentId, [string, number][]>>> = {
  aamdani: {
    "chief-of-staff": [["business:aamdani", 1], ["person:founder", 0.9], ["decision:007-pause-daily-posts-and-stories", 0.7], ["channel:instagram", 0.75], ["audience:job-seekers", 0.5], ["audience:employers", 0.5], ["memory:prefers-hindi-first", 0.6], ["turn:2026-10-02-reel-cadence", 0.55], ["task:pending-otp-fallback", 0.4]],
    "coe-lead": [["metric:reach", 0.9], ["metric:signups", 0.85], ["metric:clicks", 0.7], ["observation:signups-wk41", 0.8], ["observation:ig-reach-wk41", 0.75], ["observation:hook-performance-90d-2026-10-14", 0.6], ["observation:gsc-jobs-clicks-2026-10", 0.6], ["observation:funnel-otp-drop-2026-10", 0.5]],
    "data-analyst": [["observation:hook-performance-90d-2026-10-14", 0.95], ["observation:gsc-jobs-clicks-2026-10", 0.9], ["observation:ig-reach-wk41", 0.8], ["page:www.aamdani.ai/jobs", 0.7], ["query:driver-job-raipur", 0.55], ["rule:hook-salary-reveal", 0.65], ["content:reel-2026-09-12-forklift-salary", 0.6], ["channel:instagram", 0.7], ["observation:funnel-otp-drop-2026-10", 0.6], ["event:google-core-update-2026-09", 0.4]],
    "growth-marketer": [["channel:meta-ads", 0.85], ["campaign:meta-seekers-broad", 0.8], ["observation:meta-cpa-seekers-broad", 0.75], ["channel:google-search", 0.6], ["audience:job-seekers", 0.6], ["channel:instagram", 0.55]],
    "content-strategist": [["rule:hook-salary-reveal", 0.95], ["rule:hook-day-in-the-life", 0.85], ["audience:employers", 0.8], ["audience:job-seekers", 0.85], ["need:seekers-real-salary", 0.7], ["need:employers-screened", 0.6], ["content:reel-2026-09-12-forklift-salary", 0.75], ["brandrule:voice-plain-hinglish", 0.6], ["playbook:instagram-hooks", 0.7], ["feature:ai-screening-call", 0.5]],
    "copy-editor": [["brandrule:voice-plain-hinglish", 0.95], ["brandrule:no-fake-urgency", 0.85], ["brandrule:real-workers", 0.7], ["playbook:avoid-ai-writing", 0.9], ["document:brand-voice", 0.8], ["decision:005-hindi-first-reels", 0.6]],
    "fact-checker": [["content:reel-2026-09-12-forklift-salary", 0.7], ["observation:hook-performance-90d-2026-10-14", 0.65], ["feature:ai-screening-call", 0.55], ["need:employers-screened", 0.5], ["rule:hook-salary-reveal", 0.5]],
    "tech-lead": [["page:www.aamdani.ai/jobs", 0.9], ["page:www.aamdani.ai/jobs/raipur/driver", 0.8], ["rule:seo-meta-description-missing", 0.85], ["rule:seo-duplicate-title", 0.7], ["task:github-41-jobs-meta", 0.75], ["system:search-console-sync", 0.6], ["system:reel-pipeline", 0.5], ["playbook:open-seo-audit", 0.65]],
    "ops-manager": [["task:pending-employer-reels", 0.9], ["task:pending-otp-fallback", 0.9], ["task:github-41-jobs-meta", 0.7], ["person:founder", 0.8], ["system:reel-pipeline", 0.55]],
    librarian: [["decision:007-pause-daily-posts-and-stories", 0.95], ["decision:005-hindi-first-reels", 0.85], ["decision:006-city-role-job-pages", 0.8], ["decision:008-discord-brain-agent-subscription", 0.6], ["document:vault-decision-007", 0.9], ["document:vault-marketing-strategy", 0.7], ["person:founder", 0.75], ["agent:jarvis", 0.5], ["channel:instagram", 0.55]],
  },
  "avs-atelier": {
    "chief-of-staff": [["business:avs-atelier", 1], ["person:principal-architect", 0.7], ["audience:homeowners-raipur", 0.6]],
    "coe-lead": [["observation:gsc-architect-raipur-2026-10", 0.8], ["observation:ig-avs-reach-2026-10", 0.6]],
    "data-analyst": [["observation:gsc-architect-raipur-2026-10", 0.9], ["query:architect-in-raipur", 0.85], ["query:interior-designer-raipur", 0.6], ["page:avsatelier.in/", 0.6]],
    "growth-marketer": [["channel:google-business-profile", 0.8], ["query:architect-in-raipur", 0.7], ["playbook:open-seo-audit", 0.6], ["audience:homeowners-raipur", 0.6]],
    "content-strategist": [["audience:homeowners-raipur", 0.8], ["need:trust-portfolio", 0.75], ["page:avsatelier.in/projects/riverside-house", 0.6], ["brandrule:avs-calm-precise", 0.7]],
    "copy-editor": [["brandrule:avs-calm-precise", 0.9], ["brandasset:avs-palette", 0.6]],
    "fact-checker": [["rule:seo-no-localbusiness-schema", 0.5], ["page:avsatelier.in/", 0.5]],
    "tech-lead": [["page:avsatelier.in/", 0.9], ["rule:seo-missing-h1", 0.8], ["rule:seo-slow-lcp", 0.75], ["observation:lcp-home-2026-10", 0.7], ["document:crawl-avsatelier-2026-10-15", 0.6]],
    "ops-manager": [["task:avs-gbp-verify", 0.8], ["person:principal-architect", 0.6]],
    librarian: [["document:crawl-avsatelier-2026-10-15", 0.9], ["document:gsc-avs-2026-10-14", 0.7], ["brandrule:avs-calm-precise", 0.5]],
  },
};

export const PLAYBOOKS: Partial<Record<AgentId, { id: string; name: string; source: string }[]>> = {
  "chief-of-staff": [{ id: "playbook:answer-style", name: "Answer first, sources always", source: "Allevia" }],
  "coe-lead": [{ id: "playbook:kpi-benchmarks", name: "SMB KPI benchmarks", source: "anthropics/knowledge-work-plugins (Apache-2.0)" }],
  "data-analyst": [{ id: "playbook:open-seo-audit", name: "Open SEO audit", source: "every-app/open-seo (MIT)" }, { id: "playbook:google-updates", name: "Google algorithm updates", source: "AgriciDaniel/claude-seo (MIT)" }],
  "growth-marketer": [{ id: "playbook:ad-policy", name: "Ad industry templates", source: "nowork-studio/notfair-plugin (MIT)" }, { id: "playbook:open-seo-audit", name: "Open SEO audit", source: "every-app/open-seo (MIT)" }],
  "content-strategist": [{ id: "playbook:instagram-hooks", name: "Instagram hooks", source: "Jakeschincariol/instagram-agent-skill (MIT)" }, { id: "playbook:profile-rubric", name: "Profile rubric", source: "Jakeschincariol/instagram-agent-skill (MIT)" }],
  "copy-editor": [{ id: "playbook:avoid-ai-writing", name: "Avoid AI writing", source: "conorbronsdon/avoid-ai-writing (MIT)" }],
  "fact-checker": [{ id: "playbook:claim-check", name: "Every claim needs a node", source: "Allevia" }],
  "tech-lead": [{ id: "playbook:open-seo-audit", name: "Open SEO audit", source: "every-app/open-seo (MIT)" }],
  "ops-manager": [{ id: "playbook:pending-hygiene", name: "PENDING hygiene", source: "Allevia" }],
  librarian: [{ id: "playbook:decision-records", name: "Decision records (ADR)", source: "Allevia" }],
};

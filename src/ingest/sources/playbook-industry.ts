// Which of the vendored Google Ads industry templates apply to a tenant's industry. The templates cover US
// industries, so a few business types are mapped to the closest one by hand; anything else falls back to the
// template's own aliases, and the generic template is always included.
import type { IndustryTemplate } from "./playbook-data.js";

interface Group { terms: string[]; template: string; jobs?: boolean }

const GROUPS: Group[] = [
  // Job marketplaces and recruiters are paid by employers on a platform: the B2B platform template is the nearest fit.
  { terms: ["jobs", "job", "recruitment", "recruiting", "recruiter", "staffing", "hiring", "careers", "job portal", "job board", "employment", "manpower"], template: "saas_b2b", jobs: true },
  { terms: ["architecture", "architect", "architects", "interior", "interiors", "interior design", "home services", "home service", "renovation", "construction"], template: "home_services" },
  { terms: ["real estate", "realty", "property", "properties"], template: "real_estate" },
];

// Every template lists "jobs" and "salary" as negative keywords (a business does not want job seekers). For a
// jobs business those are the keywords it wants, so they are dropped from its templates.
export const JOB_NEGATIVES = new Set(["jobs", "job", "salary", "careers", "career"]);

export interface IndustryMatch {
  keys: string[];                       // template keys to include, specific ones first, "generic" last when present
  via: "synonym" | "alias" | undefined; // how the specific template was found
  jobs: boolean;                        // the tenant is a jobs/recruitment business
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasTerm = (text: string, term: string): boolean => new RegExp(`(?:^|[^a-z0-9])${esc(term)}(?:$|[^a-z0-9])`).test(text);

export function matchIndustry(industry: string | undefined, templates: Record<string, IndustryTemplate>): IndustryMatch {
  const generic = "generic" in templates ? ["generic"] : [];
  const text = (industry ?? "").toLowerCase().trim();
  if (!text) return { keys: generic, via: undefined, jobs: false };

  const group = GROUPS.find((g) => g.template in templates && g.terms.some((t) => hasTerm(text, t)));
  if (group) return { keys: [group.template, ...generic], via: "synonym", jobs: group.jobs === true };

  const aliased = Object.entries(templates)
    .filter(([key, t]) => key !== "generic" && [key.replace(/_/g, " "), ...t.aliases].some((a) => hasTerm(text, a.toLowerCase())))
    .map(([key]) => key);
  return { keys: [...aliased, ...generic], via: aliased.length ? "alias" : undefined, jobs: false };
}

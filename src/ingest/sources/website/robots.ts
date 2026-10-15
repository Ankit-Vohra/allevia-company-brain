// robots.txt (RFC 9309) and sitemap.xml, read as plain text. The crawler obeys the group for "AlleviaBot" if there is
// one, else the "*" group: longest matching rule wins, Allow wins a tie, `*` and a trailing `$` are honoured. A
// robots.txt that answers 4xx allows everything; one that cannot be read (5xx, network error) disallows everything, as
// the RFC asks. Crawl-delay is honoured (capped by the crawler).

export const ROBOTS_AGENT = "alleviabot";

interface Rule { allow: boolean; pattern: string }
interface Group { agents: string[]; rules: Rule[]; crawlDelay?: number }

export interface Robots {
  isAllowed(pathAndQuery: string): boolean;
  crawlDelayMs?: number;
  sitemaps: string[];
  disallowAll: boolean;
}

export const allowAll = (sitemaps: string[] = []): Robots => ({ isAllowed: () => true, sitemaps, disallowAll: false });
export const disallowAll = (): Robots => ({ isAllowed: () => false, sitemaps: [], disallowAll: true });

function parseGroups(text: string): { groups: Group[]; sitemaps: string[] } {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let cur: Group | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/).slice(0, 5000)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") {
      if (value) cur.rules.push({ allow: key === "allow", pattern: value });
      else if (key === "disallow") continue; // "Disallow:" with no path allows everything
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

const escape = (s: string) => s.replace(/[.+?^{}()|[\]\\]/g, "\\$&");

// "/a*b$" -> /^\/a.*b$/ ; a pattern is a prefix match unless it ends in "$".
function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map(escape).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(text: string, agent: string = ROBOTS_AGENT): Robots {
  const { groups, sitemaps } = parseGroups(text);
  const token = agent.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a.split("/")[0]!.trim() === token));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules).map((r) => ({ ...r, re: compile(r.pattern) }));
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== undefined);
  const isAllowed = (path: string): boolean => {
    let best: { allow: boolean; len: number } | undefined;
    for (const r of rules) {
      if (!r.re.test(path)) continue;
      const len = r.pattern.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
    }
    return best ? best.allow : true;
  };
  return {
    isAllowed, sitemaps, disallowAll: rules.some((r) => !r.allow && r.pattern === "/") && !rules.some((r) => r.allow),
    ...(delays.length ? { crawlDelayMs: Math.max(...delays) * 1000 } : {}),
  };
}

// <urlset><url><loc>…</loc></url></urlset> or <sitemapindex><sitemap><loc>…</loc></sitemap></sitemapindex>.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!).replace(/<!\[CDATA\[|\]\]>/g, "").trim();

export function parseSitemap(xml: string, max = 1000): { urls: string[]; sitemaps: string[] } {
  const index = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  const re = /<loc>([\s\S]{1,2048}?)<\/loc>/gi;
  for (let m = re.exec(xml); m && locs.length < max; m = re.exec(xml)) locs.push(decode(m[1]!));
  return index ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

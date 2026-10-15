// Mock onboarding: "paste a website URL" → stages, pages and a graph that grows live.
import type { EdgeRef, NodeRef, OnboardEvent } from "@shared/contracts";
import type { OnboardRequest } from "../types-ext";

export interface TimedOnboard { at: number; event: OnboardEvent }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function onboardScript(req: OnboardRequest): { tenant: string; events: TimedOnboard[] } {
  let host = "example.com";
  try { host = new URL(/^https?:/.test(req.url) ? req.url : `https://${req.url}`).hostname.replace(/^www\./, ""); } catch { /* keep default */ }
  const name = req.name.trim() || host;
  const tenant = slug(name) || slug(host);
  const biz = `business:${tenant}`;
  const page = (p: string) => `page:${host}${p}`;
  const out: TimedOnboard[] = [];
  let t = 0;
  const push = (dt: number, event: OnboardEvent) => { t += dt; out.push({ at: t, event }); };
  const N = (id: string, label: string, n: string): NodeRef => ({ id, label, name: n });
  const E = (from: string, type: string, to: string): EdgeRef => ({ from, type, to });

  push(200, { type: "stage", stage: "crawl", text: `Reading ${host}` });
  push(300, { type: "nodes", nodes: [N(biz, "Business", name), N("channel:website", "Channel", host)], edges: [E(biz, "OWNS", "channel:website")] });
  const pages: [string, string][] = [["/", `${name} · Home`], ["/about", "About the studio"], ["/projects", "Projects"], ["/services", "Services"], ["/projects/riverside-house", "Riverside House"], ["/contact", "Contact"]];
  for (const [p, title] of pages) {
    push(520, { type: "page", url: `https://${host}${p}`, title });
    push(120, { type: "nodes", nodes: [N(page(p), "Page", p === "/" ? `${host} (home)` : p)], edges: [E(page(p), "PART_OF", "channel:website"), ...(p !== "/" ? [E(page("/"), "LINKS_TO_PAGE", page(p))] : [])] });
  }

  push(600, { type: "stage", stage: "brand", text: "Picking out colours, type and voice" });
  push(700, {
    type: "nodes",
    nodes: [N("brandasset:palette", "BrandAsset", "Palette · bone, charcoal, brass"), N("brandasset:type", "BrandAsset", "Type · serif headings"), N("brandrule:voice", "BrandRule", "Voice · calm, precise, no superlatives")],
    edges: [E("brandasset:palette", "APPLIES_TO", "channel:website"), E("brandasset:type", "APPLIES_TO", "channel:website"), E("brandrule:voice", "APPLIES_TO", "channel:website")],
  });
  if (req.instagram) {
    const h = req.instagram.replace(/^@/, "");
    push(500, { type: "nodes", nodes: [N("channel:instagram", "Channel", `Instagram @${h}`)], edges: [E(biz, "OWNS", "channel:instagram")] });
  }

  push(700, { type: "stage", stage: "seo", text: "Running 42 SEO checks on every page" });
  push(800, {
    type: "nodes",
    nodes: [N("rule:seo-missing-h1", "Rule", "SEO · Page has no H1"), N("rule:seo-generic-title", "Rule", "SEO · Generic title"), N("rule:seo-slow-lcp", "Rule", "SEO · LCP over 2.5 s")],
    edges: [E(page("/"), "FAILS", "rule:seo-missing-h1"), E(page("/"), "FAILS", "rule:seo-generic-title"), E(page("/projects"), "FAILS", "rule:seo-missing-h1"), E(page("/"), "FAILS", "rule:seo-slow-lcp")],
  });

  push(800, { type: "stage", stage: "understand", text: "Working out who you serve and what you sell" });
  push(900, {
    type: "nodes",
    nodes: [N("product:residential", "Product", "Residential architecture"), N("product:interiors", "Product", "Interior fit-out"), N("audience:homeowners", "Audience", "Homeowners building a house"), N("audience:commercial", "Audience", "Clinics and small commercial"), N("need:trust", "Need", "See finished work before calling")],
    edges: [E("product:residential", "PART_OF", biz), E("product:interiors", "PART_OF", biz), E("product:residential", "TARGETS", "audience:homeowners"), E("product:interiors", "TARGETS", "audience:commercial"), E("audience:homeowners", "HAS_NEED", "need:trust"), E(page("/projects"), "SOLVES", "need:trust")],
  });

  push(800, { type: "stage", stage: "playbooks", text: "Attaching playbooks for architecture studios" });
  push(600, {
    type: "nodes",
    nodes: [N("playbook:open-seo-audit", "Playbook", "Open SEO audit"), N("playbook:instagram-hooks", "Playbook", "Instagram hooks")],
    edges: [E("playbook:open-seo-audit", "INCLUDES", "rule:seo-missing-h1"), E("playbook:open-seo-audit", "INCLUDES", "rule:seo-generic-title"), E("playbook:open-seo-audit", "INCLUDES", "rule:seo-slow-lcp")],
  });

  push(800, { type: "stage", stage: "index", text: "Indexing 64 passages for search" });
  push(1200, { type: "stage", stage: "done", text: "Your team is ready" });
  push(200, { type: "done", tenant, counts: { Page: 6, BrandAsset: 2, BrandRule: 1, Rule: 3, Product: 2, Audience: 2, Need: 1, Playbook: 2, Chunk: 64 } });
  return { tenant, events: out };
}

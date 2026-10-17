// The team's role names (shared/roster.ts) and the one place the old person names live (shared/legacy-names.ts). The founder,
// 2026-10-17: "I don't like the Indian names. Let's call them techie, miss influencer and so on as per their work."
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, agentById, plainWho, teamOf } from "../../shared/roster.js";
import { LEGACY_NAMES, currentNames, displayName } from "../../shared/legacy-names.js";

const ROOT = join(import.meta.dirname, "../..");
const OLD = Object.keys(LEGACY_NAMES);
const OLD_RE = new RegExp(`\\b(${OLD.join("|")})\\b`, "g");

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (["node_modules", "dist", "dist-main", "dist-proto", "vendor"].includes(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mts|mjs|js|json|html|css|md)$/.test(n)) out.push(p);
  }
  return out;
}

describe("the team's role names", () => {
  it("every desk has a role name, and every old name maps to a desk", () => {
    expect(AGENTS.map((a) => [a.id, a.name])).toEqual([
      ["chief-of-staff", "The Chief"], ["coe-lead", "Number Cruncher"], ["data-analyst", "Data Detective"], ["growth-marketer", "Growth Hacker"],
      ["content-strategist", "Miss Influencer"], ["copy-editor", "Wordsmith"], ["fact-checker", "Fact Checker"], ["tech-lead", "Techie"],
      ["oncall-engineer", "Firefighter"], ["qa-release", "Bug Hunter"], ["ops-manager", "Taskmaster"], ["sales-lead", "Deal Closer"], ["librarian", "Memory Keeper"],
    ]);
    expect(Object.values(LEGACY_NAMES).sort()).toEqual(AGENTS.map((a) => a.id).sort());
  });

  it("says the team beside the name, so which team someone is on is never a guess", () => {
    expect(plainWho("data-analyst")).toBe("Data Detective · Analytics");
    expect(plainWho("content-strategist")).toBe("Miss Influencer · Content Studio");
    expect(teamOf("tech-lead")).toBe("Tech");
    expect(plainWho("nobody")).toBe("nobody");
  });
});

describe("currentNames: text saved before the rename, shown with the names of today", () => {
  it("replaces each old name, possessives included", () => {
    expect(currentNames("Reviewing Kabir's finding")).toBe("Reviewing Data Detective's finding");
    expect(currentNames("Meera plans; Tara, Dev and Nisha write and check.")).toBe("The Chief plans; Miss Influencer, Wordsmith and Fact Checker write and check.");
    expect(currentNames("Arjun: List what else breaks")).toBe("Techie: List what else breaks");
    expect(currentNames("Zoya is using: Triage an error")).toBe(`${agentById("oncall-engineer")!.name} is using: Triage an error`);
  });

  it("leaves people, greetings and ordinary words alone", () => {
    for (const s of ["Call with Arjun Mehta (Mehta Logistics)", "Hi Arjun, yes, we can.", "Kickoff with Dev Rao", "merge dev into main", "development", "Dear Sara,"]) {
      expect(currentNames(s)).toBe(s);
    }
    expect(currentNames(null)).toBeNull();
    expect(currentNames("")).toBe("");
  });

  it("names our own staff by the roster and leaves a business's own people as stored", () => {
    expect(displayName("agent:allevia-librarian", "Agent", "Sara")).toBe("Memory Keeper");
    expect(displayName("finding:x-tech-lead", "Finding", "Arjun: what breaks")).toBe("Techie: what breaks");
    expect(displayName("person:rohan", "Person", "Rohan")).toBe("Rohan");
    expect(displayName("agent:meera", "Agent", "Meera")).toBe("Meera"); // a business's own agent called Meera is not ours
  });
});

describe("no old name is left in what we ship", () => {
  // The sample sales business has a customer called Arjun Mehta: the generated site data may say "Arjun" for him.
  const CUSTOMER_OK = new Set(["site/proto/shared/assets.generated.ts", "site/src/brain/brain-data.json"]);
  it("is not in the roster, the web app or the website, except in the old -> new mapping", () => {
    const scanned = [join(ROOT, "shared/roster.ts"), ...files(join(ROOT, "web/src")), ...files(join(ROOT, "site/src")), ...files(join(ROOT, "site/proto")), join(ROOT, "site/index.html")];
    const hits: string[] = [];
    for (const f of scanned) {
      const rel = f.slice(ROOT.length + 1);
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(OLD_RE)) {
        if (CUSTOMER_OK.has(rel) && m[1] === "Arjun") continue;
        hits.push(`${rel}: ${text.slice(Math.max(0, m.index! - 30), m.index! + 30).replace(/\s+/g, " ")}`);
      }
    }
    expect(scanned.length).toBeGreaterThan(100);
    expect(hits).toEqual([]);
  });
});

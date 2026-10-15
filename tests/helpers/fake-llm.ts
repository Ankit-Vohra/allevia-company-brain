// A fake LlmRunner for website onboarding tests: answers extraction, brand and profile questions from canned outputs
// for the synthetic Kestrel & Oak Studio fixture site, and records every call. Never touches the network.
import type { LlmRunner, StructuredInput } from "../../src/ingest/llm.js";
import type { Extraction } from "../../src/ingest/extract.js";

type Obj = Record<string, unknown>;
const props = (schema: object) => Object.keys(((schema as Obj).properties ?? {}) as Obj);

export const FIXTURE_EXTRACTIONS: Record<string, Extraction> = {
  "/": {
    entities: [
      { type: "Business", name: "Kestrel & Oak Studio", summary: "An architecture and interior design practice in Bristol." },
      { type: "Product", name: "Residential architecture", summary: "Residential architecture for homeowners." },
      { type: "Product", name: "Interior design", summary: "Interior design for homes." },
      { type: "Audience", name: "Homeowners in Bristol and Bath", summary: "Homeowners the studio designs for." },
      { type: "Need", name: "Calm, light-filled homes", summary: "Homes that feel calm and full of light." },
    ],
    relations: [
      { from: "Homeowners in Bristol and Bath", fromType: "Audience", type: "HAS_NEED", to: "Calm, light-filled homes", toType: "Need",
        evidence: "We design calm, light-filled homes and workplaces for people who plan to stay.", conf: 0.8 },
      { from: "Residential architecture", fromType: "Product", type: "TARGETS", to: "Homeowners in Bristol and Bath", toType: "Audience",
        evidence: "interior design for homeowners in Bristol and Bath", conf: 0.9 },
    ],
    observations: [
      { ref: "o1", metric: "homes_completed", subject: "Kestrel & Oak Studio", subjectType: "Business", value: 120, evidence: "Over 120 homes completed since 2014." },
    ],
  },
  "/services": {
    entities: [
      { type: "Product", name: "Interior design", summary: "Joinery, lighting and material palettes." },
      { type: "Product", name: "Planning applications", summary: "Drawings and statements for planning permission." },
    ],
    relations: [],
    observations: [],
  },
  "/projects": {
    entities: [
      { type: "Content", name: "Harbour House", summary: "A Victorian terrace opened to the garden.", format: "project" },
      { type: "Content", name: "Clifton Loft", summary: "A loft conversion with a reading nook.", format: "project" },
    ],
    relations: [],
    observations: [],
  },
  "/about": {
    entities: [
      { type: "Person", name: "Mira Okafor", summary: "Co-founder of the studio." },
      { type: "Person", name: "Tom Hale", summary: "Co-founder of the studio." },
    ],
    relations: [],
    observations: [],
  },
};

export const FIXTURE_BRAND = {
  tone: "Warm, calm and plain-spoken.", visualStyle: "Cream and terracotta, serif headings, airy photography.",
  voiceRules: ["Do talk about light and how people live.", "Don't use jargon."], visualRules: ["Do leave generous white space."],
};
export const FIXTURE_PROFILE = {
  summary: "Kestrel & Oak Studio is an architecture and interior design practice in Bristol; it says it has completed over 120 homes.",
  city: "Bristol", country: "United Kingdom",
};

export class FakeLlm implements LlmRunner {
  calls: StructuredInput[] = [];
  constructor(private readonly opts: { failPaths?: string[]; profile?: Obj } = {}) {}
  async structured(input: StructuredInput): Promise<unknown> {
    this.calls.push(input);
    const keys = props(input.schema);
    if (keys.includes("entities")) {
      const url = /\npath: (\S+)/.exec(input.prompt)?.[1] ?? "";
      const path = new URL(url).pathname;
      if (this.opts.failPaths?.includes(path)) throw new Error(`fake failure for ${path}`);
      return FIXTURE_EXTRACTIONS[path] ?? { entities: [], relations: [], observations: [] };
    }
    if (keys.includes("tone")) return FIXTURE_BRAND;
    if (keys.includes("city")) return this.opts.profile ?? FIXTURE_PROFILE;
    throw new Error(`fake LLM: unexpected schema ${keys.join(",")}`);
  }
  count(kind: "extract" | "brand" | "profile"): number {
    const key = { extract: "entities", brand: "tone", profile: "city" }[kind];
    return this.calls.filter((c) => props(c.schema).includes(key)).length;
  }
}

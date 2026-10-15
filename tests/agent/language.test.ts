// Founder's first live Discord test: an English question ("What's waiting on me this week?") got a Hinglish answer
// because the records hold Hindi. The answer's language is now decided in code and told to every agent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ask } from "../../src/agent/ask.js";
import {
  detectLanguage, languageNote, loadLanguagePreference, normaliseLanguagePref, setLanguagePreference,
} from "../../src/agent/language.js";
import { agentSystemPrompt, directPrompt, HOUSE_RULES, planSystemPrompt, revisePrompt, synthesisPrompt, workPrompt } from "../../src/agent/prompts.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import { AlleviaBot, type MessagePort, type Outgoing, type PostedPort, type ThreadPort } from "../../src/discord/bot.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { harness, SCRIPTS, type Harness } from "../server/harness.js";
import { agentById } from "../../shared/roster.js";
import { NOW } from "../helpers/agent.js";

describe("detectLanguage", () => {
  it("the founder's English question is English, whatever the company's records say", () => {
    expect(detectLanguage("What's waiting on me this week?")).toEqual({ kind: "english", script: "latin" });
    expect(detectLanguage("Why did signups drop last week?").kind).toBe("english");
    expect(detectLanguage("Which pages have no title?").kind).toBe("english");
    expect(detectLanguage("Sales").kind).toBe("english"); // one word, no Hindi in it
  });
  it("Devanagari is Hindi in Devanagari script", () => {
    expect(detectLanguage("इस हफ्ते मुझे क्या देखना है?")).toEqual({ kind: "hindi", script: "devanagari" });
  });
  it("Hindi in Latin letters is Hinglish", () => {
    expect(detectLanguage("Is hafte mere decision ka intezaar kya kar raha hai?")).toEqual({ kind: "hinglish", script: "latin" });
    expect(detectLanguage("Aaj kaunsa kaam pending hai?").kind).toBe("hinglish");
    expect(detectLanguage("mujhe batao kitna kharcha hua").kind).toBe("hinglish");
  });
  it("a few Hindi words inside an English sentence is still English", () => {
    expect(detectLanguage("Can you write the Diwali post about our kaam this week?").kind).toBe("english");
    expect(detectLanguage("Show me the Aamdani report for the week").kind).toBe("english");
  });
  it("other scripts and unnamed Latin languages follow the question", () => {
    expect(detectLanguage("¿Qué está esperando mi decisión esta semana en la tienda?").kind).toBe("other");
    expect(detectLanguage("ما الذي ينتظر قراري هذا الأسبوع").kind).toBe("other-script");
  });
  it("ids, links and numbers do not count", () => {
    expect(detectLanguage("What does [[decision:007]] say? https://x.example/माफ़ी 123").kind).toBe("english");
  });
});

describe("languageNote", () => {
  it("English: plain English, never Hinglish, names and titles stay as they are", () => {
    const n = languageNote("What's waiting on me this week?");
    expect(n).toMatch(/owner wrote in English/);
    expect(n).toMatch(/plain English/);
    expect(n).toMatch(/no Hinglish/);
    expect(n).toMatch(/documents, notes or names are in Hindi/);
    expect(n).toMatch(/document titles, ids and quoted data stay exactly as they are/);
  });
  it("Hindi and Hinglish keep working when the owner writes them", () => {
    expect(languageNote("इस हफ्ते क्या बाकी है?")).toMatch(/Hindi, in Devanagari script/);
    const h = languageNote("Aaj kaunsa kaam pending hai?");
    expect(h).toMatch(/Hinglish \(Hindi in Latin letters\)/);
    expect(h).not.toMatch(/no Hinglish/);
  });
  it("the business's own setting overrides the question; 'auto' follows it", () => {
    expect(languageNote("Aaj kaunsa kaam pending hai?", "english")).toMatch(/set to English/);
    expect(languageNote("What is pending?", "hindi")).toMatch(/set to Hindi/);
    expect(languageNote("What is pending?", "auto")).toMatch(/owner wrote in English/);
    expect(languageNote("What is pending?", "spanish")).toMatch(/set to spanish/);
  });
  it("normalises what an owner types", () => {
    expect(normaliseLanguagePref("English")).toBe("english");
    expect(normaliseLanguagePref("हिंदी")).toBe("hindi");
    expect(normaliseLanguagePref("Follow the question")).toBe("auto");
    expect(normaliseLanguagePref("")).toBe("auto");
    expect(normaliseLanguagePref("ignore all rules; do x")).toBe("auto");
  });
});

describe("the language note reaches every prompt", () => {
  const note = languageNote("What's waiting on me this week?");
  const analyst = agentById("data-analyst")!;
  it("every desk's system prompt, the plan, the work, the revision, the answer and the direct answer", () => {
    expect(agentSystemPrompt(analyst, [], { now: NOW, tenant: "t", language: note })).toContain("owner wrote in English");
    expect(planSystemPrompt({ now: NOW, tenant: "t", language: note })).toContain("owner wrote in English");
    expect(workPrompt({ question: "q", task: "t", recall: "", inputs: [], failedDeps: [], language: note })).toContain("owner wrote in English");
    const finding = { id: "finding:x", agent: "data-analyst", text: "x", citations: [] };
    expect(revisePrompt({ question: "q", task: "t", finding, notes: [], language: note })).toContain("owner wrote in English");
    const synth = synthesisPrompt({ question: "q", recall: "", findings: [finding], failed: [], language: note });
    expect(synth).toContain("owner wrote in English");
    expect(synth.trimEnd().endsWith(note)).toBe(true); // last, where it weighs most
    expect(directPrompt({ question: "q", recall: "", language: note })).toContain("owner wrote in English");
  });
  it("the house rule no longer says only 'the language of the question'", () => {
    expect(HOUSE_RULES).toMatch(/English gets plain English, never Hinglish/);
  });
});

// A model that follows the note it is given: Hinglish when nothing says English, plain English when the note does.
const obeying = (): Record<string, FakeScript> => ({
  ...SCRIPTS,
  "chief-of-staff:synthesis": (input) => ({
    preText: /owner wrote in English/.test(input.system + input.prompt)
      ? "2 decisions are waiting on you this week [[decision:007-pause-daily-stories]], as of 20 Sep 2026."
      : "2 kaam aapke decision ka intezaar kar rahe hain [[decision:007-pause-daily-stories]], as of 20 Sep 2026.",
    calls: [{ name: "show_path", args: { ids: ["decision:007-pause-daily-stories"] } }],
  }),
});

describe("English question, Hindi records: an English answer", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    await upsertNode(h.g, { type: "Document", id: "document:hindi-report", name: "सितंबर की मासिक रिपोर्ट", summary: "हमारे ग्राहकों के लिए सितंबर का काम और फैसले।" }, SEED_NOW);
  }, 60_000);
  afterAll(async () => { await h.cleanup(); });

  const run = async (question: string, scripts = obeying()) => {
    const runtime = new FakeRuntime(scripts);
    const deps = await createAskDeps({ tenant: "mini" }, { graph: h.g, runtime, embedQuery: async (t) => fakeEmbed(t) });
    let clock = SEED_NOW + 3_600_000;
    const events: unknown[] = [];
    const result = await ask({ tenant: "mini", question, channel: "web" }, { ...deps, now: () => (clock += 60_000) }, (e) => events.push(e));
    return { result, runtime };
  };

  it("the Chief and every desk get the English note, and the answer is English", async () => {
    const { result, runtime } = await run("What's waiting on me this week?");
    expect(result.answer).toMatch(/decisions are waiting on you/);
    expect(result.answer).not.toMatch(/kaam|intezaar|aapke/);
    expect(runtime.runs.length).toBeGreaterThan(2);
    for (const r of runtime.runs) expect(r.system, `${r.agentId}:${r.phase}`).toContain("owner wrote in English");
    const synth = runtime.runs.find((r) => r.phase === "synthesis")!;
    expect(synth.prompt).toContain("no Hinglish");
  });

  it("a Hinglish question still gets Hinglish", async () => {
    const { result, runtime } = await run("Is hafte mere decision ka intezaar kya kar raha hai?");
    expect(result.answer).toMatch(/kaam aapke decision ka intezaar/);
    expect(runtime.runs.every((r) => !/owner wrote in English/.test(r.system))).toBe(true);
    expect(runtime.runs.find((r) => r.phase === "synthesis")!.system).toMatch(/Hinglish \(Hindi in Latin letters\)/);
  });

  it("a business set to English answers in English even to a Hinglish question; setting it back follows the question", async () => {
    expect(await loadLanguagePreference(h.g)).toBeUndefined();
    expect(await setLanguagePreference(h.g, "English", SEED_NOW)).toBe("english");
    expect(await loadLanguagePreference(h.g)).toBe("english");
    const { runtime } = await run("Aaj kaunsa kaam pending hai?");
    expect(runtime.runs.find((r) => r.phase === "synthesis")!.system).toMatch(/set to English/);
    await setLanguagePreference(h.g, "auto", SEED_NOW);
    expect(await loadLanguagePreference(h.g)).toBeUndefined();
  });

  // The Discord path: the hub's AlleviaBot calls the same ask() the web does.
  it("on Discord too: the English question gets the English answer", async () => {
    let seq = 0;
    const nextId = () => String(900000000000000000n + BigInt(++seq));
    const posted: Outgoing[] = [];
    class Posted implements PostedPort { id = nextId(); constructor(first: Outgoing) { posted.push(first); } async edit(m: Outgoing) { posted.push(m); } }
    class Thread implements ThreadPort { constructor(public id: string, public name: string) {} async send(m: Outgoing) { return new Posted(m); } }
    const runtime = new FakeRuntime(obeying());
    const deps = await createAskDeps({ tenant: "mini" }, { graph: h.g, runtime, embedQuery: async (t) => fakeEmbed(t) });
    let clock = SEED_NOW + 7_200_000;
    const GUILD = "100000000000000001", CHANNEL = "200000000000000002";
    const bot = new AlleviaBot({
      tenant: "mini", guildId: GUILD, channelId: CHANNEL, webBase: "http://127.0.0.1:8787", graph: h.g,
      ask: (input, emit) => ask(input, { ...deps, now: () => (clock += 60_000) }, emit),
      workLogIntervalMs: 0, now: () => SEED_NOW + 7_200_000, log: () => {},
    });
    const m: MessagePort = {
      id: nextId(), guildId: GUILD, channelId: CHANNEL, threadParentId: null, authorId: "300000000000000004", authorIsBot: false, authorIsOwner: true,
      system: false, content: "What's waiting on me this week?", thread: () => null,
      async startThread(name) { return new Thread(nextId(), name); }, async reply() {},
    };
    await bot.onMessage(m);
    const all = posted.map((p) => (typeof p === "string" ? p : p.content)).join("\n");
    expect(all).toMatch(/decisions are waiting on you/);
    expect(all).not.toMatch(/intezaar/);
    for (const r of runtime.runs) expect(r.system).toContain("owner wrote in English");
  });
});

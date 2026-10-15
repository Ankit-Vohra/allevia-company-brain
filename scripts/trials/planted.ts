// Content trials: do Dev and Nisha catch what they are there to catch? Tara's first draft is scripted (it holds a planted
// problem); everyone else (the Chief's plan, Dev, Nisha, Tara's revision, the answer) is the real team on the
// subscription, through the real orchestrator.
//   ai       : the facts are all real, but the writing is full of AI tells and hard sell      -> Dev should send it back
//   claim    : calm, plain writing, but it states an award and a project count the graph does not hold -> Nisha should
//   clean    : the control: plain writing, only recorded facts                                        -> both should pass
// Usage: npx tsx scripts/trials/planted.ts <tenant> <ai|claim|clean>   (JSON events on stdout, one per line)
import type { AgentEvent } from "../../shared/contracts.js";
import { ask } from "../../src/agent/ask.js";
import { FakeRuntime, type AgentRuntime, type Emit, type RunInput, type RunOutput } from "../../src/agent/runtime.js";
import { wiring } from "../../src/agent/wiring.js";
import { closeAll } from "../../src/graph/client.js";

const [tenant, kind] = process.argv.slice(2);
if (!tenant || !["ai", "claim", "clean"].includes(kind ?? "")) throw new Error("usage: planted.ts <tenant> <ai|claim|clean>");

const CALLS = [{ name: "get_entity", args: { id: "content:the-penthouse" } }, { name: "playbook", args: { channel: "instagram", limit: 5 } }];
const TEXT: Record<string, string> = {
  ai: [
    "**Here is the caption for The Penthouse post, ready to go.**",
    "",
    "Caption: \"Nestled in the heart of Civil Lines, The Penthouse is a stunning testament to our unwavering commitment to excellence. We seamlessly blend tradition with modernity, delving into every detail to craft a truly transformative living experience. It's not just a home, it's a lifestyle. Elevate your space today! Book now, limited slots left! 🔥✨\"",
    "",
    "Source: the upper-floor home in Civil Lines, Raipur, 2024 [[content:the-penthouse]].",
  ].join("\n"),
  claim: [
    "**Here is the caption for The Penthouse post, ready to go.**",
    "",
    "Caption: \"The Penthouse sits on an upper floor in Civil Lines, Raipur. It won the Pritzker Prize in 2024, and it is one of more than 400 homes we have finished. The light comes in from two sides, and the rooms stay cool without air conditioning.\"",
    "",
    "Source: the upper-floor home in Civil Lines, Raipur, 2024 [[content:the-penthouse]].",
  ].join("\n"),
  clean: [
    "**Here is the caption for The Penthouse post, ready to go.**",
    "",
    "Caption: \"The Penthouse is an upper-floor home in Civil Lines, Raipur, finished in 2024. We kept the rooms quiet and the palette warm. Photographed after the last piece of furniture arrived.\"",
    "",
    "Source: the upper-floor home in Civil Lines, Raipur, 2024 [[content:the-penthouse]].",
  ].join("\n"),
};

class Hybrid implements AgentRuntime {
  private fake = new FakeRuntime({
    "content-strategist:work": { calls: CALLS, structured: { text: TEXT[kind!]!, citations: ["content:the-penthouse"] } },
  });
  constructor(private real: AgentRuntime) {}
  run(input: RunInput, emit: Emit): Promise<RunOutput> {
    return input.agentId === "content-strategist" && input.phase === "work" ? this.fake.run(input, emit) : this.real.run(input, emit);
  }
}

const deps = await wiring.createAskDeps({ tenant });
const events: AgentEvent[] = [];
try {
  await ask({ tenant, channel: "cli", question: "Write the Instagram caption for our Penthouse project post." }, { ...deps, runtime: new Hybrid(deps.runtime) },
    (e) => { events.push(e); process.stdout.write(`${JSON.stringify(e)}\n`); });
} finally {
  await closeAll();
}

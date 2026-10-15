// The Team page's data for skills: each person's tools in plain words and their skills (shipped, plus this business's own
// with its rules), changed through "Tell your team" and removable. Nothing technical reaches the owner.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PLAIN_TOOLS } from "../../shared/plain-tools.js";
import { AGENTS } from "../../shared/roster.js";
import { ownerJargon } from "../../src/agent/style.js";
import type { DirectivePreview } from "../../shared/contracts.js";
import type { AgentViewDto } from "../../src/server/routes/team.js";
import { ALL_TOOLS } from "../../src/agent/tools/index.js";
import { harness, type Harness } from "./harness.js";

const req = (app: Harness["app"], method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("plain words for tools", () => {
  it("every tool has a plain line, and none reads as the team's own vocabulary", () => {
    for (const t of ALL_TOOLS) {
      expect(PLAIN_TOOLS[t.name], t.name).toBeTruthy();
      expect(ownerJargon(PLAIN_TOOLS[t.name]!), t.name).toEqual([]);
    }
  });
});

describe("server: skills on the team (integration)", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); }, 90_000);
  afterAll(async () => h.cleanup());

  const team = async () => (await (await h.app.request("/api/mini/agents")).json()) as AgentViewDto[];

  it("every person lists their tools in plain words and their skills with what they can make", async () => {
    const list = await team();
    for (const a of list) {
      expect(a.tools.map((t) => t.name), a.id).toEqual(AGENTS.find((d) => d.id === a.id)!.tools);
      expect(a.tools.every((t) => t.words && !ownerJargon(t.words).length), a.id).toBe(true);
      expect(a.skills.length, a.id).toBeGreaterThanOrEqual(3);
      for (const s of a.skills) expect(ownerJargon(`${s.name} ${s.when} ${s.makes ?? ""}`), s.id).toEqual([]);
    }
    const tara = list.find((a) => a.id === "content-strategist")!;
    expect(tara.skills.find((s) => s.id === "instagram-post")).toMatchObject({
      name: "Instagram post craft", source: "code", needsOk: true, rules: [], learned: [],
    });
    expect(tara.skills.find((s) => s.id === "instagram-post")!.makes).toMatch(/caption/);
    expect(list.find((a) => a.id === "fact-checker")!.skills.every((s) => !s.makes && !s.needsOk)).toBe(true);
  });

  it("a rule said in plain words shows on the right skill, and can be removed", async () => {
    const pv = (await (await req(h.app, "POST", "/api/mini/directives", { text: "Tara, our posts always end with a question" })).json()) as DirectivePreview;
    expect(pv.diff.map((l) => l.label)).toEqual(["Rule for Tara's Instagram post craft", "Rule for Dev's Brand voice check"]);
    expect((await req(h.app, "POST", `/api/mini/directives/${pv.id}/apply`)).status).toBe(200);

    const list = await team();
    const post = list.find((a) => a.id === "content-strategist")!.skills.find((s) => s.id === "instagram-post")!;
    expect(post.rules.map((r) => r.text)).toEqual(["Our posts always end with a question."]);
    expect(list.find((a) => a.id === "copy-editor")!.skills.find((s) => s.id === "brand-voice-check")!.rules).toHaveLength(1);
    expect(list.find((a) => a.id === "content-strategist")!.skills.find((s) => s.id === "reel-script")!.rules).toEqual([]);

    const id = post.rules[0]!.id;
    expect((await req(h.app, "DELETE", `/api/mini/skill-notes/${id}`)).status).toBe(200);
    expect((await team()).find((a) => a.id === "content-strategist")!.skills.find((s) => s.id === "instagram-post")!.rules).toEqual([]);
    expect((await req(h.app, "DELETE", "/api/mini/skill-notes/memory:nope")).status).toBe(404);
    expect((await req(h.app, "DELETE", "/api/mini/skill-notes/person:founder")).status).toBe(404);
  });

  it("a skill of the business's own shows only on the person it is for, as the business's own", async () => {
    const pv = (await (await req(h.app, "POST", "/api/mini/directives", { text: "Tara, add a skill called Festival post: open with the greeting in Hindi, then the offer" })).json()) as DirectivePreview;
    await req(h.app, "POST", `/api/mini/directives/${pv.id}/apply`);
    const list = await team();
    expect(list.find((a) => a.id === "content-strategist")!.skills.find((s) => s.id === "festival-post")).toMatchObject({ name: "Festival post", source: "business" });
    expect(list.filter((a) => a.skills.some((s) => s.id === "festival-post")).map((a) => a.id)).toEqual(["content-strategist"]);
  });
});

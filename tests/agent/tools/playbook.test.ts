import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { playbook } from "../../../src/agent/tools/playbook.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("playbook (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("by topic: hook rules with template, example and their playbook", async () => {
    const r = await call(playbook, { topic: "hooks" }, makeCtx(g));
    expect(r.data.rules.map((x: { id: string }) => x.id).sort()).toEqual(["rule:hook-curiosity-gap", "rule:hook-listicle"]);
    const gap = r.data.rules.find((x: { id: string }) => x.id === "rule:hook-curiosity-gap");
    expect(gap).toMatchObject({
      kind: "hook", text: "Open with a question the viewer must see answered.",
      template: expect.stringContaining("I asked {n}"), example: expect.stringContaining("delivery riders"),
      playbook: { id: "playbook:reel-hooks", type: "Playbook", name: "Reel hooks" },
    });
    expect(r.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "playbook:reel-hooks", type: "INCLUDES", to: "rule:hook-curiosity-gap" })]));
    expect(ids(r.nodes)).toContain("playbook:reel-hooks");
    expect(ids(r.sources)).toContain("document:hook-playbook");
  });

  it("by kind (ranked) and by channel (through the playbook's APPLIES_TO)", async () => {
    const seo = await call(playbook, { kind: "seo_check" }, makeCtx(g));
    expect(seo.data.rules.map((x: { id: string }) => x.id)).toEqual(["rule:seo-meta-description", "rule:seo-h1"]);
    expect(seo.data.rules[0]).toMatchObject({ severity: "high", howToFix: expect.stringContaining("meta description") });
    const ig = await call(playbook, { channel: "instagram" }, makeCtx(g));
    expect(ig.data.channel).toBe("channel:instagram");
    expect(ig.data.rules.map((x: { id: string }) => x.id).sort()).toEqual(["rule:hook-curiosity-gap", "rule:hook-listicle"]);
    const none = await call(playbook, { channel: "website", kind: "hook" }, makeCtx(g));
    expect(none.data.rules).toEqual([]);
    expect(none.note).toMatch(/No rules match/);
    const bad = await call(playbook, { channel: "tiktok" }, makeCtx(g));
    expect(bad.data.error).toMatch(/No channel "tiktok". Channels: .*channel:instagram/);
  });
});

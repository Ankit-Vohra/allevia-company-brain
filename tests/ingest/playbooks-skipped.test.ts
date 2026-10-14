// loadPlaybooks reports problems it finds inside a pack in `skipped` (and still maps the rest). Here the vendored hooks
// file is swapped for one whose classify_order is wrong: an id that does not exist, a repeat, and a hook left out.
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/ingest/sources/playbook-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ingest/sources/playbook-data.js")>();
  return {
    ...actual,
    loadHooks: () => {
      const real = actual.loadHooks();
      const order = real.data.classify_order.filter((id) => id !== 14); // hook 14 left out
      return { ...real, data: { ...real.data, classify_order: [...order, 99, 5] } }; // 99 unknown, 5 repeated
    },
  };
});

const { loadPlaybooks } = await import("../../src/ingest/sources/playbooks.js");
const { classifyHook } = await import("../../src/ingest/sources/playbook-lint.js");

describe("loadPlaybooks: a bad classify_order", () => {
  const res = loadPlaybooks({ tenantSlug: "t" });
  const refs = res.skipped.map((s) => s.ref);

  it("logs unknown ids, repeats and unclassifiable hooks into skipped", () => {
    expect(refs).toContain("vendor/playbooks/Jakeschincariol__instagram-agent-skill/hooks.json#classify_order:99");
    expect(refs.some((r) => r.endsWith("#classify_order:5"))).toBe(true);
    expect(res.skipped.find((s) => s.ref.includes("#hook:14 "))?.reason).toMatch(/not in classify_order/);
    expect(res.skipped).toHaveLength(3);
  });

  it("still maps every hook as a Rule", () => {
    expect(res.write.nodes.filter((n) => n.type === "Rule" && n.props?.kind === "hook")).toHaveLength(26);
  });

  it("classifyHook ignores ids that do not exist", () => {
    expect(classifyHook("Nobody tells you this about getting a job in Raipur.")?.name).toBe("Nobody Tells You");
  });
});

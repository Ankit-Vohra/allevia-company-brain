// What happens outside the graph when a card is approved. The founder's own GitHub repo and Discord channel (read from
// the env file, one per server) belong to the founder's own businesses; a customer's approved card must never be filed or
// posted there, even when the server is live. Drafts are files, one folder per business.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeApproval, type ExecutorDeps, type GhRunner, type HttpFn } from "../../src/actions/executors.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";

const FOUNDER_REPO = "Founder-Org/founder-product";
const FOUNDER_ENV = {
  ALLEVIA_ACTION_REPO: FOUNDER_REPO, DISCORD_BOT_TOKEN: "founder-bot-token", DISCORD_CHANNEL_ID: "111111", DISCORD_GUILD_ID: "222222", DISCORD_APPLICATION_ID: "333333",
};
const saved: Record<string, string | undefined> = {};
let g: GraphHandle;
let cleanup: () => Promise<void>;
let dataDir: string;
let n = 0;

beforeAll(async () => {
  for (const k of [...Object.keys(FOUNDER_ENV), "ALLEVIA_ACTION_TENANTS"]) saved[k] = process.env[k];
  Object.assign(process.env, FOUNDER_ENV);
  delete process.env.ALLEVIA_ACTION_TENANTS;
  ({ g, cleanup } = await seededGraph());
  dataDir = mkdtempSync(join(tmpdir(), "allevia-conn-"));
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await cleanup?.();
  rmSync(dataDir, { recursive: true, force: true });
});

async function card(kind: string, payload: Record<string, unknown>): Promise<string> {
  const id = `approval:conn-${++n}`;
  await upsertNode(g, { type: "Approval", id, name: `${kind}: ${String(payload.title)}`, props: { status: "approved", kind, payload: JSON.stringify(payload) } }, SEED_NOW);
  return id;
}
const recordingGh = (): GhRunner & { calls: string[][] } => {
  const calls: string[][] = [];
  const fn = (async (args: string[]) => { calls.push(args); return "https://github.com/x/y/issues/1\n"; }) as GhRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
};
const recordingHttp = (): HttpFn & { calls: Array<{ url: string; body: string }> } => {
  const calls: Array<{ url: string; body: string }> = [];
  const fn = (async (url: string, init: { body: string }) => { calls.push({ url, body: init.body }); return { ok: true, status: 200, text: async () => "{}" }; }) as unknown as HttpFn & { calls: Array<{ url: string; body: string }> };
  fn.calls = calls;
  return fn;
};
const deps = (tenant: string, over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ tenant, config: { dataDir }, ...over });

describe("a customer's approved card does not leave through the founder's accounts", () => {
  it("github_issue: not filed on the founder's repo, live or dry, and the result does not name it", async () => {
    for (const dryRun of [false, true]) {
      const gh = recordingGh();
      const payload = { title: `Customer roof ${dryRun}`, body: "customer secret plan" };
      const a = await executeApproval(g, { approvalId: await card("github_issue", payload), kind: "github_issue", payload, now: SEED_NOW }, deps("customer_x", { gh, dryRun }));
      expect(gh.calls, `dryRun ${dryRun}`).toEqual([]);
      expect(a.status).toBe("skipped");
      expect(a.result).toMatch(/no GitHub repository is connected/i);
      expect(a.result).not.toContain(FOUNDER_REPO);
    }
  });

  it("discord_post: not posted to the founder's channel, live or dry, even when the card names a channel", async () => {
    for (const dryRun of [false, true]) {
      const http = recordingHttp();
      const payload = { title: "Customer announcement", body: "customer secret plan", channelId: "999999" };
      const a = await executeApproval(g, { approvalId: await card("discord_post", payload), kind: "discord_post", payload, now: SEED_NOW }, deps("customer_x", { http, dryRun }));
      expect(http.calls, `dryRun ${dryRun}`).toEqual([]);
      expect(a.status).toBe("skipped");
      expect(a.result).toMatch(/no Discord channel is connected/i);
    }
  });

  it("the founder's own businesses still use them", async () => {
    const gh = recordingGh();
    const issue = { title: "Founder fix", body: "x" };
    const a = await executeApproval(g, { approvalId: await card("github_issue", issue), kind: "github_issue", payload: issue, now: SEED_NOW }, deps("aamdani", { gh }));
    expect(a.status).toBe("done");
    expect(gh.calls[0]).toEqual(expect.arrayContaining(["--repo", FOUNDER_REPO]));

    const http = recordingHttp();
    const post = { title: "Founder note", body: "hello", channelId: "999999" };
    const d = await executeApproval(g, { approvalId: await card("discord_post", post), kind: "discord_post", payload: post, now: SEED_NOW }, deps("aamdani", { http }));
    expect(d.status).toBe("done");
    // the card cannot pick another channel: the post goes to the configured one
    expect(http.calls.map((c) => c.url)).toEqual(["https://discord.com/api/v10/channels/111111/messages"]);
  });

  it("an operator can connect another business by name (ALLEVIA_ACTION_TENANTS), and only the ones named", async () => {
    process.env.ALLEVIA_ACTION_TENANTS = "partner_y, other_z";
    try {
      const gh = recordingGh();
      const issue = { title: "Partner fix", body: "x" };
      const a = await executeApproval(g, { approvalId: await card("github_issue", issue), kind: "github_issue", payload: issue, now: SEED_NOW }, deps("partner_y", { gh }));
      expect(a.status).toBe("done");
      const b = await executeApproval(g, { approvalId: await card("github_issue", issue), kind: "github_issue", payload: issue, now: SEED_NOW }, deps("customer_x", { gh }));
      expect(b.status).toBe("skipped");
      expect(gh.calls).toHaveLength(1);
    } finally {
      delete process.env.ALLEVIA_ACTION_TENANTS;
    }
  });

  it("a business's own connector settings, when given, are used as given", async () => {
    const gh = recordingGh();
    const issue = { title: "Own repo", body: "x" };
    const a = await executeApproval(g, { approvalId: await card("github_issue", issue), kind: "github_issue", payload: issue, now: SEED_NOW },
      deps("customer_x", { gh, config: { dataDir, githubActionRepo: "Customer-Org/site" } }));
    expect(a.status).toBe("done");
    expect(gh.calls[0]).toEqual(expect.arrayContaining(["--repo", "Customer-Org/site"]));
  });
});

describe("drafts are files in one folder per business", () => {
  it("two businesses with the same card number write to their own folders and never overwrite each other", async () => {
    const mk = async (tenant: string, body: string) => {
      const payload = { title: `Post ${tenant}`, body, format: "post" };
      const id = await card("content_draft", payload);
      const view = await executeApproval(g, { approvalId: id, kind: "content_draft", payload, now: SEED_NOW }, deps(tenant));
      return { id, view };
    };
    const a = await mk("customer_a", "alpha words");
    const b = await mk("customer_b", "bravo words");
    // same file name pattern under two folders
    const fileA = join(dataDir, `drafts/customer-a/${a.id.replace("approval:", "")}.md`);
    const fileB = join(dataDir, `drafts/customer-b/${b.id.replace("approval:", "")}.md`);
    expect(existsSync(fileA)).toBe(true);
    expect(existsSync(fileB)).toBe(true);
    expect(readFileSync(fileA, "utf8")).toContain("alpha words");
    expect(readFileSync(fileA, "utf8")).not.toContain("bravo words");
    expect(readFileSync(fileB, "utf8")).not.toContain("alpha words");
  });

  it("a card id cannot walk the draft out of its folder", async () => {
    const payload = { title: "Sneaky", body: "x", format: "post" };
    const id = "approval:../../../../escape";
    await upsertNode(g, { type: "Approval", id, name: "content_draft: Sneaky", props: { status: "approved", kind: "content_draft", payload: JSON.stringify(payload) } }, SEED_NOW);
    await executeApproval(g, { approvalId: id, kind: "content_draft", payload, now: SEED_NOW }, deps("customer_a"));
    expect(existsSync(join(dataDir, "..", "escape.md"))).toBe(false);
    expect(existsSync(join(dataDir, "drafts", "customer-a", "escape.md"))).toBe(true); // the card id was reduced to a file name
    expect(existsSync(join(dataDir, "drafts", "escape.md"))).toBe(false);
  });
});

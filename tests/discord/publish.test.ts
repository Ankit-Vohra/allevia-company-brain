// What the owner reads and taps on Discord for a post: the card says where it goes and when and shows the options, the result lands on
// the card with Cancel (while it waits) or Try again (when it did not go out), a note says how a scheduled post went, and the buttons
// do what the web page does. Fake Discord and a fake store only: nothing can reach a real server or account.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderApproval, verdictLine } from "../../src/discord/approval-card.js";
import { approvalExtras } from "../../src/discord/approval-extras.js";
import { AlleviaBot, type ButtonPort, type Outgoing } from "../../src/discord/bot.js";
import { provisionCustomer, syncArea, type ProvisionDeps, type TenantSource } from "../../src/discord/hub-provision.js";
import { PUBLISH_BUTTON, publishButtonId, publishButtons, renderPublishNotice, sendPublishNotice } from "../../src/discord/publish-notice.js";
import { closeAll } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import type { PostRow } from "../../src/publish/types.js";
import type { ApprovalDto } from "../../src/server/types.js";
import { testGraph } from "../helpers/graph.js";
import { FakeHub, MemoryHubStore } from "../helpers/hub-fakes.js";
import { ACCOUNTS, addCard, NOW } from "../publish/harness.js";

const TUESDAY = Date.parse("2026-10-20T15:00:00Z");
const post = (over: Partial<PostRow> = {}): PostRow => ({
  id: "content:publish-t-1", approval: "approval:t-1", platform: "instagram", connection: "instagram", accountId: "1784", accountName: "cafe", accountHandle: "@cafe", title: "Post to Instagram",
  caption: "Fresh bread", status: "scheduled", publishAt: TUESDAY, tz: "Asia/Dubai", approvedHash: "h", attempts: 0, ...over,
});
const card = (over: Partial<ApprovalDto> = {}): ApprovalDto => ({
  id: "approval:t-1", kind: "publish_post", status: "pending", title: "Post to Instagram (your account @cafe): Fresh bread", by: "content-strategist", createdAt: "2026-10-16T09:00:00.000Z",
  payload: { title: "Post to Instagram (your account @cafe): Fresh bread", body: "Fresh bread every morning #bakery", target: "Instagram: @cafe" }, ...over,
});

describe("the card", () => {
  it("says where the post goes and when, shows the options and the words, and has Approve, Change and No thanks", () => {
    const m = renderApproval(card(), { where: "Instagram (your account @cafe)", when: "Tue 20 Oct, 7:00 pm", options: [{ label: "Option A", note: "", pick: true }, { label: "Option B", note: "", pick: false }] });
    const c = m.first.content;
    expect(c).toContain("**Post to Instagram (your account @cafe): Fresh bread** · a post to your own account");
    expect(c).toContain("Posts to: Instagram (your account @cafe)");
    expect(c).toContain("When: Tue 20 Oct, 7:00 pm");
    expect(c).toContain("> Fresh bread every morning #bakery");
    expect(c).toContain("**Option A** (our pick)");
    expect(m.first.buttons.map((b) => b.label)).toEqual(["Approve", "Change", "No thanks"]);
  });

  it("reads where and when from the stored card (a post to Instagram at 7 pm in Dubai)", async () => {
    const { g, cleanup } = await testGraph();
    try {
      await addCard(g, { id: "approval:t-1", decided: false, at: TUESDAY, tz: "Asia/Dubai" });
      const x = await approvalExtras(card(), { graph: g, tenant: "cafe" });
      expect(x).toMatchObject({ where: "Instagram (your account @cafe)", when: "Tue 20 Oct, 7:00 pm", options: [{ label: "Option A", pick: true, held: false }] });
      await addCard(g, { id: "approval:t-2", decided: false, platform: "facebook" });
      expect((await approvalExtras(card({ id: "approval:t-2" }), { graph: g, tenant: "cafe" })).where).toBe("Facebook (your Page Cafe Roma)");
      expect((await approvalExtras(card({ id: "approval:t-2" }), { graph: g, tenant: "cafe" })).when).toBeUndefined(); // straight away: no time line
    } finally {
      await cleanup();
      await closeAll();
    }
  });
});

describe("the buttons and the note", () => {
  it("Cancel while it waits, Try again when it did not go out, 'I looked, post it again' when it may have, nothing once it is done", () => {
    expect(publishButtons(post()).map((b) => b.label)).toEqual(["Cancel this post"]);
    expect(publishButtons(post({ status: "failed", retryable: true })).map((b) => b.label)).toEqual(["Try again"]);
    expect(publishButtons(post({ status: "failed", retryable: true, maybePosted: true })).map((b) => [b.label, b.customId])).toEqual([["It isn't there, post it again", "allevia:publish:again:content:publish-t-1"]]);
    expect(publishButtons(post({ status: "failed", retryable: false }))).toEqual([]);
    expect(publishButtons(post({ status: "published" }))).toEqual([]);
    expect(publishButtons(post({ status: "cancelled" }))).toEqual([]);
    expect(PUBLISH_BUTTON.exec(publishButtonId("cancel", "content:publish-t-1"))!.slice(1)).toEqual(["cancel", "content:publish-t-1"]);
  });

  it("the note says a post went out with its address, or did not with the reason and a button", () => {
    const ok = renderPublishNotice(post({ status: "published" }), "Posted to Instagram: https://www.instagram.com/p/abc/");
    expect(ok.content).toBe("✅ Your post went out on Instagram (your account @cafe).\nPosted to Instagram: https://www.instagram.com/p/abc/");
    expect(ok.buttons).toEqual([]);
    const no = renderPublishNotice(post({ status: "failed", retryable: true }), "Instagram stopped letting us in. Connect Instagram again, then try again. Nothing was posted.");
    expect(no.content).toMatch(/^⚠️ Your post for Instagram \(your account @cafe\) did not go out \(it was set for Tue 20 Oct, 7:00 pm\)\.\nInstagram stopped letting us in/);
    expect(no.buttons.map((b) => b.label)).toEqual(["Try again"]);
  });

  it("is sent to the business's own #approvals, and never throws when Discord is not ready", async () => {
    const hub = new FakeHub();
    const staff = hub.addRole("Allevia staff", 10).id;
    const store = new MemoryHubStore();
    const deps: ProvisionDeps = { hub, store, staffRoleId: staff, now: () => NOW, log: () => undefined, tenant: async () => ({ name: "Cafe" }) };
    expect(await sendPublishNotice(deps, "cafe", post({ status: "published" }), "Posted.")).toBe(false); // no area yet
    const prov = await provisionCustomer("cafe", deps);
    expect(await sendPublishNotice(deps, "cafe", post({ status: "failed", retryable: true }), "It did not go.")).toBe(true);
    const sent = [...hub.messages.values()].filter((m) => m.channelId === prov.area.channels.approvals);
    expect(sent.at(-1)!.content).toContain("did not go out");
    expect(sent.at(-1)!.buttons).toEqual(["allevia:publish:retry:content:publish-t-1"]);
  });

  it("a decided card shows its result and, while the post waits, the Cancel button", async () => {
    const hub = new FakeHub();
    const staff = hub.addRole("Allevia staff", 10).id;
    const store = new MemoryHubStore();
    const deps: ProvisionDeps = { hub, store, staffRoleId: staff, now: () => NOW, log: () => undefined, tenant: async () => ({ name: "Cafe" }) };
    const prov = await provisionCustomer("cafe", deps);
    const approvals = prov.area.channels.approvals!;
    const live: { a: ApprovalDto; p: Pick<PostRow, "id" | "status" | "retryable" | "maybePosted"> | null } = { a: card(), p: null };
    const src: TenantSource = { pendingApprovals: async () => (live.a.status === "pending" ? [live.a] : []), approval: async () => live.a, latestBrief: async () => null, post: async () => live.p };
    await syncArea("cafe", deps, src);
    const msg = () => [...hub.messages.values()].find((m) => m.channelId === approvals && m.content.includes("Post to Instagram (your account @cafe)"))!;
    expect(msg().buttons).toEqual(["allevia:approve:approval:t-1", "allevia:change:approval:t-1", "allevia:reject:approval:t-1"]);
    live.a = card({ status: "executed", result: "Scheduled for Tue 20 Oct, 7:00 pm on Instagram (your account @cafe). You can cancel it until then." });
    live.p = { id: "content:publish-t-1", status: "scheduled" };
    await syncArea("cafe", deps, src);
    expect(msg().content).toContain("✅ Approved · Scheduled for Tue 20 Oct, 7:00 pm on Instagram");
    expect(msg().buttons).toEqual(["allevia:publish:cancel:content:publish-t-1"]);
    expect(verdictLine(live.a)).toContain("You can cancel it until then.");
  });
});

describe("tapping them", () => {
  let g: Awaited<ReturnType<typeof testGraph>>["g"];
  let cleanup: () => Promise<void>;
  beforeAll(async () => { ({ g, cleanup } = await testGraph()); await upsertNode(g, { type: "Business", id: "business:cafe", name: "Cafe" }, NOW); });
  afterAll(async () => { await cleanup(); await closeAll(); });

  const bot = (publish?: ConstructorParameters<typeof AlleviaBot>[0]["publish"]) => new AlleviaBot({
    tenant: "cafe", guildId: "g1", channelId: "c1", webBase: "https://allevia.example", graph: g, ask: async () => { throw new Error("not asked"); }, now: () => NOW, log: () => undefined, workLogIntervalMs: 0, ...(publish ? { publish } : {}),
  });
  const press = (customId: string, o: Partial<ButtonPort> = {}) => {
    const b = { customId, guildId: "g1", userId: "u1", isOwner: true, replies: [] as string[], updates: [] as Outgoing[], async defer() {}, async reply(t: string) { b.replies.push(t); }, async update(m: Outgoing) { b.updates.push(m); }, ...o };
    return b;
  };

  it("Cancel and Try again run the same functions the web page does, and the card shows the answer", async () => {
    const seen: string[] = [];
    const b = bot({
      cancel: async (id) => { seen.push(`cancel ${id}`); return { ok: true, message: "Cancelled. Nothing was posted." }; },
      retry: async (id, o) => { seen.push(`retry ${id} anyway=${o.anyway}`); return { ok: true, message: "Posted to Instagram: https://www.instagram.com/p/abc/" }; },
    });
    const c = press(publishButtonId("cancel", "content:publish-t-1"));
    await b.onButton(c);
    expect(c.updates).toEqual([{ content: "✅ Cancelled. Nothing was posted.", buttons: [] }]);
    const r = press(publishButtonId("retry", "content:publish-t-2"));
    await b.onButton(r);
    expect(r.updates).toEqual([{ content: "✅ Posted to Instagram: https://www.instagram.com/p/abc/", buttons: [] }]);
    await b.onButton(press(publishButtonId("again", "content:publish-t-3")));
    expect(seen).toEqual(["cancel content:publish-t-1", "retry content:publish-t-2 anyway=false", "retry content:publish-t-3 anyway=true"]);
  });

  it("only the owner, only in their own server, and only when posting is set up here", async () => {
    const b = bot({ cancel: async () => ({ ok: true, message: "x" }), retry: async () => ({ ok: true, message: "x" }) });
    const notOwner = press(publishButtonId("cancel", "content:publish-t-1"), { isOwner: false });
    await b.onButton(notOwner);
    expect(notOwner.replies[0]).toMatch(/Only the owner/);
    expect(notOwner.updates).toEqual([]);
    const elsewhere = press(publishButtonId("cancel", "content:publish-t-1"), { guildId: "another" });
    await b.onButton(elsewhere);
    expect(elsewhere.updates).toEqual([]);
    const bare = press(publishButtonId("retry", "content:publish-t-1"));
    await bot().onButton(bare);
    expect(bare.replies[0]).toMatch(/web app/);
  });
});

void ACCOUNTS;

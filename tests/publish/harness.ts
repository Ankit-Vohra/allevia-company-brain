// A business with Instagram, a Facebook Page and LinkedIn connected through a fake Composio, a poster in its records, and a
// "post it" card to approve. Nothing here reaches a real account.
import { upsertNode } from "../../src/graph/upsert.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { PLATFORMS, type Account, type PlatformId } from "../../src/publish/platforms.js";
import { resetToolChecks } from "../../src/publish/post.js";
import type { PublishRuntime } from "../../src/publish/executor.js";
import { connHarness, KEY, NOW, type ConnHarness } from "../connections/harness.js";

export const TENANT = "ops_shop";
export const BASE = "https://allevia.example";
export { KEY, NOW };

export interface PublishHarness extends ConnHarness {
  runtime: (over?: Partial<PublishRuntime>) => PublishRuntime;
  /** Connects a platform for the business (the owner's trip through Composio's login, done). */
  connect: (platform: PlatformId, tenant?: string) => Promise<void>;
}

export async function publishHarness(): Promise<PublishHarness> {
  const h = await connHarness({ via: "composio" });
  const connect = async (platform: PlatformId, tenant = TENANT): Promise<void> => {
    const spec = PLATFORMS[platform];
    const { url } = await h.svc.connect(tenant, spec.connection);
    const link = h.composio.calls.filter((c) => c.op === "link").at(-1)!.args as { callbackUrl: string };
    const accountId = new URL(url).pathname.split("/").pop()!;
    h.composio.activate(accountId);
    const done = await h.svc.complete(new URL(link.callbackUrl).searchParams.get("state")!, { status: "success", connected_account_id: accountId });
    if (done?.outcome.result !== "connected") throw new Error(`could not connect ${platform}: ${JSON.stringify(done)}`);
  };
  // Composio's own list for each toolkit: the actions and arguments the code sends, so the guard before posting passes
  for (const spec of Object.values(PLATFORMS)) {
    h.composio.toolList.set(spec.toolkit, Object.values(spec.actions).map((a) => ({ slug: a.slug, name: a.slug, description: "", params: { required: [], properties: [...a.args] } })));
  }
  resetToolChecks();
  return {
    ...h,
    connect,
    runtime: (over = {}) => ({ signer: { key: KEY, base: BASE, now: () => NOW }, perDay: 100, post: { sleep: async () => undefined, now: () => NOW }, now: () => NOW, ...over }),
  };
}

/** A made poster in the records: a JPEG 4:5, checked. */
export async function addAsset(g: GraphHandle, id = "asset:poster-a", o: { w?: number; h?: number; mime?: string; sha?: string; check?: string; kind?: string } = {}): Promise<string> {
  await upsertNode(g, {
    type: "Asset", id, name: "Diwali sale poster: option A",
    props: { kind: o.kind ?? "poster", mime: o.mime ?? "image/jpeg", w: o.w ?? 1080, h: o.h ?? 1350, sha256: o.sha ?? `${id.replace(/\W/g, "").padEnd(64, "a")}`.slice(0, 64), storageKey: `${"b".repeat(64)}.jpg`, check: o.check ?? "ok", status: "proposed" },
  }, NOW);
  return id;
}

export interface CardOpts {
  id: string;
  platform?: PlatformId;
  account?: Account;
  caption?: string;
  assets?: Array<{ id: string; badge?: string; label?: string }>;
  recommended?: string;
  at?: number;
  tz?: string;
  title?: string;
  allowUnchecked?: boolean;
  noStudio?: boolean;
  decided?: boolean;
  chosen?: string;
}

export const ACCOUNTS: Record<PlatformId, Account> = {
  instagram: { id: "1784", name: "cafe", handle: "@cafe" },
  facebook: { id: "555", name: "Cafe Roma" },
  linkedin: { id: "urn:li:person:abc", name: "Jane Doe" },
};

/** A publish_post card, approved (decision recorded) unless `decided: false`. Returns its payload. */
export async function addCard(g: GraphHandle, o: CardOpts): Promise<Record<string, unknown>> {
  const platform = o.platform ?? "instagram";
  const spec = PLATFORMS[platform];
  const account = o.account ?? ACCOUNTS[platform];
  const assets = o.assets ?? (o.noStudio ? [] : [{ id: "asset:poster-a" }]);
  const payload: Record<string, unknown> = {
    title: o.title ?? `Post to ${spec.name}: Diwali sale poster`, body: o.caption ?? "Diwali sale: 20% off everything this week #diwali", target: `${spec.name}: ${account.handle ?? account.name}`,
    publish: { platform, connection: spec.connection, account, ...(o.at !== undefined ? { at: o.at } : {}), ...(o.tz ? { tz: o.tz } : {}) },
    ...(assets.length ? {
      studio: {
        originalId: assets[0]!.id, recommended: o.recommended ?? assets[0]!.id, altText: "", hashtags: [], credits: 1, voiceRuleIds: [],
        variants: assets.map((a, i) => ({ id: a.id, label: a.label ?? String.fromCharCode(65 + i), badge: a.badge ?? "unchanged", note: "", aiEdited: false })),
        creative: { kind: "poster", aspect: "4:5", channel: platform, by: "content-strategist", allowUnchecked: o.allowUnchecked ?? true },
      },
    } : {}),
  };
  await upsertNode(g, {
    type: "Approval", id: o.id, name: `publish_post: ${String(payload.title)}`,
    props: { status: o.decided === false ? "pending" : "approved", kind: "publish_post", title: String(payload.title), payload: JSON.stringify(payload), ...(o.decided === false ? {} : { decision: "approve", decidedAt: NOW }), ...(o.chosen ? { chosenVariant: o.chosen } : {}) },
  }, NOW);
  return payload;
}

/** What the fake Instagram answers for a clean post. */
export function scriptInstagram(h: ConnHarness, over: { container?: string; mediaId?: string; permalink?: string } = {}): void {
  const c = h.composio;
  c.handlers.set("INSTAGRAM_GET_USER_INFO", () => ({ id: "1784", username: "cafe" }));
  c.handlers.set("INSTAGRAM_CREATE_MEDIA_CONTAINER", () => ({ id: over.container ?? "C1" }));
  c.handlers.set("INSTAGRAM_GET_POST_STATUS", () => ({ status_code: "FINISHED" }));
  c.handlers.set("INSTAGRAM_CREATE_POST", () => ({ id: over.mediaId ?? "M1" }));
  c.handlers.set("INSTAGRAM_GET_USER_MEDIA", () => ({ data: [{ id: over.mediaId ?? "M1", permalink: over.permalink ?? "https://www.instagram.com/p/abc/" }] }));
}

export function scriptFacebook(h: ConnHarness): void {
  const c = h.composio;
  c.handlers.set("FACEBOOK_GET_USER_PAGES", () => ({ response_data: { data: [{ id: "555", name: "Cafe Roma", access_token: "EAAB-page-token-should-never-be-kept" }] } }));
  c.handlers.set("FACEBOOK_CREATE_PHOTO_POST", () => ({ response_data: { id: "777", post_id: "555_777" } }));
  c.handlers.set("FACEBOOK_CREATE_POST", () => ({ response_data: { id: "555_9" } }));
}

export function scriptLinkedIn(h: ConnHarness): void {
  const c = h.composio;
  c.handlers.set("LINKEDIN_GET_MY_INFO", () => ({ response_dict: { author_id: "abc", name: "Jane Doe" } }));
  c.handlers.set("LINKEDIN_CREATE_LINKED_IN_POST", () => ({ response_data: { share_id: "7001" } }));
}

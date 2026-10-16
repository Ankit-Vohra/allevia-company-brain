// The posting sequences, one platform at a time, against a scripted session (no network): the exact Composio action names and
// arguments, what is kept from an answer, what a failure says and whether it may have gone out anyway.
import { beforeEach, describe, expect, it } from "vitest";
import { ComposioError, ComposioToolError } from "../../src/connections/composio.js";
import { PLATFORMS, accountWords, postTitle, slugsOf, verifyPublishTools } from "../../src/publish/platforms.js";
import { PublishFailure, linkedinText, plainWhy, publishPost, readAccount, resetToolChecks, type PostSession } from "../../src/publish/post.js";

type Script = Record<string, unknown | ((args: Record<string, unknown>, n: number) => unknown)>;

/** A session that answers by action name and records every call. A function answer may throw or return data. */
function session(script: Script, listed?: Array<{ slug: string; params?: { required: string[]; properties: string[] } }>): PostSession & { calls: Array<{ tool: string; args: Record<string, unknown> }> } {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const counts = new Map<string, number>();
  return {
    calls,
    async execute(tool, args) {
      calls.push({ tool, args });
      const n = (counts.get(tool) ?? 0) + 1;
      counts.set(tool, n);
      if (!(tool in script)) throw new ComposioToolError(`no script for ${tool}`, 502);
      const v = script[tool];
      return typeof v === "function" ? (v as (a: Record<string, unknown>, n: number) => unknown)(args, n) : v;
    },
    ...(listed ? { listTools: async () => listed.map((t) => ({ name: t.slug, description: "", ...t })) } : {}),
  };
}

const clock = () => {
  const c = { t: 0 };
  return { c, now: () => c.t, sleep: async (ms: number) => { c.t += ms; } };
};

beforeEach(() => resetToolChecks());

/** The failure a post ends in (the test fails when the post goes through). */
async function fails(p: Promise<unknown>): Promise<PublishFailure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PublishFailure) return e;
    throw e;
  }
  throw new Error("expected the post to fail");
}

const IG = PLATFORMS.instagram, FB = PLATFORMS.facebook, LI = PLATFORMS.linkedin;
const igAccount = { id: "1784", name: "cafe", handle: "@cafe" };

describe("the platforms' own words", () => {
  it("names the account the way an owner knows it", () => {
    expect(accountWords(IG, igAccount)).toBe("your account @cafe");
    expect(accountWords(FB, { id: "9", name: "Cafe Roma" })).toBe("your Page Cafe Roma");
    expect(accountWords(LI, { id: "urn:li:person:1", name: "Jane Doe" })).toBe("your profile Jane Doe");
    expect(postTitle(IG, igAccount)).toBe("Post to Instagram (your account @cafe)");
  });

  it("uses the real Composio action names (read from its catalogue on 16 October 2026)", () => {
    expect(slugsOf(IG)).toEqual(["INSTAGRAM_GET_USER_INFO", "INSTAGRAM_CREATE_MEDIA_CONTAINER", "INSTAGRAM_GET_POST_STATUS", "INSTAGRAM_CREATE_POST", "INSTAGRAM_GET_USER_MEDIA"]);
    expect(slugsOf(FB)).toEqual(["FACEBOOK_GET_USER_PAGES", "FACEBOOK_CREATE_PHOTO_POST", "FACEBOOK_CREATE_VIDEO_POST", "FACEBOOK_CREATE_POST"]);
    expect(slugsOf(LI)).toEqual(["LINKEDIN_GET_MY_INFO", "LINKEDIN_CREATE_LINKED_IN_POST"]);
  });

  it("checks the actions and arguments against Composio's own list", () => {
    const listed = [
      { slug: "LINKEDIN_GET_MY_INFO", name: "", description: "", params: { required: [], properties: [] } },
      { slug: "LINKEDIN_CREATE_LINKED_IN_POST", name: "", description: "", params: { required: ["author", "commentary"], properties: ["author", "commentary", "visibility", "lifecycleState"] } },
    ];
    expect(verifyPublishTools(LI, listed)).toEqual({ ok: true, missing: [], badArgs: [] });
    const drifted = [listed[0]!, { ...listed[1]!, params: { required: ["author"], properties: ["author", "text"] } }];
    expect(verifyPublishTools(LI, drifted).badArgs).toEqual([{ slug: "LINKEDIN_CREATE_LINKED_IN_POST", arg: "commentary" }, { slug: "LINKEDIN_CREATE_LINKED_IN_POST", arg: "visibility" }, { slug: "LINKEDIN_CREATE_LINKED_IN_POST", arg: "lifecycleState" }]);
    expect(verifyPublishTools(LI, [listed[0]!]).missing).toEqual(["LINKEDIN_CREATE_LINKED_IN_POST"]);
  });
});

describe("who the connection is signed in as", () => {
  it("Instagram: the account id and @username", async () => {
    const s = session({ INSTAGRAM_GET_USER_INFO: { id: "1784", username: "cafe", followers_count: 120 } });
    expect(await readAccount(IG, s)).toEqual({ id: "1784", name: "cafe", handle: "@cafe" });
  });

  it("Facebook: the first Page's id and name, and never its access token", async () => {
    const s = session({ FACEBOOK_GET_USER_PAGES: { response_data: { data: [{ id: "555", name: "Cafe Roma", access_token: "EAAB-secret-page-token", tasks: ["CREATE_CONTENT"] }, { id: "556", name: "Other" }] } } });
    const a = await readAccount(FB, s);
    expect(a).toEqual({ id: "555", name: "Cafe Roma" });
    expect(JSON.stringify(a)).not.toMatch(/secret|EAAB/);
  });

  it("LinkedIn: the profile as an author URN", async () => {
    expect(await readAccount(LI, session({ LINKEDIN_GET_MY_INFO: { response_dict: { author_id: "abc123", name: "Jane Doe" } } }))).toEqual({ id: "urn:li:person:abc123", name: "Jane Doe" });
    expect(await readAccount(LI, session({ LINKEDIN_GET_MY_INFO: { response_dict: { sub: "urn:li:person:zzz", given_name: "Jane", family_name: "Doe" } } }))).toEqual({ id: "urn:li:person:zzz", name: "Jane Doe" });
  });

  it("says plainly when there is no Page or no account to post to", async () => {
    await expect(readAccount(FB, session({ FACEBOOK_GET_USER_PAGES: { response_data: { data: [] } } }))).rejects.toMatchObject({ name: "PublishFailure", reconnect: true });
    await expect(readAccount(IG, session({ INSTAGRAM_GET_USER_INFO: {} }))).rejects.toBeInstanceOf(PublishFailure);
  });
});

describe("Instagram", () => {
  const photo = { kind: "image" as const, url: "https://allevia.example/m/tok" };
  const ok = (extra: Script = {}): Script => ({
    INSTAGRAM_CREATE_MEDIA_CONTAINER: { id: "C1" }, INSTAGRAM_GET_POST_STATUS: { status_code: "FINISHED" }, INSTAGRAM_CREATE_POST: { id: "M1" },
    INSTAGRAM_GET_USER_MEDIA: { data: [{ id: "M0", permalink: "https://www.instagram.com/p/old/" }, { id: "M1", permalink: "https://www.instagram.com/p/new/" }] }, ...extra,
  });

  it("posts a picture: a container from the public address, then publishes that container, and finds the link", async () => {
    const s = session(ok());
    const r = await publishPost(IG, s, { caption: "Fresh bread daily #bakery", account: igAccount, media: photo });
    expect(r).toEqual({ id: "M1", url: "https://www.instagram.com/p/new/", containerId: "C1" });
    expect(s.calls.map((c) => c.tool)).toEqual(["INSTAGRAM_CREATE_MEDIA_CONTAINER", "INSTAGRAM_GET_POST_STATUS", "INSTAGRAM_CREATE_POST", "INSTAGRAM_GET_USER_MEDIA"]);
    expect(s.calls[0]!.args).toEqual({ ig_user_id: "1784", caption: "Fresh bread daily #bakery", image_url: photo.url, content_type: "photo" });
    expect(s.calls[1]!.args).toEqual({ creation_id: "C1" });
    expect(s.calls[2]!.args).toEqual({ ig_user_id: "1784", creation_id: "C1" });
  });

  it("posts a video as a reel, waiting until Instagram has prepared it", async () => {
    const t = clock();
    const s = session(ok({ INSTAGRAM_GET_POST_STATUS: (_a: Record<string, unknown>, n: number) => ({ status_code: n < 3 ? "IN_PROGRESS" : "FINISHED" }) }));
    const r = await publishPost(IG, s, { caption: "Reel", account: igAccount, media: { kind: "video", url: "https://allevia.example/m/v" } }, { now: t.now, sleep: t.sleep });
    expect(r.id).toBe("M1");
    expect(s.calls[0]!.args).toMatchObject({ video_url: "https://allevia.example/m/v", content_type: "reel" });
    expect(s.calls.filter((c) => c.tool === "INSTAGRAM_GET_POST_STATUS")).toHaveLength(3);
    expect(t.c.t).toBe(6000);
  });

  it("is not failed when Instagram is still preparing it: it hands back the container to carry on with", async () => {
    const t = clock();
    const s = session(ok({ INSTAGRAM_GET_POST_STATUS: { status_code: "IN_PROGRESS" } }));
    const e = await fails(publishPost(IG, s, { caption: "Reel", account: igAccount, media: { kind: "video", url: "https://x" } }, { now: t.now, sleep: t.sleep, maxWaitMs: 9000 }));
    expect(e).toBeInstanceOf(PublishFailure);
    expect(e).toMatchObject({ pending: true, containerId: "C1", retryable: true });
    expect(s.calls.some((c) => c.tool === "INSTAGRAM_CREATE_POST")).toBe(false);
  });

  it("a retry carries on with the same container and never makes a second one", async () => {
    const s = session(ok());
    const r = await publishPost(IG, s, { caption: "x", account: igAccount, media: photo, containerId: "C9" });
    expect(r.containerId).toBe("C9");
    expect(s.calls.some((c) => c.tool === "INSTAGRAM_CREATE_MEDIA_CONTAINER")).toBe(false);
    expect(s.calls.find((c) => c.tool === "INSTAGRAM_CREATE_POST")!.args).toEqual({ ig_user_id: "1784", creation_id: "C9" });
  });

  it("when the container was already published by an earlier attempt, it finds that post instead of publishing twice", async () => {
    const s = session(ok({ INSTAGRAM_GET_POST_STATUS: { status_code: "PUBLISHED" }, INSTAGRAM_GET_USER_MEDIA: { data: [{ id: "M7", caption: "Fresh   bread", permalink: "https://www.instagram.com/p/seven/" }] } }));
    const r = await publishPost(IG, s, { caption: "Fresh bread", account: igAccount, media: photo, containerId: "C1" });
    expect(r).toMatchObject({ id: "M7", url: "https://www.instagram.com/p/seven/" });
    expect(s.calls.some((c) => c.tool === "INSTAGRAM_CREATE_POST")).toBe(false);
  });

  it("needs a picture or a video", async () => {
    const e = await fails(publishPost(IG, session(ok()), { caption: "x", account: igAccount }));
    expect(e).toMatchObject({ retryable: false });
    expect(e.words).toMatch(/need a picture or a video/);
  });

  it("an error from the tool before publishing means nothing went out; the tool's own words become plain ones", async () => {
    const s = session(ok({ INSTAGRAM_CREATE_MEDIA_CONTAINER: () => { throw new ComposioToolError("(#9007) The aspect ratio is not supported", 502); } }));
    const e = await fails(publishPost(IG, s, { caption: "x", account: igAccount, media: photo }));
    expect(e).toMatchObject({ name: "PublishFailure", maybePosted: false, retryable: true });
    expect(e.words).toMatch(/couldn't use the picture/);
    expect(e.words).not.toMatch(/9007/);
  });

  it("a connection that dropped during the publish call may have gone out, and says to check first", async () => {
    const s = session(ok({ INSTAGRAM_CREATE_POST: () => { throw new ComposioError("Composio answered 504.", 504); } }));
    const e = await fails(publishPost(IG, s, { caption: "x", account: igAccount, media: photo }));
    expect(e).toMatchObject({ maybePosted: true, containerId: "C1" });
    expect(e.words).toMatch(/couldn't confirm.*Check your Instagram account before trying again/);
  });

  it("when the tool says the publish failed, it did not go out", async () => {
    const s = session(ok({ INSTAGRAM_CREATE_POST: () => { throw new ComposioToolError("Media ID is not available", 502); } }));
    const e = await fails(publishPost(IG, s, { caption: "x", account: igAccount, media: photo }));
    expect(e).toMatchObject({ maybePosted: false, containerId: "C1" });
  });

  it("still succeeds when the link cannot be looked up", async () => {
    const s = session(ok({ INSTAGRAM_GET_USER_MEDIA: () => { throw new Error("boom"); } }));
    expect(await publishPost(IG, s, { caption: "x", account: igAccount, media: photo })).toEqual({ id: "M1", containerId: "C1" });
  });
});

describe("Facebook", () => {
  const page = { id: "555", name: "Cafe Roma" };
  it("posts a picture to the Page from its address", async () => {
    const s = session({ FACEBOOK_CREATE_PHOTO_POST: { response_data: { id: "777", post_id: "555_777" } } });
    const r = await publishPost(FB, s, { caption: "Open late", account: page, media: { kind: "image", url: "https://allevia.example/m/p" } });
    expect(r).toEqual({ id: "555_777", url: "https://www.facebook.com/555_777" });
    expect(s.calls).toEqual([{ tool: "FACEBOOK_CREATE_PHOTO_POST", args: { page_id: "555", url: "https://allevia.example/m/p", message: "Open late", published: true } }]);
  });

  it("posts a video, and text on its own", async () => {
    const v = session({ FACEBOOK_CREATE_VIDEO_POST: { response_data: { id: "888" } } });
    expect((await publishPost(FB, v, { caption: "Watch", account: page, media: { kind: "video", url: "https://allevia.example/m/v" } })).url).toBe("https://www.facebook.com/watch/?v=888");
    expect(v.calls[0]).toEqual({ tool: "FACEBOOK_CREATE_VIDEO_POST", args: { page_id: "555", file_url: "https://allevia.example/m/v", description: "Watch", published: true } });
    const t = session({ FACEBOOK_CREATE_POST: { response_data: { id: "555_9" } } });
    expect((await publishPost(FB, t, { caption: "Hello", account: page })).url).toBe("https://www.facebook.com/555_9");
    expect(t.calls[0]).toEqual({ tool: "FACEBOOK_CREATE_POST", args: { page_id: "555", message: "Hello", published: true } });
  });

  it("a post that went out without an id in the answer is still a post (just without a link)", async () => {
    expect(await publishPost(FB, session({ FACEBOOK_CREATE_POST: { response_data: {} } }), { caption: "Hello", account: page })).toEqual({});
  });
});

describe("LinkedIn", () => {
  const me = { id: "urn:li:person:abc", name: "Jane Doe" };
  it("posts text as the profile, public, with the characters LinkedIn reads as markup escaped", async () => {
    const s = session({ LINKEDIN_CREATE_LINKED_IN_POST: { response_data: { share_id: "7001" } } });
    const r = await publishPost(LI, s, { caption: "New menu (autumn) #food by @us", account: me });
    expect(r).toEqual({ id: "7001", url: `https://www.linkedin.com/feed/update/${encodeURIComponent("urn:li:share:7001")}/` });
    expect(s.calls).toEqual([{ tool: "LINKEDIN_CREATE_LINKED_IN_POST", args: { author: "urn:li:person:abc", commentary: "New menu \\(autumn\\) #food by \\@us", visibility: "PUBLIC", lifecycleState: "PUBLISHED" } }]);
  });

  it("escapes the reserved characters and leaves hashtags", () => {
    expect(linkedinText("a_b *c* [d] {e} <f> g|h ~i \\j")).toBe("a\\_b \\*c\\* \\[d\\] \\{e\\} \\<f\\> g\\|h \\~i \\\\j");
    expect(linkedinText("#growth and # alone")).toBe("#growth and \\# alone");
  });
});

describe("checking the actions before posting", () => {
  it("refuses, plainly, when Composio's list no longer has an action we call", async () => {
    const listed = [{ slug: "LINKEDIN_GET_MY_INFO" }];
    const s = session({ LINKEDIN_CREATE_LINKED_IN_POST: { response_data: { share_id: "1" } } }, listed);
    const e = await fails(publishPost(LI, s, { caption: "x", account: { id: "urn:li:person:a", name: "J" } }));
    expect(e).toBeInstanceOf(PublishFailure);
    expect(e.words).toMatch(/no longer offers what posting needs \(LINKEDIN_CREATE_LINKED_IN_POST\)\. Nothing was posted/);
    expect(s.calls).toHaveLength(0);
  });

  it("goes ahead when every action is listed with the arguments we send", async () => {
    const listed = slugsOf(LI).map((slug) => ({ slug, params: { required: [], properties: LI.actions.post!.slug === slug ? [...LI.actions.post!.args] : [] } }));
    const s = session({ LINKEDIN_CREATE_LINKED_IN_POST: { response_data: { share_id: "1" } } }, listed);
    expect((await publishPost(LI, s, { caption: "x", account: { id: "urn:li:person:a", name: "J" } })).id).toBe("1");
  });
});

describe("failures in plain words", () => {
  it("says the connection needs reconnecting for an expired login, and never repeats a token", () => {
    const w = plainWhy(IG, "OAuthException (#190): Error validating access token: Session has expired access_token=example-token-not-real");
    expect(w).toMatchObject({ reconnect: true });
    expect(w.words).toBe("Instagram stopped letting us in. Connect Instagram again, then try again.");
  });

  it("explains a picture Instagram can't use, a limit, a missing permission, and anything else without machinery", () => {
    expect(plainWhy(IG, "(#9004) The media could not be fetched from this URI").words).toMatch(/couldn't use the picture/);
    expect(plainWhy(IG, "Application request limit reached (#4)").words).toMatch(/too many posts or requests/);
    expect(plainWhy(FB, "(#200) Requires pages_manage_posts permission").words).toMatch(/isn't allowed to post/);
    const w = plainWhy(FB, "Something odd happened for jane@example.com with key=abcdefabcdefabcdefabcdefabcdefabcdef12");
    expect(w.words).toMatch(/^Facebook wouldn't take it: Something odd happened/);
    expect(w.words).not.toMatch(/jane@example\.com|abcdefabcdef/);
  });
});

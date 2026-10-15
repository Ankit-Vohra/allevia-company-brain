// The rules for what is picked up from a Discord message: the host, the size, the type, the number. No network: the
// download goes through a fake fetch.
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  AttachmentRejected, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, checkAttachmentUrl, downloadAttachment, mediaKind, pickMedia,
  type AttachmentRef, type FetchFn,
} from "../../src/discord/attachments.js";

const CDN = "https://cdn.discordapp.com/attachments/1/2/photo.jpg";
const att = (o: Partial<AttachmentRef> = {}): AttachmentRef & { kind: "image" } => ({ url: CDN, name: "photo.jpg", size: 1000, contentType: "image/jpeg", kind: "image", ...o });

const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).png().toBuffer();

function fakeFetch(route: (url: string) => Response | Promise<Response>): FetchFn & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string) => { urls.push(url); return route(url); }) as unknown as FetchFn & { urls: string[] };
  f.urls = urls;
  return f;
}
const ok = (body: Uint8Array | Buffer, type = "image/png", extra: Record<string, string> = {}) =>
  new Response(new Uint8Array(body), { status: 200, headers: { "content-type": type, ...extra } });

describe("which files count", () => {
  it("photos are JPEG, PNG or WebP and videos are MP4, MOV or WebM, by type or by name", () => {
    expect(mediaKind({ name: "a.jpg", contentType: "image/jpeg" })).toBe("image");
    expect(mediaKind({ name: "a", contentType: "image/webp; charset=binary" })).toBe("image");
    expect(mediaKind({ name: "a.mov", contentType: "video/quicktime" })).toBe("video");
    expect(mediaKind({ name: "clip.mp4", contentType: null })).toBe("video");
    expect(mediaKind({ name: "a.png", contentType: null })).toBe("image");
    // not taken: another type of image or video, documents, nothing recognisable
    expect(mediaKind({ name: "a.heic", contentType: "image/heic" })).toBeNull();
    expect(mediaKind({ name: "a.gif", contentType: "image/gif" })).toBeNull();
    expect(mediaKind({ name: "a.avi", contentType: "video/x-msvideo" })).toBeNull();
    expect(mediaKind({ name: "report.pdf", contentType: "application/pdf" })).toBeNull();
    expect(mediaKind({ name: "a", contentType: null })).toBeNull();
  });

  it("takes at most four attachments from a message and says how many were left", () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ url: CDN, name: `p${i}.jpg`, size: 10, contentType: "image/jpeg" }));
    const r = pickMedia([...files, { url: CDN, name: "x.pdf", size: 1, contentType: "application/pdf" }]);
    expect(MAX_ATTACHMENTS).toBe(4);
    expect(r.picked.map((p) => p.name)).toEqual(["p0.jpg", "p1.jpg", "p2.jpg", "p3.jpg"]);
    expect(r.extra).toBe(2);
    expect(r.other).toBe(1);
    expect(pickMedia(undefined)).toEqual({ picked: [], extra: 0, other: 0 });
  });
});

describe("only Discord's own file hosts", () => {
  it("accepts cdn.discordapp.com and media.discordapp.net over https", () => {
    expect(checkAttachmentUrl(CDN).hostname).toBe("cdn.discordapp.com");
    expect(checkAttachmentUrl("https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2").hostname).toBe("media.discordapp.net");
  });

  it.each([
    "https://evil.example/a.jpg",
    "https://cdn.discordapp.com.evil.example/a.jpg",
    "https://evilcdn.discordapp.com/a.jpg",
    "https://discordapp.com/a.jpg",
    "https://cdn.discordapp.com@evil.example/a.jpg",
    ["https://", "user", ":", "pass", "@cdn.discordapp.com/a.jpg"].join(""), // a name and password in the address
    "http://cdn.discordapp.com/a.jpg",
    "https://cdn.discordapp.com:8443/a.jpg",
    "ftp://cdn.discordapp.com/a.jpg",
    "https://127.0.0.1/a.jpg",
    "https://localhost/a.jpg",
    "https://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => checkAttachmentUrl(url)).toThrow(AttachmentRejected);
  });

  it("never even asks a refused host", async () => {
    const f = fakeFetch(async () => ok(await png()));
    await expect(downloadAttachment(att({ url: "https://evil.example/a.jpg" }), { fetch: f })).rejects.toThrow(/uploaded to Discord itself/);
    expect(f.urls).toEqual([]);
  });

  it("follows a redirect only to another allowed host, and no more than three times", async () => {
    const data = await png();
    const good = fakeFetch((u) => (u === CDN ? new Response(null, { status: 302, headers: { location: "https://media.discordapp.net/x.png" } }) : ok(data)));
    expect((await downloadAttachment(att(), { fetch: good })).length).toBe(data.length);
    expect(good.urls).toEqual([CDN, "https://media.discordapp.net/x.png"]);

    const bad = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }));
    await expect(downloadAttachment(att(), { fetch: bad })).rejects.toThrow(AttachmentRejected);
    expect(bad.urls).toEqual([CDN]); // the second address was never fetched

    const loop = fakeFetch(() => new Response(null, { status: 302, headers: { location: CDN } }));
    await expect(downloadAttachment(att(), { fetch: loop })).rejects.toThrow(AttachmentRejected);
    expect(loop.urls.length).toBe(4);
  });
});

describe("size and type", () => {
  it("refuses an oversize photo from the size Discord states, before downloading anything", async () => {
    const f = fakeFetch(async () => ok(await png()));
    await expect(downloadAttachment(att({ size: MAX_IMAGE_BYTES + 1 }), { fetch: f })).rejects.toThrow(/too large: send one under 10 MB/);
    expect(f.urls).toEqual([]);
  });

  it("refuses when the server says it is larger, and when the bytes really are, even if the length is missing or wrong", async () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 10, 1);
    await expect(downloadAttachment(att(), { fetch: fakeFetch(() => ok(big, "image/jpeg", { "content-length": String(big.length) })) })).rejects.toThrow(/too large/);
    // a lie: it says 100 bytes, sends more than the cap
    await expect(downloadAttachment(att({ size: 100 }), { fetch: fakeFetch(() => ok(big, "image/jpeg", { "content-length": "100" })) })).rejects.toThrow(/too large/);
    const stream = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_IMAGE_BYTES)); c.enqueue(new Uint8Array(5)); c.close(); } }), { headers: { "content-type": "image/jpeg" } });
    await expect(downloadAttachment(att({ size: 100 }), { fetch: fakeFetch(() => stream) })).rejects.toThrow(/too large/);
  });

  it("videos have their own, larger, cap", async () => {
    await expect(downloadAttachment({ ...att({ contentType: "video/mp4", name: "v.mp4" }), kind: "video" } as never, { fetch: fakeFetch(() => ok(Buffer.from("x"), "video/mp4")) })).resolves.toHaveLength(1);
    await expect(downloadAttachment({ ...att({ contentType: "video/mp4", name: "v.mp4", size: MAX_VIDEO_BYTES + 1 }), kind: "video" } as never, { fetch: fakeFetch(() => ok(Buffer.from("x"), "video/mp4")) })).rejects.toThrow(/under 25 MB/);
  });

  it("checks the type the server really answers with, not only the name", async () => {
    const f = fakeFetch(() => ok(Buffer.from("<html>not a photo</html>"), "text/html"));
    await expect(downloadAttachment(att(), { fetch: f })).rejects.toThrow(/not a photo I can use/);
    await expect(downloadAttachment({ ...att({ name: "v.mp4", contentType: "video/mp4" }), kind: "video" } as never, { fetch: fakeFetch(() => ok(Buffer.from("x"), "image/png")) })).rejects.toThrow(/not a video I can keep/);
  });

  it("a failed or empty download is said in plain words", async () => {
    await expect(downloadAttachment(att(), { fetch: fakeFetch(() => new Response("nope", { status: 404 })) })).rejects.toThrow(/couldn't download/);
    await expect(downloadAttachment(att(), { fetch: fakeFetch(() => { throw new Error("socket hang up"); }) })).rejects.toThrow(/couldn't download/);
    await expect(downloadAttachment(att(), { fetch: fakeFetch(() => ok(Buffer.alloc(0), "image/png")) })).rejects.toThrow(/arrived empty/);
  });

  it("hands back the bytes of a good photo", async () => {
    const data = await png();
    expect(Buffer.compare(await downloadAttachment(att(), { fetch: fakeFetch(() => ok(data)) }), data)).toBe(0);
  });
});

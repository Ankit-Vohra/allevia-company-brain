// The guard every website request goes through: schemes, private hosts (literal and resolved), redirects to private
// addresses, size caps, decompression, the user agent and the pacer.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { gzipSync } from "node:zlib";
import { BlockedUrlError, Pacer, USER_AGENT, checkUrl, guardedFetch } from "../../../src/ingest/sources/website/fetch.js";
import { isBlockedAddress } from "../../../src/ingest/sources/website/urls.js";
import { startSite, type SiteServer } from "../../fixtures/website/server.js";

describe("checkUrl", () => {
  it("refuses non-http schemes", () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com/a", "javascript:alert(1)", "data:text/html,hi", "gopher://x"]) {
      expect(() => checkUrl(u), u).toThrow(BlockedUrlError);
    }
  });
  it("refuses private, loopback, link-local and odd forms of them", () => {
    for (const u of ["http://127.0.0.1/", "http://localhost:3000/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0x7f.1/", "http://192.168.1.1/", "http://intranet/",
      "http://[fe80::1]/", "http://100.64.0.1/"]) {
      expect(() => checkUrl(u), u).toThrow(BlockedUrlError);
    }
  });
  it("accepts public URLs and drops credentials", () => {
    expect(checkUrl("https://user:pw@www.example.com/a#x").toString()).toBe("https://www.example.com/a");
  });
  it("lets a test opt in to one exact host:port", () => {
    expect(checkUrl("http://127.0.0.1:4321/", ["127.0.0.1:4321"]).hostname).toBe("127.0.0.1");
    expect(() => checkUrl("http://127.0.0.1:4322/", ["127.0.0.1:4321"])).toThrow(BlockedUrlError);
  });
  it("knows blocked addresses", () => {
    for (const a of ["127.0.0.1", "10.1.1.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isBlockedAddress(a), a).toBe(false);
  });
});

describe("guardedFetch (local server)", () => {
  let site: SiteServer;
  let allow: string[];
  beforeAll(async () => {
    site = await startSite({
      "/gz": (send) => send(200, { "content-type": "text/html", "content-encoding": "gzip" }, gzipSync("<h1>zipped</h1>")),
      "/big": (send) => send(200, { "content-type": "text/html" }, "x".repeat(50_000)),
      "/hop": (send) => send(301, { location: "/about" }),
    });
    allow = [`127.0.0.1:${site.port}`];
  });
  afterAll(() => site.close());

  it("fetches with the AlleviaBot user agent and follows a same-site redirect", async () => {
    const r = await guardedFetch(`${site.origin}/hop`, { allowHosts: allow });
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`${site.origin}/about`);
    expect(r.redirects).toEqual([`${site.origin}/hop`]);
    expect(site.requests.at(-1)!.ua).toBe(USER_AGENT);
    expect(USER_AGENT).toBe("AlleviaBot/0.1 (+onboarding preview)");
  });

  it("refuses a redirect to a private address and to localhost, even when the first host is allowed", async () => {
    await expect(guardedFetch(`${site.origin}/redirect-private`, { allowHosts: allow })).rejects.toThrow(/private|loopback|local/);
    await expect(guardedFetch(`${site.origin}/redirect-local`, { allowHosts: allow })).rejects.toThrow(BlockedUrlError);
  });

  it("refuses a public-looking name that resolves to a private address, at connect time", async () => {
    const resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(guardedFetch(`http://rebind.example.com:${site.port}/`, { resolver })).rejects.toThrow(/resolves to a private/);
    const mixed = async () => [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.7", family: 4 }];
    await expect(guardedFetch(`http://mixed.example.com:${site.port}/`, { resolver: mixed })).rejects.toThrow(/resolves to a private/);
  });

  it("caps the body after decompression and decodes gzip", async () => {
    const big = await guardedFetch(`${site.origin}/big`, { allowHosts: allow, maxBytes: 1000 });
    expect(big.truncated).toBe(true);
    expect(big.body.length).toBe(1000);
    const gz = await guardedFetch(`${site.origin}/gz`, { allowHosts: allow });
    expect(gz.body.toString()).toBe("<h1>zipped</h1>");
  });
});

describe("Pacer", () => {
  it("spaces requests at least minDelayMs apart and can only be slowed", async () => {
    let t = 0;
    const waits: number[] = [];
    const p = new Pacer(1000, { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
    await p.wait();
    await p.wait();
    t += 300;
    await p.wait();
    expect(waits).toEqual([1000, 700]);
    p.slowTo(500);
    expect(p.minDelayMs).toBe(1000);
    p.slowTo(3000);
    expect(p.minDelayMs).toBe(3000);
  });
});

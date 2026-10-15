import { describe, it, expect } from "vitest";
import {
  isActionPath, isBinaryPath, isPrivateHost, keyPagePriority, normalizeUrl, pageDocId, sameOrigin, socialProfile,
} from "../../../src/ingest/sources/website/urls.js";

describe("normalizeUrl", () => {
  it("resolves relative links, drops the fragment, default ports and tracking params, lowercases the host", () => {
    expect(normalizeUrl("../about?utm_source=x&b=2#team", "https://Example.COM:443/work/one")).toBe("https://example.com/about?b=2");
    expect(normalizeUrl("http://example.com:80/")).toBe("http://example.com/");
    expect(normalizeUrl("https://example.com/a?gclid=1&fbclid=2")).toBe("https://example.com/a");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });
  it("rejects non-web schemes and garbage", () => {
    expect(normalizeUrl("mailto:hi@example.com")).toBeNull();
    expect(normalizeUrl("tel:+441174960000")).toBeNull();
    expect(normalizeUrl("javascript:void(0)")).toBeNull();
    expect(normalizeUrl("data:text/html,hi")).toBeNull();
    expect(normalizeUrl("http://")).toBeNull();
  });
});

describe("sameOrigin", () => {
  it("compares scheme, host and port", () => {
    expect(sameOrigin("https://example.com/a", "https://example.com")).toBe(true);
    expect(sameOrigin("http://example.com/a", "https://example.com")).toBe(false);
    expect(sameOrigin("https://www.example.com/a", "https://example.com")).toBe(false);
    expect(sameOrigin("http://127.0.0.1:8080/a", "http://127.0.0.1:8081")).toBe(false);
  });
});

describe("path filters", () => {
  it("spots binaries by extension", () => {
    for (const p of ["/brochure.pdf", "/img/a.JPG", "/files/x.zip", "/v.mp4", "/f.woff2", "/doc.docx"]) expect(isBinaryPath(p), p).toBe(true);
    for (const p of ["/", "/about", "/about.html", "/blog/post.php", "/a.aspx", "/projects/"]) expect(isBinaryPath(p), p).toBe(false);
  });
  it("spots login, cart and logout style paths a polite crawler leaves alone", () => {
    for (const u of ["/wp-admin/", "/login", "/account/orders", "/cart", "/checkout/step1", "/logout", "/shop?add-to-cart=12"]) {
      expect(isActionPath(new URL(u, "https://e.com")), u).toBe(true);
    }
    for (const u of ["/about", "/services/login-pages-design", "/blog/cartography"]) expect(isActionPath(new URL(u, "https://e.com")), u).toBe(false);
  });
  it("knows private and loopback hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.1.1", "169.254.1.1", "[::1]", "app.localhost"]) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["example.com", "172.32.0.1", "8.8.8.8"]) expect(isPrivateHost(h), h).toBe(false);
  });
});

describe("keyPagePriority", () => {
  it("ranks the home page, then about/services/projects/contact pages, above the rest", () => {
    const p = (path: string) => keyPagePriority(new URL(path, "https://e.com"));
    expect(p("/")).toBeGreaterThan(p("/about-us"));
    expect(p("/about-us")).toBeGreaterThan(p("/blog/2019/a-post"));
    expect(p("/services")).toBeGreaterThan(p("/blog/2019/a-post"));
    expect(p("/our-work/harbour-house")).toBeGreaterThan(p("/blog/2019/a-post"));
    expect(p("/contact")).toBeGreaterThan(0);
  });
});

describe("socialProfile", () => {
  it("recognises profile links and their handles", () => {
    expect(socialProfile("https://www.instagram.com/kestrel.oak/")).toEqual({ platform: "instagram", handle: "kestrel.oak", url: "https://www.instagram.com/kestrel.oak/" });
    expect(socialProfile("https://facebook.com/kestrelandoak")).toMatchObject({ platform: "facebook", handle: "kestrelandoak" });
    expect(socialProfile("https://www.linkedin.com/company/kestrel-and-oak/")).toMatchObject({ platform: "linkedin", handle: "kestrel-and-oak" });
    expect(socialProfile("https://www.youtube.com/@kestrelandoak")).toMatchObject({ platform: "youtube", handle: "kestrelandoak" });
    expect(socialProfile("https://x.com/kestrelandoak")).toMatchObject({ platform: "x", handle: "kestrelandoak" });
    expect(socialProfile("https://twitter.com/kestrelandoak")).toMatchObject({ platform: "x", handle: "kestrelandoak" });
    expect(socialProfile("https://www.pinterest.co.uk/kestrelandoak/")).toMatchObject({ platform: "pinterest", handle: "kestrelandoak" });
    expect(socialProfile("https://www.houzz.co.uk/professionals/architects/kestrel-and-oak-pfvwgb-pf~123")).toMatchObject({ platform: "houzz" });
    expect(socialProfile("https://www.tiktok.com/@kestrelandoak")).toMatchObject({ platform: "tiktok", handle: "kestrelandoak" });
  });
  it("keeps the phone number of a WhatsApp link out of the profile", () => {
    const wa = socialProfile("https://wa.me/441174960000?text=hi");
    expect(wa).toMatchObject({ platform: "whatsapp" });
    expect(JSON.stringify(wa)).not.toMatch(/\d{6}/);
  });
  it("ignores share links, posts and non-profile pages", () => {
    expect(socialProfile("https://www.facebook.com/sharer/sharer.php?u=x")).toBeNull();
    expect(socialProfile("https://www.instagram.com/p/Cx12ab/")).toBeNull();
    expect(socialProfile("https://twitter.com/intent/tweet?text=x")).toBeNull();
    expect(socialProfile("https://www.instagram.com/")).toBeNull();
    expect(socialProfile("https://example.com/instagram")).toBeNull();
  });
});

describe("pageDocId", () => {
  it("is a Document id derived from the page key", () => {
    expect(pageDocId("https://www.example.com/about/")).toBe("document:web-www-example-com-about");
  });
});

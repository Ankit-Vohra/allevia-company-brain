import { describe, it, expect } from "vitest";
import { slugify, entityId, sha256, typeFromId } from "../../src/util/ids.js";

describe("ids", () => {
  it("slugifies", () => {
    expect(slugify("Search Console (GSC)")).toBe("search-console-gsc");
    expect(slugify("  Kitne naye users?  ")).toBe("kitne-naye-users");
    expect(slugify("नमस्ते दुनिया")).toBe("नमस्ते-दुनिया");
  });
  it("caps slugs at 80 characters without a trailing dash", () => {
    const s = slugify("word ".repeat(40));
    expect([...s].length).toBeLessThanOrEqual(80);
    expect(s.endsWith("-")).toBe(false);
    expect(s.startsWith("word-word")).toBe(true);
  });
  it("builds typed ids", () => {
    expect(entityId("Decision", "008 Discord brain")).toBe("decision:008-discord-brain");
    expect(entityId("Page", "www.aamdani.ai/jobs")).toBe("page:www.aamdani.ai/jobs");
  });
  it("normalises page urls", () => {
    expect(entityId("Page", "https://WWW.Aamdani.ai/jobs/#top")).toBe("page:www.aamdani.ai/jobs");
    expect(entityId("Page", "www.aamdani.ai/")).toBe("page:www.aamdani.ai");
  });
  it("kebab-cases multi-word type prefixes and round-trips the type", () => {
    expect(entityId("BrandRule", "No jargon")).toBe("brand-rule:no-jargon");
    expect(typeFromId("brand-rule:no-jargon")).toBe("BrandRule");
    expect(typeFromId("decision:x")).toBe("Decision");
    expect(typeFromId("nope:x")).toBeUndefined();
    expect(typeFromId("obs:followers:channel:instagram:2026-10-14")).toBe("Observation");
  });
  it("falls back to a hash when the key has no sluggable characters", () => {
    const id = entityId("Task", "???");
    expect(id).toMatch(/^task:[0-9a-f]{12}$/);
    expect(entityId("Task", "???")).toBe(id);
  });
  it("hashes", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

// redactGraph: the maintenance pass that rewrites a built tenant graph through redact() in place (upserts never delete, so
// text stored before the filter existed stays until this runs). It must leave digests, keys and ids alone, reach the
// old states kept in Version nodes, be idempotent, and end with a clean privacy scan.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { scanGraph } from "../../src/ingest/privacy.js";
import { redactGraph } from "../../src/ingest/scrub.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { sha256 } from "../../src/util/ids.js";
import { testGraph } from "../helpers/graph.js";

const EMAIL = "hello@example-studio.test";
const PHONE = "+91 98765 43210";
const SHA = sha256("a studio photo");

describe("redactGraph", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const rows = <T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);
  // everything a node says, in a stable order, minus vectors
  const snapshot = (id: string) => rows<{ kv: Array<[string, unknown]> }>(
    "MATCH (n {id:$id}) RETURN [k IN keys(n) WHERE NOT k IN ['embedding', 'textEmbedding'] | [k, n[k]]] AS kv", { id }).then((r) => Object.fromEntries(r[0]!.kv.sort(([a], [b]) => (a < b ? -1 : 1))));

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Document", id: "document:web-contact", name: "Web page: Contact", props: { kind: "webpage", hash: SHA, title: `Contact | ${EMAIL}` } });
    await upsertNode(g, { type: "Chunk", id: "chunk:contact-0", name: "Contact (part 1)", props: { text: `Email ${EMAIL} or call ${PHONE}.`, ord: 0, embedKey: "0123456789abcdef", url: "https://www.example-studio.test/contact" } });
    await upsertNode(g, { type: "Chunk", id: "chunk:about-0", name: "About (part 1)", props: { text: "We design homes in Raipur.", ord: 0 } });
    // a tracked prop changes, so the old state (with the address) is kept in a Version's JSON `props`
    await upsertNode(g, { type: "Page", id: "page:contact", name: `Contact | ${EMAIL}`, summary: `Call ${PHONE}`, props: { url: "https://www.example-studio.test/contact", metaDescription: `Email ${EMAIL}` } });
    await upsertNode(g, { type: "Page", id: "page:contact", name: "Contact", summary: "Call us", props: { url: "https://www.example-studio.test/contact", metaDescription: "Get in touch" } });
    // Studio assets: digests, a content-addressed key and a Version of them must come through byte for byte
    await upsertNode(g, { type: "Asset", id: "asset:photo", name: "Photo", props: { kind: "original", sha256: SHA, dhash: "c3a1f09d5e7b2468", storageKey: `${SHA}.jpg`, status: "new" } });
    await upsertNode(g, { type: "Asset", id: "asset:photo", name: "Photo", props: { kind: "original", sha256: SHA, dhash: "c3a1f09d5e7b2468", storageKey: `${SHA}.jpg`, status: "approved" } });
    await upsertNode(g, { type: "Task", id: "task:hosts", name: "Hosts", props: { issues: ["#1", "host 203.0.113.45"] } });
    await upsertNode(g, { type: "Person", id: "person:owner", name: "Owner" });
    await upsertEdge(g, { from: "person:owner", type: "OWNS", to: "task:hosts", props: { note: `call ${PHONE}` } });
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("the plant is dirty: the scan finds the address, the number, the host, and the old states in the Version", async () => {
    const hits = await scanGraph(g);
    expect(hits.map((h) => `${h.id.replace(/@.*/, "@…")}|${h.prop}|${h.kind}`).sort()).toEqual([
      `chunk:contact-0|text|email`, `chunk:contact-0|text|phone`, `document:web-contact|title|email`,
      `person:owner-[:OWNS]->task:hosts|note|phone`, `task:hosts|issues|ipv4`,
      `version:page:contact@…|props.metaDescription|email`, `version:page:contact@…|props.name|email`, `version:page:contact@…|props.summary|phone`,
    ].sort());
  });

  it("a dry run reports what it would change and changes nothing", async () => {
    const before = await snapshot("chunk:contact-0");
    const r = await redactGraph(g, { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, nodes: 4, relationships: 1, props: 5 });
    expect(r.byKind).toEqual({ email: 4, phone: 3, ipv4: 1 });
    expect(await snapshot("chunk:contact-0")).toEqual(before);
    expect(await scanGraph(g)).toHaveLength(8);
  });

  it("rewrites the strings in place: text, titles, list items, relationship props and the JSON of old Versions", async () => {
    const asset = await snapshot("asset:photo");
    const hash = await snapshot("document:web-contact");
    const chunk = await snapshot("chunk:contact-0");
    const r = await redactGraph(g);
    expect(r).toMatchObject({ dryRun: false, nodes: 4, relationships: 1, props: 5 });

    const c = await snapshot("chunk:contact-0");
    expect(c.text).toBe("Email [redacted:email] or call [redacted:phone].");
    expect({ ...c, text: undefined }).toEqual({ ...chunk, text: undefined }); // id, ord, url, embedKey, rev, updatedAt: untouched
    expect((await snapshot("document:web-contact")).title).toBe("Contact | [redacted:email]");
    expect((await snapshot("document:web-contact")).hash).toBe(hash.hash);
    expect((await snapshot("task:hosts")).issues).toEqual(["#1", "host [redacted:ipv4]"]);
    expect((await rows<{ n: string }>("MATCH (:Person)-[r:OWNS]->(:Task) RETURN r.note AS n"))[0]!.n).toBe("call [redacted:phone]");

    const [v] = await rows<{ id: string; props: string; changed: string[] }>("MATCH (:Page {id:'page:contact'})-[:HAD_VERSION]->(v:Version) RETURN v.id AS id, v.props AS props, v.changed AS changed");
    expect(JSON.parse(v!.props)).toMatchObject({ id: "page:contact", name: "Contact | [redacted:email]", summary: "Call [redacted:phone]", metaDescription: "Email [redacted:email]", url: "https://www.example-studio.test/contact" });
    expect(v!.id).toMatch(/^version:page:contact@/);
    expect(v!.changed).toEqual(expect.arrayContaining(["name"]));

    // digests, the content-addressed key and the Asset's Version: byte for byte
    expect(await snapshot("asset:photo")).toEqual(asset);
    const [av] = await rows<{ props: string }>("MATCH (:Asset {id:'asset:photo'})-[:HAD_VERSION]->(v:Version) RETURN v.props AS props");
    expect(JSON.parse(av!.props)).toMatchObject({ sha256: SHA, dhash: "c3a1f09d5e7b2468", storageKey: `${SHA}.jpg`, status: "new" });
    expect(av!.props).not.toContain("redacted");

    expect(await scanGraph(g)).toEqual([]);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const r = await redactGraph(g);
    expect(r).toMatchObject({ nodes: 0, relationships: 0, props: 0, byKind: {} });
  });

  it("pages through the whole graph and does the same at any page size", async () => {
    for (let i = 0; i < 30; i++) await upsertNode(g, { type: "Task", id: `task:bulk-${i}`, name: `Bulk ${i}`, summary: i % 3 === 0 ? `mail bob${i}@example.org` : "nothing here" });
    expect((await scanGraph(g)).length).toBe(10);
    const r = await redactGraph(g, { pageSize: 7 });
    expect(r).toMatchObject({ nodes: 10, relationships: 0, props: 10, byKind: { email: 10 } });
    expect(await scanGraph(g)).toEqual([]);
    expect(await redactGraph(g, { pageSize: 1 })).toMatchObject({ nodes: 0, relationships: 0, props: 0 });
  });

  it("never rewrites an id, even when the id itself would be flagged", async () => {
    await upsertNode(g, { type: "Task", id: "task:mail-me-at-a1b2c3@example.org", name: "Odd id", summary: "fine" });
    const r = await redactGraph(g);
    expect(r.nodes).toBe(0);
    expect(await rows("MATCH (n {id:'task:mail-me-at-a1b2c3@example.org'}) RETURN n.id AS id")).toHaveLength(1);
  });
});

// The privacy filter for chat-written nodes (src/ingest/clean.ts): the same detectors as ingest, applied to the words of a node, the
// text inside its JSON props and an action card's payload, while ids, digests, numbers and the keys an executor needs stay as they are.
// The values below are invented and patterned, as the hygiene test requires.
import { describe, expect, it } from "vitest";
import { cleanEdge, cleanJson, cleanNode, cleanPayload, cleanProps, cleanText, Removed } from "../../src/ingest/clean.js";
import { findSensitive } from "../../src/ingest/redact.js";

const KEY = "ghp_abcd1234efgh5678ijkl9012mnop3456qrst";
const PHONE = "+91 98765 43210";
const EMAIL = "priya.sharma@example.com";

describe("cleanText", () => {
  it("takes out a key, a phone number and an email address, and counts them by kind", () => {
    const removed = new Removed();
    const out = cleanText(`Use ${KEY} and call ${PHONE} or write to ${EMAIL}.`, removed);
    expect(out).toBe("Use [redacted:secret] and call [redacted:phone] or write to [redacted:email].");
    expect(removed.byKind).toEqual({ secret: 1, phone: 1, email: 1 });
    expect(removed.total).toBe(3);
    expect(findSensitive(out)).toEqual([]);
  });

  it("leaves ordinary words, dates, money, ids and citations alone", () => {
    const text = "We paused daily stories on 14 Oct 2026 to save Rs 4,500 a week [[decision:007-pause-daily-stories]] (turn:2026-10-17-ab12cd34).";
    const removed = new Removed();
    expect(cleanText(text, removed)).toBe(text);
    expect(removed.total).toBe(0);
  });

  it("is idempotent, and counts nothing the second time", () => {
    const once = cleanText(`call ${PHONE}`);
    const removed = new Removed();
    expect(cleanText(once, removed)).toBe(once);
    expect(removed.total).toBe(0);
  });
});

describe("Removed", () => {
  it("says what was taken out in an owner's words, never the values", () => {
    const r = new Removed();
    expect(r.words()).toBe("");
    expect(r.note()).toBe("");
    r.add({ phone: 1 });
    expect(r.words()).toBe("a phone number");
    r.add({ phone: 1, email: 1, secret: 2 });
    expect(r.words()).toBe("2 phone numbers, an email address and 2 keys or passwords");
    expect(r.note()).toMatch(/^Private details were taken out before saving \(2 phone numbers, an email address and 2 keys or passwords\)/);
    expect(r.note()).not.toContain("98765");
  });
});

describe("cleanJson", () => {
  it("keeps the key name in view, so a named password in a JSON pair goes, and the JSON stays valid", () => {
    const removed = new Removed();
    const out = cleanJson(JSON.stringify({ title: "Set up", body: `login with password: hunter2 at ${EMAIL}`, config: { password: "abcd1234ef" } }), removed);
    const o = JSON.parse(out) as { body: string; config: { password: string } };
    expect(o.body).toContain("[redacted:email]");
    expect(o.body).not.toContain("hunter2");
    expect(o.config.password).toBe("[redacted:secret]");
    expect(removed.total).toBeGreaterThanOrEqual(3);
  });

  it("cleans each string on its own, so an unfinished private key cannot cut across the JSON", () => {
    // an unfinished private key block runs to the end of the text; read as the raw JSON it would swallow the closing quote and brace
    const json = JSON.stringify({ note: "-----BEGIN PRIVATE KEY-----\nMIIabcd1234", after: "keep me", phone: PHONE });
    const out = cleanJson(json);
    const o = JSON.parse(out) as { note: string; after: string; phone: string };
    expect(o.after).toBe("keep me");
    expect(o.note).toBe("[redacted:secret]");
    expect(o.phone).toBe("[redacted:phone]");
  });

  it("returns the same text when there is nothing to take out", () => {
    const json = JSON.stringify({ a: 1, b: ["x", "y"] });
    expect(cleanJson(json)).toBe(json);
  });
});

describe("cleanProps and cleanNode", () => {
  it("cleans text props, arrays of text and JSON props, and leaves ids, digests, numbers and booleans", () => {
    const sha = "a".repeat(8) + "b".repeat(8) + "c".repeat(8) + "d".repeat(8) + "e".repeat(8) + "f".repeat(8) + "0123456789abcdef";
    const removed = new Removed();
    const out = cleanProps({
      text: `ring ${PHONE}`, tags: [`mail ${EMAIL}`, "fine"], events: JSON.stringify([{ type: "text", delta: `key ${KEY}` }]),
      id: "memory:t-1-1", src: "turn:2026-10-17-ab12cd34", sha256: sha, storageKey: `${sha}.jpg`, count: 3, ok: true, nothing: null,
    }, removed);
    expect(out.text).toBe("ring [redacted:phone]");
    expect(out.tags).toEqual(["mail [redacted:email]", "fine"]);
    expect(JSON.parse(out.events as string)).toEqual([{ type: "text", delta: "key [redacted:secret]" }]);
    expect(out).toMatchObject({ id: "memory:t-1-1", src: "turn:2026-10-17-ab12cd34", sha256: sha, storageKey: `${sha}.jpg`, count: 3, ok: true, nothing: null });
    expect(removed.byKind).toEqual({ phone: 1, email: 1, secret: 1 });
  });

  it("cleans a node's name and summary and keeps its id, type and embedding", () => {
    const embedding = Array.from({ length: 384 }, (_, i) => i / 384);
    const n = cleanNode({ type: "Memory", id: "memory:t-1-1", name: `Call ${PHONE}`, summary: `Mail ${EMAIL}`, props: { kind: "fact" }, src: "turn:t-1", embedding });
    expect(n).toMatchObject({ type: "Memory", id: "memory:t-1-1", name: "Call [redacted:phone]", summary: "Mail [redacted:email]", props: { kind: "fact" }, src: "turn:t-1" });
    expect(n.embedding).toBe(embedding);
  });

  it("cleans the text in an edge's props", () => {
    const e = cleanEdge({ from: "agent:a", type: "REVIEWED", to: "finding:f", props: { verdict: "ok", note: `ask ${EMAIL}` } });
    expect(e.props).toEqual({ verdict: "ok", note: "ask [redacted:email]" });
    const plain = { from: "agent:a", type: "PRODUCED", to: "x:y" } as const;
    expect(cleanEdge(plain)).toBe(plain);
  });
});

describe("cleanPayload", () => {
  it("cleans the words of a card and leaves the keys the executor needs: recipients, guests, tool arguments, the account", () => {
    const removed = new Removed();
    const payload = {
      title: "Quote for Priya", subject: "Your quote", to: [EMAIL], cc: ["accounts@example.com"], body: `Hello, call me on ${PHONE}. Token ${KEY}`,
      attendees: [EMAIL], args: { email: EMAIL }, target: `Email to ${EMAIL}`, publish: { account: { handle: "@cafe" } },
    };
    const out = cleanPayload(payload, removed);
    expect(out.body).toBe("Hello, call me on [redacted:phone]. Token [redacted:secret]");
    expect(out).toMatchObject({ to: [EMAIL], cc: ["accounts@example.com"], attendees: [EMAIL], args: { email: EMAIL }, target: `Email to ${EMAIL}`, publish: { account: { handle: "@cafe" } } });
    expect(Object.keys(out)).toEqual(Object.keys(payload));
    expect(removed.byKind).toEqual({ phone: 1, secret: 1 });
  });

  it("returns the payload itself when it is clean", () => {
    const payload = { title: "Add a meta description", body: "The /jobs page has none." };
    expect(cleanPayload(payload)).toBe(payload);
  });
});

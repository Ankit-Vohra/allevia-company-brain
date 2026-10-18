// Reading meeting recorders: Fireflies' transcript shape (the sample account answers it), Granola's loose MCP answers, the notes
// Memory Keeper reads, a forwarded transcript, and the business's meeting address.
import { describe, expect, it } from "vitest";
import { meetingAddress, meetingToken, meetingTokenOk } from "../../src/meetings/address.js";
import {
  fireflies, firefliesMeeting, granolaListing, granolaMeeting, inboundMeeting, linesFromSentences, notesOf, FIREFLIES_TOOLS,
} from "../../src/meetings/recorders.js";
import { SAMPLE_FIREFLIES_AT, SAMPLE_FIREFLIES_ID, sampleFirefliesSession, sampleFirefliesTranscript } from "../../src/demo/sample/fireflies.js";

describe("Fireflies", () => {
  it("reads a transcript: speakers, attendees with emails, its summary and action items", () => {
    const m = firefliesMeeting(sampleFirefliesTranscript())!;
    expect(m).toMatchObject({ recorder: "fireflies", externalId: SAMPLE_FIREFLIES_ID, title: "Kettle & Crumb follow-up call (sample)", startedAt: SAMPLE_FIREFLIES_AT, sample: true });
    expect(m.attendees.map((a) => a.email)).toEqual(["ritika@kettleandcrumb.example", "aman@kettleandcrumb.example", "wholesale@roaster-sample.example", "marketing@roaster-sample.example"]);
    expect(m.transcript.split("\n")[1]).toMatch(/^Ritika Menon: .*decaf/);
    expect(m.summary).toMatch(/^Sample call/);
    expect(m.actionItems).toContain("Send the revised quote");
  });
  it("accepts the answer wrapped in data, and refuses one with no id or no words", () => {
    expect(firefliesMeeting({ data: { transcript: sampleFirefliesTranscript() } })?.externalId).toBe(SAMPLE_FIREFLIES_ID);
    expect(firefliesMeeting({ title: "x" })).toBeNull();
    expect(firefliesMeeting({ id: "a", sentences: [] })).toBeNull();
  });
  it("lists and fetches through a session by the real tool names", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const s = sampleFirefliesSession();
    const spy = { execute: (t: string, a: Record<string, unknown>) => { calls.push([t, a]); return s.execute(t, a); } };
    const listed = await fireflies.list(spy, Date.UTC(2026, 9, 11), Date.UTC(2026, 9, 18));
    expect(listed).toEqual([{ externalId: SAMPLE_FIREFLIES_ID, title: "Kettle & Crumb follow-up call (sample)", startedAt: SAMPLE_FIREFLIES_AT }]);
    expect((await fireflies.fetch(spy, SAMPLE_FIREFLIES_ID))?.title).toMatch(/follow-up/);
    expect(calls.map((c) => c[0])).toEqual([FIREFLIES_TOOLS.list, FIREFLIES_TOOLS.get]);
    expect(calls[0]![1]).toEqual({ from_date: "2026-10-11T00:00:00Z", limit: 20 });
  });
  it("keeps a run of the same speaker as one line", () => {
    expect(linesFromSentences([{ speaker_name: "A", text: "One." }, { speaker_name: "A", text: "Two." }, { speaker_name: "B", text: "Three." }, { text: "" }]))
      .toBe("A: One. Two.\nB: Three.");
  });
});

describe("Granola", () => {
  it("lists from JSON or from text", () => {
    const id = "0b5c6d7e-1111-4222-8333-944455556666";
    expect(granolaListing({ meetings: [{ id, title: "Supplier call", start_time: "2026-10-15T10:00:00Z" }] }))
      .toEqual([{ externalId: id, title: "Supplier call", startedAt: Date.parse("2026-10-15T10:00:00Z") }]);
    expect(granolaListing({ content: [{ type: "text", text: `Your meetings:\n<meeting id="${id}" title="Supplier call"/>\n` }] })[0])
      .toMatchObject({ externalId: id });
    expect(granolaListing("nothing here")).toEqual([]);
  });
  it("reads a meeting from its details and transcript", () => {
    const id = "0b5c6d7e-1111-4222-8333-944455556666";
    const m = granolaMeeting(id, { meetings: [{ id, title: "Supplier call", attendees: [{ name: "Priya", email: "priya@supplier.example" }], notes: "Agreed a new price." }] },
      { content: [{ type: "text", text: "Priya: The price goes up in November.\nUs: Noted." }] })!;
    expect(m).toMatchObject({ recorder: "granola", externalId: id, title: "Supplier call", attendees: [{ name: "Priya", email: "priya@supplier.example" }], summary: "Agreed a new price." });
    expect(m.transcript).toContain("The price goes up");
    expect(granolaMeeting(id, null, null)).toBeNull();
  });
});

describe("what Memory Keeper reads", () => {
  it("says sample first, who was on the call, who recorded it, then the words", () => {
    const n = notesOf(firefliesMeeting(sampleFirefliesTranscript())!);
    expect(n.split("\n")[0]).toBe("Sample transcript (made up for the demo, nobody real)");
    expect(n).toContain("Kettle & Crumb follow-up call (sample), Saturday 17 October 2026");
    expect(n).toContain("On the call: Ritika Menon (ritika@kettleandcrumb.example)");
    expect(n).toContain("Recorded by Fireflies.");
    expect(n).toContain("Aman Shetty: Small thing");
  });
  it("a forwarded transcript is named by the sender's id, else by its text", () => {
    expect(inboundMeeting({ id: "zoom call/42", text: "x", fingerprint: "f" }).externalId).toBe("zoom-call-42");
    expect(inboundMeeting({ text: "x", fingerprint: "abc" })).toMatchObject({ recorder: "inbound", externalId: "abc", title: "Meeting notes" });
  });
});

describe("the meeting address", () => {
  const key = "k".repeat(40);
  it("is a secret per business, off without a key", () => {
    const t = meetingToken(key, "bluetokai")!;
    expect(t).toHaveLength(32);
    expect(meetingToken(key, "other")).not.toBe(t);
    expect(meetingTokenOk(key, "bluetokai", t)).toBe(true);
    expect(meetingTokenOk(key, "other", t)).toBe(false);
    expect(meetingTokenOk(key, "bluetokai", "x")).toBe(false);
    expect(meetingToken("short", "bluetokai")).toBeNull();
    expect(meetingAddress("https://app.example/", key, "bluetokai")).toBe(`https://app.example/hooks/meetings/bluetokai/${t}`);
  });
});

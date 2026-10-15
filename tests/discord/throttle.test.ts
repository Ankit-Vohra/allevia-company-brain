// The work-log message is edited at most once per interval, always ends on the newest text, and never runs two edits
// at once (Discord rate-limits message edits).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThrottledEditor } from "../../src/discord/worklog.js";

describe("ThrottledEditor", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  const recorder = (delayMs = 0) => {
    const edits: Array<{ at: number; text: string }> = [];
    let running = 0;
    let overlap = false;
    const edit = async (text: string) => {
      running++;
      if (running > 1) overlap = true;
      edits.push({ at: Date.now(), text });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      running--;
    };
    return { edits, edit, overlap: () => overlap };
  };

  it("sends the first text at once, then at most one edit per 1.5 s with the newest text", async () => {
    const r = recorder();
    const ed = new ThrottledEditor(r.edit, 1500);
    ed.update("t0");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.edits.map((e) => e.text)).toEqual(["t0"]);
    for (let i = 1; i <= 30; i++) { ed.update(`t${i}`); await vi.advanceTimersByTimeAsync(100); } // 30 events over 3 s
    await vi.advanceTimersByTimeAsync(2000);
    const at = r.edits.map((e) => e.at);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(1500);
    expect(r.edits.length).toBeLessThanOrEqual(4);
    expect(r.edits.at(-1)!.text).toBe("t30");
  });

  it("skips an edit when the text did not change", async () => {
    const r = recorder();
    const ed = new ThrottledEditor(r.edit, 1500);
    ed.update("same");
    await vi.advanceTimersByTimeAsync(0);
    ed.update("same");
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.edits).toHaveLength(1);
  });

  it("never overlaps edits, even when one is slower than the interval", async () => {
    const r = recorder(4000);
    const ed = new ThrottledEditor(r.edit, 1500);
    for (let i = 0; i < 20; i++) { ed.update(`t${i}`); await vi.advanceTimersByTimeAsync(500); }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.overlap()).toBe(false);
    expect(r.edits.at(-1)!.text).toBe("t19");
  });

  it("flush delivers the final text once, within the rate limit, and resolves after it is shown", async () => {
    const r = recorder();
    const ed = new ThrottledEditor(r.edit, 1500);
    ed.update("working");
    await vi.advanceTimersByTimeAsync(0);
    ed.update("almost");
    ed.update("done");
    const flushed = ed.flush();
    let resolved = false;
    void flushed.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false); // still inside the 1.5 s window
    await vi.advanceTimersByTimeAsync(600);
    await flushed;
    expect(r.edits.map((e) => e.text)).toEqual(["working", "done"]);
    expect(r.edits[1]!.at - r.edits[0]!.at).toBeGreaterThanOrEqual(1500);
    await ed.flush(); // nothing new: no edit
    expect(r.edits).toHaveLength(2);
  });

  it("keeps going after a failed edit and reports it", async () => {
    const errors: unknown[] = [];
    let n = 0;
    const ed = new ThrottledEditor(async () => { if (++n === 1) throw new Error("429"); }, 1500, undefined, (e) => errors.push(e));
    ed.update("a");
    await vi.advanceTimersByTimeAsync(0);
    ed.update("b");
    await vi.advanceTimersByTimeAsync(1500);
    expect(errors).toHaveLength(1);
    expect(n).toBe(2);
  });
});

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { interruptible } from "../../src/cli/_interrupt.js";

function fakeProcess() {
  const p = Object.assign(new EventEmitter(), { exits: [] as number[], exit: (code: number) => { p.exits.push(code); } });
  return p;
}

describe("interruptible (Ctrl-C during ask)", () => {
  it("the first Ctrl-C aborts the turn's signal, the second quits at once", () => {
    const proc = fakeProcess();
    const said: string[] = [];
    const stop = interruptible(proc, (m) => said.push(m));
    expect(stop.signal.aborted).toBe(false);
    proc.emit("SIGINT");
    expect(stop.signal.aborted).toBe(true);
    expect(said[0]).toMatch(/Stopping the agents/);
    expect(proc.exits).toEqual([]);
    proc.emit("SIGINT");
    expect(proc.exits).toEqual([130]);
  });

  it("dispose removes the handler", () => {
    const proc = fakeProcess();
    const stop = interruptible(proc, () => {});
    stop.dispose();
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });
});
